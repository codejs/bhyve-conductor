import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { readAudit, type AuditEvent } from '../audit/audit.ts';
import type { ZoneConfig } from '../conductor/config.ts';
import { readLegacyStateFile, type PendingSequence } from '../conductor/state.ts';
import { log } from '../log.ts';
import { filterValue } from './audit-log.ts';
import type { ConductorDb } from './database.ts';
import type { Prisma } from './generated/client.ts';
import { ALERT_KINDS, ALERT_STATES } from './model.ts';
import { ensureZoneRows, parseZoneKey, SqliteStore } from './store.ts';

/**
 * One-time import of what versions before the database kept in files: the state file (recent runs,
 * unfinished sequences, open alerts) and the JSONL audit trail. Without it, an upgrade would forget recent
 * watering (cooldowns and daily caps) and any sequence mid-soak.
 *
 * Runs only on a database that has never been used, in one transaction; afterwards both files are renamed
 * to `<file>.imported`. Imported rows have no service run. Watering is counted once: the runs come from the
 * state file's history, so the waves an unfinished sequence already delivered get no ledger rows of their own.
 */

export interface LegacyFiles {
  /** CONDUCTOR_STATE (default .conductor-state.json). */
  statePath: string;
  /** CONDUCTOR_AUDIT (default .conductor-audit.jsonl). */
  auditPath: string;
}

export interface LegacyImportResult {
  runs: number;
  sequences: number;
  alerts: number;
  auditEvents: number;
  /** Lines or entries that could not be imported (e.g. a line cut short by a crash). */
  skipped: number;
  /** The old trail's last event: if it isn't service.stopped, the old version did not shut down cleanly. */
  lastAuditEvent?: AuditEvent;
  /** Where the files went. */
  renamed: string[];
}

const MINUTE_MS = 60_000;
const minutesOf = (wave: readonly { runTime: number }[]): number => wave.reduce((sum, r) => sum + r.runTime, 0);

/** True for a database that has never recorded anything. */
const isUnused = async (db: ConductorDb): Promise<boolean> => {
  const { prisma } = db;
  const counts = await prisma.$transaction([prisma.serviceRun.count(), prisma.auditEvent.count(), prisma.zoneWatering.count(), prisma.wateringSequence.count()]);
  return counts.every((n) => n === 0);
};

/** The waves of an imported sequence: earlier ones delivered (time estimated from the plan), the next one due. */
const wavesOf = (seq: PendingSequence): Prisma.SequenceWaveCreateWithoutSequenceInput[] => {
  let estimate = seq.createdAt.getTime();
  return seq.waves.map((wave, waveIndex) => {
    const stations = { create: wave.map((r) => ({ station: r.station, runMinutes: r.runTime })) };
    let row: Prisma.SequenceWaveCreateWithoutSequenceInput;
    if (waveIndex < seq.nextWave) {
      row = { waveIndex, status: 'delivered', delivery: 'assumed', dueAt: new Date(estimate), sentAt: new Date(estimate), stations };
    } else if (waveIndex === seq.nextWave && seq.inFlight?.wave === waveIndex) {
      row = { waveIndex, status: 'sending', dueAt: seq.dueAt, sentAt: seq.inFlight.since, failedAttempts: seq.attempts, stations };
    } else if (waveIndex === seq.nextWave) {
      row = { waveIndex, dueAt: seq.dueAt, failedAttempts: seq.attempts, stations };
    } else {
      row = { waveIndex, stations };
    }
    estimate += (minutesOf(wave) + seq.soakMinutes) * MINUTE_MS;
    return row;
  });
};

const renameAway = async (path: string): Promise<string | undefined> => {
  if (!existsSync(path)) return undefined;
  let target = `${path}.imported`;
  if (existsSync(target)) target = `${path}.imported-${Date.now()}`;
  await rename(path, target);
  return target;
};

/**
 * Imports the files of an earlier version into an unused database. Returns undefined if there was nothing
 * to do (no files, or the database is already in use).
 */
export const importLegacyFiles = async (
  db: ConductorDb,
  files: LegacyFiles,
  zones: readonly ZoneConfig[],
  now: Date,
): Promise<LegacyImportResult | undefined> => {
  if (!existsSync(files.statePath) && !existsSync(files.auditPath)) return undefined;
  if (!(await isUnused(db))) {
    log.warn(`${files.statePath} / ${files.auditPath} are not imported: the database is already in use`);
    return undefined;
  }
  const state = await readLegacyStateFile(files.statePath);
  const audit = await readAudit(files.auditPath);
  let skipped = audit.skipped;
  const counts = { runs: 0, sequences: 0, alerts: 0, auditEvents: 0 };

  await new SqliteStore(db).syncZones(zones, now);
  await db.prisma.$transaction(
    async (tx) => {
      for (const run of state.history.runs) {
        try {
          parseZoneKey(run.zoneKey);
        } catch {
          skipped++;
          continue;
        }
        await ensureZoneRows(tx, [run.zoneKey], run.at);
        await tx.zoneWatering.create({ data: { zoneKey: run.zoneKey, startedAt: run.at, minutes: run.minutes } });
        counts.runs++;
      }

      const devices = new Set<string>();
      for (const seq of state.sequences) {
        // Only one sequence per device can be active (the old Sequencer resumed just the first one too).
        if (devices.has(seq.deviceId) || seq.nextWave >= seq.waves.length) {
          skipped++;
          continue;
        }
        devices.add(seq.deviceId);
        await ensureZoneRows(
          tx,
          seq.waves.flat().map((r) => `${seq.deviceId}:${r.station}`),
          seq.createdAt,
        );
        const why = zones
          .filter((c) => c.deviceId === seq.deviceId)
          .map((z) => ({ z, minutes: seq.waves.flat().reduce((sum, r) => (r.station === z.station ? sum + r.runTime : sum), 0) }))
          .filter(({ minutes }) => minutes > 0)
          .map(({ z, minutes }) => ({
            zoneKey: z.key,
            zoneName: z.name,
            thresholdPct: z.thresholdPct,
            targetPct: z.targetPct,
            requestedMinutes: minutes,
            detail: `imported from ${files.statePath}`,
          }));
        await tx.wateringSequence.create({
          data: {
            id: seq.id,
            deviceId: seq.deviceId,
            soakMinutes: seq.soakMinutes,
            createdAt: seq.createdAt,
            zones: { create: why },
            waves: { create: wavesOf(seq) },
          },
        });
        counts.sequences++;
      }

      for (const [alertKey, v] of Object.entries(state.alerts)) {
        const kind = alertKey.slice(0, Math.max(0, alertKey.indexOf(':')));
        const since = new Date(v.since);
        if (!(ALERT_KINDS as readonly string[]).includes(kind) || !(ALERT_STATES as readonly string[]).includes(v.state) || Number.isNaN(since.getTime())) {
          skipped++;
          continue;
        }
        await tx.openAlert.create({ data: { alertKey, kind, state: v.state, since } });
        counts.alerts++;
      }

      const events: Prisma.AuditEventCreateManyInput[] = [];
      for (const { ts, type, ...data } of audit.events) {
        const at = new Date(ts);
        if (Number.isNaN(at.getTime())) {
          skipped++;
          continue;
        }
        events.push({
          ts: at,
          type,
          data: data as Prisma.InputJsonValue,
          deviceId: filterValue(data.device),
          zoneKey: filterValue(data.zone),
          sequenceId: filterValue(data.sequence),
        });
      }
      if (events.length > 0) await tx.auditEvent.createMany({ data: events });
      counts.auditEvents = events.length;
    },
    // A long trail can take a while on a Raspberry Pi.
    { timeout: 120_000, maxWait: 30_000 },
  );

  const renamed = (await Promise.all([renameAway(files.statePath), renameAway(files.auditPath)])).filter((p): p is string => p !== undefined);
  const lastAuditEvent = audit.events.filter((e) => e.type !== 'simulation.note').at(-1);
  log.info(
    `Imported ${counts.runs} runs, ${counts.sequences} unfinished sequence(s), ${counts.alerts} alert(s) and ${counts.auditEvents} audit events ` +
      `from the files of the previous version${skipped ? ` (${skipped} skipped)` : ''}; renamed them to *.imported`,
  );
  return { ...counts, skipped, ...(lastAuditEvent ? { lastAuditEvent } : {}), renamed };
};
