import type { AuditEvent, AuditType } from '../audit/audit.ts';
import type { Severity } from '../conductor/config.ts';
import { filterValue } from '../db/audit-log.ts';
import type { ConductorDb } from '../db/database.ts';
import type { Prisma } from '../db/generated/client.ts';
import { SEQUENCE_STATUSES, assertOneOf, type SequenceResult } from '../db/model.ts';
import type { Notification } from '../notify/notifier.ts';
import type { SimResult } from './runner.ts';

/**
 * Simulation results in the conductor's database (`npm run simulate -- --store`), for review with
 * `npm run audit -- --for-simulation`.
 *
 * They live in their own tables (simulation_run and its children), never in audit_event, zone_watering or
 * watering_sequence: simulated events carry virtual times and made-up devices, and nothing that runs the
 * garden — crash detection, the watering ledger, the daily limits, the default `npm run audit` — may see
 * them. One stored result per scenario: storing a scenario again replaces its previous result.
 */

export const SIMULATION_TABLES = ['simulation_run', 'simulation_event', 'simulation_notification', 'simulation_sequence', 'simulation_watering'] as const;

/** False for a database that predates stored simulations (opened read-only before its upgrade). */
export const hasSimulationTables = (db: ConductorDb): boolean => {
  const rows = db.sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${SIMULATION_TABLES.map(() => '?').join(', ')})`)
    .all(...SIMULATION_TABLES) as { name: string }[];
  return rows.length === SIMULATION_TABLES.length;
};

export interface StoredSimulation {
  id: number;
  scenario: string;
  title: string;
  /** When it was stored (real time). */
  storedAt: Date;
  /** When the simulated day started (virtual time). */
  startedAt: Date;
  hours: number;
  timeZone: string;
  events: number;
  notifications: number;
}

/** What a stored simulation was, plus how many events and notifications it holds. */
const summaryOf = (row: {
  id: number;
  scenario: string;
  title: string;
  storedAt: Date;
  startedAt: Date;
  hours: number;
  timeZone: string;
  _count: { events: number; notifications: number };
}): StoredSimulation => ({
  id: row.id,
  scenario: row.scenario,
  title: row.title,
  storedAt: row.storedAt,
  startedAt: row.startedAt,
  hours: row.hours,
  timeZone: row.timeZone,
  events: row._count.events,
  notifications: row._count.notifications,
});

const dateOf = (iso: string, what: string): Date => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`${what}: "${iso}" is not a time`);
  return d;
};

/**
 * Stores a simulation result, replacing any stored result of the same scenario, in one transaction: a
 * failure leaves the previous result as it was.
 */
export const storeSimulation = async (db: ConductorDb, result: SimResult, storedAt: Date): Promise<StoredSimulation> => {
  const { scenario } = result;
  const events: Prisma.SimulationEventCreateManyRunInput[] = result.events.map((e) => {
    const { ts, type, ...data } = e;
    return {
      ts: dateOf(ts, `event ${type}`),
      type,
      data: data as Prisma.InputJsonValue,
      deviceId: filterValue(data.device),
      zoneKey: filterValue(data.zone),
      sequenceId: filterValue(data.sequence),
    };
  });
  const notifications: Prisma.SimulationNotificationCreateManyRunInput[] = result.notifications.map((n) => ({
    severity: n.severity,
    type: n.type,
    text: n.text,
    ts: dateOf(n.ts, `notification ${n.type}`),
    sentAt: dateOf(n.sentAt, `notification ${n.type}`),
  }));
  const sequences: Prisma.SimulationSequenceCreateManyRunInput[] = result.stored.sequences.map(({ id, ...s }) => ({ sequenceId: id, ...s }));
  const watering: Prisma.SimulationWateringCreateManyRunInput[] = result.stored.ledger.map((w) => ({ ...w }));

  return db.prisma.$transaction(async (tx) => {
    await tx.simulationRun.deleteMany({ where: { scenario: scenario.id } });
    const row = await tx.simulationRun.create({
      data: {
        scenario: scenario.id,
        title: scenario.title,
        storedAt,
        startedAt: result.startedAt,
        hours: scenario.hours,
        timeZone: result.timeZone,
        events: { createMany: { data: events } },
        notifications: { createMany: { data: notifications } },
        sequences: { createMany: { data: sequences } },
        watering: { createMany: { data: watering } },
      },
      include: { _count: { select: { events: true, notifications: true } } },
    });
    return summaryOf(row);
  });
};

/** The stored simulations (optionally only some scenarios), by scenario id. */
export const listSimulations = async (db: ConductorDb, q: { scenarios?: readonly string[] } = {}): Promise<StoredSimulation[]> =>
  (
    await db.prisma.simulationRun.findMany({
      ...(q.scenarios ? { where: { scenario: { in: [...q.scenarios] } } } : {}),
      orderBy: [{ scenario: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { events: true, notifications: true } } },
    })
  ).map(summaryOf);

/** A stored simulation's audit trail, in the order it was recorded ({ ts, type, ...data }, as audit_event gives). */
export const simulationEvents = async (
  db: ConductorDb,
  runId: number,
  q: { since?: Date; until?: Date; sequence?: string } = {},
): Promise<AuditEvent[]> => {
  const rows = await db.prisma.simulationEvent.findMany({
    where: {
      simulationRunId: runId,
      ...(q.since || q.until ? { ts: { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lte: q.until } : {}) } } : {}),
      ...(q.sequence ? { sequenceId: { startsWith: q.sequence } } : {}),
    },
    orderBy: { id: 'asc' },
    select: { ts: true, type: true, data: true },
  });
  return rows.map((row) => ({
    ts: row.ts.toISOString(),
    type: row.type as AuditType,
    ...(row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {}),
  }));
};

/** The Telegram messages a stored simulation would have sent, in order. */
export const simulationNotifications = async (db: ConductorDb, runId: number): Promise<Notification[]> =>
  (await db.prisma.simulationNotification.findMany({ where: { simulationRunId: runId }, orderBy: { id: 'asc' } })).map((n) => ({
    severity: n.severity as Severity,
    type: n.type as AuditType,
    text: n.text,
    ts: n.ts.toISOString(),
    sentAt: n.sentAt.toISOString(),
  }));

/** What each stored simulated watering sequence planned and delivered. */
export const simulationSequences = async (db: ConductorDb, runId: number): Promise<SequenceResult[]> =>
  (await db.prisma.simulationSequence.findMany({ where: { simulationRunId: runId }, orderBy: [{ createdAt: 'asc' }, { sequenceId: 'asc' }] })).map(
    ({ simulationRunId: _run, sequenceId, status, ...s }) => ({ id: sequenceId, status: assertOneOf(status, SEQUENCE_STATUSES, 'a simulated sequence status'), ...s }),
  );

/** A stored simulation's watering ledger, in order. */
export const simulationWatering = async (
  db: ConductorDb,
  runId: number,
): Promise<{ zoneKey: string; startedAt: Date; minutes: number; sequenceId: string | null }[]> =>
  db.prisma.simulationWatering.findMany({
    where: { simulationRunId: runId },
    orderBy: { id: 'asc' },
    select: { zoneKey: true, startedAt: true, minutes: true, sequenceId: true },
  });
