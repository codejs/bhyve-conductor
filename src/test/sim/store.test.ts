import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import { queryAuditEvents, readAuditSource } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { importLegacyFiles } from '../../db/legacy-import.ts';
import { MIGRATIONS_FOLDER, readMigrations } from '../../db/migrate.ts';
import { beginSession } from '../../db/session.ts';
import { log } from '../../log.ts';
import { runScenario, type SimResult } from '../../sim/runner.ts';
import { scenarioById } from '../../sim/scenarios.ts';
import {
  SIMULATION_TABLES,
  hasSimulationTables,
  listSimulations,
  simulationEvents,
  simulationNotifications,
  simulationSequences,
  simulationWatering,
  storeSimulation,
} from '../../sim/store.ts';
import { zone } from '../utils/conductor.ts';

/**
 * Simulation results in the database: they come back exactly as the simulator produced them, storing a
 * scenario again replaces it, and they never leak into what runs the garden (the audit trail, the watering
 * ledger, crash detection, the import of an older version's files).
 */

const STORED_AT = new Date('2026-08-01T15:00:00.000Z');
/** Real time, after the simulated summer day. */
const NOW = new Date('2026-08-02T12:00:00.000Z');
const config: ConductorConfig = {
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones: [zone({ name: 'Front' }), zone({ station: 2, name: 'Back' })],
};

const results = new Map<string, SimResult>();
const sim = (id: string): SimResult => {
  const r = results.get(id);
  if (!r) throw new Error(`scenario ${id} did not run`);
  return r;
};

beforeAll(async () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  for (const id of ['normal-watering', 'crash-mid-soak', 'bhyve-long-outage']) {
    const scenario = scenarioById(id);
    if (!scenario) throw new Error(`no scenario ${id}`);
    results.set(id, await runScenario(scenario));
  }
  vi.restoreAllMocks();
}, 60_000);

let dir: string;
let db: ConductorDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-store-'));
  db = openDatabase(':memory:');
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const count = (table: string): number => (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Every row of every table but the simulation tables (and the migration history), in rowid order. */
const operational = (client: DatabaseSync): Record<string, unknown[]> => {
  const tables = (
    client.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((name) => !(SIMULATION_TABLES as readonly string[]).includes(name));
  return Object.fromEntries(tables.map((name) => [name, client.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
};

describe('storing a simulation result', () => {
  it.each(['normal-watering', 'crash-mid-soak', 'bhyve-long-outage'])('%s: gives back exactly what the simulator produced', async (id) => {
    const result = sim(id);
    const stored = await storeSimulation(db, result, STORED_AT);

    expect(stored).toEqual({
      id: expect.any(Number),
      scenario: id,
      title: result.scenario.title,
      storedAt: STORED_AT,
      startedAt: result.startedAt,
      hours: result.scenario.hours,
      timeZone: result.timeZone,
      events: result.events.length,
      notifications: result.notifications.length,
    });
    expect(await simulationEvents(db, stored.id)).toEqual(result.events);
    expect(await simulationNotifications(db, stored.id)).toEqual(result.notifications);
    expect(await simulationSequences(db, stored.id)).toEqual(result.stored.sequences);
    expect(await simulationWatering(db, stored.id)).toEqual(result.stored.ledger);
  });

  it('has something in every table for a scenario with watering, notifications and an outage', async () => {
    await storeSimulation(db, sim('bhyve-long-outage'), STORED_AT);
    for (const table of SIMULATION_TABLES) expect(count(table), table).toBeGreaterThan(0);
    // The scenario abandons one sequence and completes another.
    expect((await simulationSequences(db, 1)).map((s) => s.status).sort()).toEqual(['abandoned', 'completed']);
  });

  it('fills the filter columns from the payload, like audit_event', async () => {
    const { id } = await storeSimulation(db, sim('crash-mid-soak'), STORED_AT);
    const rows = await db.prisma.simulationEvent.findMany({ where: { simulationRunId: id }, orderBy: { id: 'asc' } });
    const events = sim('crash-mid-soak').events;

    expect(rows.map((r) => [r.deviceId, r.zoneKey, r.sequenceId])).toEqual(
      events.map((e) => [
        typeof e.device === 'string' ? e.device : null,
        typeof e.zone === 'string' ? e.zone : null,
        typeof e.sequence === 'string' ? e.sequence : null,
      ]),
    );
    expect(rows.some((r) => r.sequenceId !== null)).toBe(true);
  });

  it('filters by time and by (the beginning of) a sequence id in the query', async () => {
    const result = sim('bhyve-long-outage');
    const { id } = await storeSimulation(db, result, STORED_AT);
    const sequence = String(result.events.find((e) => e.type === 'sequence.started')?.sequence);
    const since = new Date(result.startedAt.getTime() + 60 * 60_000);
    const until = new Date(result.startedAt.getTime() + 3 * 60 * 60_000);

    expect(await simulationEvents(db, id, { sequence: sequence.slice(0, 8) })).toEqual(result.events.filter((e) => e.sequence === sequence));
    expect(await simulationEvents(db, id, { since, until })).toEqual(
      result.events.filter((e) => Date.parse(e.ts) >= since.getTime() && Date.parse(e.ts) <= until.getTime()),
    );
  });

  it('replaces the earlier result of the same scenario, children and all', async () => {
    const first = await storeSimulation(db, sim('crash-mid-soak'), new Date('2026-07-20T10:00:00.000Z'));
    const second = await storeSimulation(db, sim('crash-mid-soak'), STORED_AT);

    expect(second.id).not.toBe(first.id);
    expect((await listSimulations(db)).map((r) => [r.scenario, r.storedAt])).toEqual([['crash-mid-soak', STORED_AT]]);
    const r = sim('crash-mid-soak');
    expect(count('simulation_event')).toBe(r.events.length);
    expect(count('simulation_notification')).toBe(r.notifications.length);
    expect(count('simulation_sequence')).toBe(r.stored.sequences.length);
    expect(count('simulation_watering')).toBe(r.stored.ledger.length);
    expect(await simulationEvents(db, first.id)).toEqual([]);
  });

  it('holds one result per scenario: the database refuses a second', async () => {
    await storeSimulation(db, sim('crash-mid-soak'), STORED_AT);
    expect(() =>
      db.sqlite
        .prepare(`INSERT INTO simulation_run (scenario, title, stored_at, started_at, hours, time_zone) VALUES ('crash-mid-soak', 't', ?, ?, 1, 'UTC')`)
        .run(NOW.toISOString(), NOW.toISOString()),
    ).toThrow(/UNIQUE constraint failed: simulation_run.scenario/);
  });

  it('keeps the other scenarios, and lists them by scenario', async () => {
    await storeSimulation(db, sim('normal-watering'), STORED_AT);
    await storeSimulation(db, sim('bhyve-long-outage'), STORED_AT);
    await storeSimulation(db, sim('crash-mid-soak'), STORED_AT);
    await storeSimulation(db, sim('normal-watering'), NOW);

    expect((await listSimulations(db)).map((r) => [r.scenario, r.storedAt])).toEqual([
      ['bhyve-long-outage', STORED_AT],
      ['crash-mid-soak', STORED_AT],
      ['normal-watering', NOW],
    ]);
    expect((await listSimulations(db, { scenarios: ['crash-mid-soak', 'nope'] })).map((r) => r.scenario)).toEqual(['crash-mid-soak']);
    const outage = (await listSimulations(db, { scenarios: ['bhyve-long-outage'] }))[0];
    expect(await simulationEvents(db, outage?.id ?? -1)).toEqual(sim('bhyve-long-outage').events);
  });

  it('is all or nothing: a failure keeps the earlier result as it was', async () => {
    const good = sim('crash-mid-soak');
    const before = await storeSimulation(db, good, STORED_AT);
    const sequence = good.stored.sequences[0];
    if (!sequence) throw new Error('the scenario has no sequence');
    // The same sequence twice breaks simulation_sequence's primary key, after the delete and the inserts before it.
    const broken: SimResult = { ...good, stored: { ...good.stored, sequences: [sequence, sequence] } };

    await expect(storeSimulation(db, broken, NOW)).rejects.toThrow();
    expect(await listSimulations(db)).toEqual([before]);
    expect(await simulationEvents(db, before.id)).toEqual(good.events);
    expect(count('simulation_event')).toBe(good.events.length);
  });

  it('refuses an event without a readable time, storing nothing', async () => {
    const good = sim('normal-watering');
    const broken: SimResult = { ...good, events: [...good.events, { ts: 'yesterday', type: 'simulation.note', note: 'x' }] };

    await expect(storeSimulation(db, broken, NOW)).rejects.toThrow('event simulation.note: "yesterday" is not a time');
    expect(await listSimulations(db)).toEqual([]);
  });
});

describe('stored simulations stay out of what runs the garden', () => {
  /** A conductor that ran in real time and crashed in the middle of a watering. */
  const crashedService = async (): Promise<void> => {
    const session = await beginSession(db, { config, mode: 'continuous', now: () => NOW });
    session.audit.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });
    session.audit.record('wave.sent', { sequence: 'real-seq', device: 'dev1', cycle: 1, of: 3 });
    await session.audit.flush();
  };

  it('leaves every other table as it was', async () => {
    await crashedService();
    const before = operational(db.sqlite);

    for (const r of results.values()) await storeSimulation(db, r, STORED_AT);

    expect(operational(db.sqlite)).toEqual(before);
  });

  it('are not in the audit trail, the watering history or the pending sequences', async () => {
    for (const r of results.values()) await storeSimulation(db, r, STORED_AT);

    expect(await queryAuditEvents(db)).toEqual([]);
    const session = await beginSession(db, { config, mode: 'continuous', now: () => NOW });
    expect(session.state.history).toEqual([]);
    expect(session.state.sequences).toEqual([]);
    expect(session.unclean).toBeUndefined();
  });

  it("don't hide or fake a crash: the next start reports the real run's last event", async () => {
    await crashedService();
    for (const r of results.values()) await storeSimulation(db, r, STORED_AT); // their last event is service.stopped

    const session = await beginSession(db, { config, mode: 'continuous', now: () => new Date(NOW.getTime() + 60_000) });
    expect(session.unclean).toEqual({ lastEvent: 'wave.sent', lastEventAt: NOW.toISOString() });
  });

  it("don't count as use: an older version's files are still imported into a database that only holds simulations", async () => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    for (const r of results.values()) await storeSimulation(db, r, STORED_AT);
    const statePath = join(dir, 'state.json');
    const auditPath = join(dir, 'audit.jsonl');
    await writeFile(statePath, JSON.stringify({ runs: [{ zoneKey: 'dev1:1', at: NOW.toISOString(), minutes: 8 }], sequences: [], alerts: {} }));
    await writeFile(auditPath, `${JSON.stringify({ ts: NOW.toISOString(), type: 'service.stopped', reason: 'upgrade' })}\n`);

    const imported = await importLegacyFiles(db, { statePath, auditPath }, config.zones, NOW);

    expect(imported).toMatchObject({ runs: 1, auditEvents: 1 });
    expect((await listSimulations(db)).length).toBe(results.size);
  });

  it('are not read by the audit source of npm run audit', async () => {
    const path = join(dir, 'conductor.db');
    const file = openDatabase(path);
    for (const r of results.values()) await storeSimulation(file, r, STORED_AT);
    await file.close();

    expect(await readAuditSource(path, { since: new Date(0) })).toEqual({ events: [], skipped: 0 });
  });
});

describe('a database from before stored simulations', () => {
  let initOnly: string;
  let path: string;

  beforeAll(async () => {
    initOnly = await mkdtemp(join(tmpdir(), 'sim-store-init-'));
    const first = readMigrations()[0];
    if (!first) throw new Error('no migrations');
    await mkdir(join(initOnly, first.name));
    await cp(join(MIGRATIONS_FOLDER, first.name), join(initOnly, first.name), { recursive: true });
  });

  afterAll(async () => {
    await rm(initOnly, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    path = join(dir, 'conductor.db');
    const old = openDatabase(path, { migrationsFolder: initOnly });
    const session = await beginSession(old, { config, mode: 'continuous', now: () => NOW });
    session.audit.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });
    await session.end('test');
    await old.close();
  });

  it('has no simulation tables, which read-only readers can tell', async () => {
    const old = openDatabase(path, { readOnly: true });
    try {
      expect(hasSimulationTables(old)).toBe(false);
    } finally {
      await old.close();
    }
    expect(hasSimulationTables(db)).toBe(true);
  });

  it('gets them when it is opened for writing, keeping its data (and a copy from before)', async () => {
    const client = new DatabaseSync(path);
    const before = operational(client);
    client.close();

    const upgraded = openDatabase(path);
    try {
      expect(hasSimulationTables(upgraded)).toBe(true);
      const stored = await storeSimulation(upgraded, sim('crash-mid-soak'), STORED_AT);
      expect(await simulationEvents(upgraded, stored.id)).toEqual(sim('crash-mid-soak').events);
      const after = operational(upgraded.sqlite);
      const { _prisma_migrations: history, ...rest } = after;
      const { _prisma_migrations: oldHistory, ...oldRest } = before;
      expect(rest).toEqual(oldRest);
      expect(history?.length).toBe((oldHistory?.length ?? 0) + readMigrations().length - 1);
    } finally {
      await upgraded.close();
    }
    expect(existsSync(`${path}.before-${readMigrations()[1]?.name}`)).toBe(true);
  });
});
