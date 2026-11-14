import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { count } from 'drizzle-orm';
import { readAudit, type AuditEvent } from '../audit/audit.ts';
import type { ZoneConfig } from '../conductor/config.ts';
import { readLegacyStateFile, type PendingSequence } from '../conductor/state.ts';
import { log } from '../log.ts';
import type { ConductorDb } from './database.ts';
import {
  ALERT_KINDS,
  ALERT_STATES,
  auditEvent,
  openAlert,
  sequenceWave,
  sequenceZone,
  serviceRun,
  wateringSequence,
  waveStation,
  zoneWatering,
  type AlertConditionState,
} from './schema.ts';
import { ensureZoneRows, parseZoneKey, SqliteStore, type Tx } from './store.ts';

/**
 * One-time import of what earlier versions kept in files: the state file (recent runs, unfinished
 * sequences, open alerts) and the JSONL audit trail. Without it, an upgrade would forget recent watering
 * (cooldowns and daily caps) and any sequence mid-soak.
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
const isUnused = (db: ConductorDb): boolean =>
  [serviceRun, auditEvent, zoneWatering, wateringSequence].every((t) => (db.select({ n: count() }).from(t).get()?.n ?? 0) === 0);

const importSequence = (tx: Tx, seq: PendingSequence, zones: readonly ZoneConfig[], source: string): void => {
  tx.insert(wateringSequence).values({ id: seq.id, deviceId: seq.deviceId, soakMinutes: seq.soakMinutes, createdAt: seq.createdAt }).run();
  for (const z of zones.filter((c) => c.deviceId === seq.deviceId)) {
    const minutes = seq.waves.flat().reduce((sum, r) => (r.station === z.station ? sum + r.runTime : sum), 0);
    if (minutes <= 0) continue;
    tx.insert(sequenceZone)
      .values({
        sequenceId: seq.id,
        zoneKey: z.key,
        zoneName: z.name,
        thresholdPct: z.thresholdPct,
        targetPct: z.targetPct,
        requestedMinutes: minutes,
        detail: `imported from ${source}`,
      })
      .run();
  }
  // The old file doesn't say when earlier waves were sent: estimate it from the plan (start + runs + soaks).
  let estimate = seq.createdAt.getTime();
  seq.waves.forEach((wave, waveIndex) => {
    const base = { sequenceId: seq.id, waveIndex };
    if (waveIndex < seq.nextWave) {
      tx.insert(sequenceWave)
        .values({ ...base, status: 'delivered', delivery: 'assumed', dueAt: new Date(estimate), sentAt: new Date(estimate) })
        .run();
    } else if (waveIndex === seq.nextWave && seq.inFlight?.wave === waveIndex) {
      tx.insert(sequenceWave).values({ ...base, status: 'sending', dueAt: seq.dueAt, sentAt: seq.inFlight.since, failedAttempts: seq.attempts }).run();
    } else if (waveIndex === seq.nextWave) {
      tx.insert(sequenceWave).values({ ...base, dueAt: seq.dueAt, failedAttempts: seq.attempts }).run();
    } else {
      tx.insert(sequenceWave).values(base).run();
    }
    estimate += (minutesOf(wave) + seq.soakMinutes) * MINUTE_MS;
    if (wave.length > 0) {
      tx.insert(waveStation).values(wave.map((r) => ({ ...base, station: r.station, runMinutes: r.runTime }))).run();
    }
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
  if (!isUnused(db)) {
    log.warn(`${files.statePath} / ${files.auditPath} are not imported: the database is already in use`);
    return undefined;
  }
  const state = await readLegacyStateFile(files.statePath);
  const audit = await readAudit(files.auditPath);
  let skipped = audit.skipped;
  const counts = { runs: 0, sequences: 0, alerts: 0, auditEvents: 0 };

  new SqliteStore(db).syncZones(zones, now);
  db.transaction((tx) => {
    for (const run of state.history.runs) {
      try {
        parseZoneKey(run.zoneKey);
      } catch {
        skipped++;
        continue;
      }
      ensureZoneRows(tx, [run.zoneKey], run.at);
      tx.insert(zoneWatering).values({ zoneKey: run.zoneKey, startedAt: run.at, minutes: run.minutes }).run();
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
      importSequence(tx, seq, zones, files.statePath);
      counts.sequences++;
    }

    for (const [alertKey, v] of Object.entries(state.alerts)) {
      const kind = alertKey.slice(0, alertKey.indexOf(':'));
      const since = new Date(v.since);
      if (!(ALERT_KINDS as readonly string[]).includes(kind) || !(ALERT_STATES as readonly string[]).includes(v.state) || Number.isNaN(since.getTime())) {
        skipped++;
        continue;
      }
      tx.insert(openAlert).values({ alertKey, state: v.state as AlertConditionState, since }).run();
      counts.alerts++;
    }

    for (const { ts, type, ...data } of audit.events) {
      const at = new Date(ts);
      if (Number.isNaN(at.getTime())) {
        skipped++;
        continue;
      }
      tx.insert(auditEvent).values({ ts: at, type, data }).run();
      counts.auditEvents++;
    }
  });

  const renamed = (await Promise.all([renameAway(files.statePath), renameAway(files.auditPath)])).filter((p): p is string => p !== undefined);
  const lastAuditEvent = audit.events.filter((e) => e.type !== 'simulation.note').at(-1);
  log.info(
    `Imported ${counts.runs} runs, ${counts.sequences} unfinished sequence(s), ${counts.alerts} alert(s) and ${counts.auditEvents} audit events ` +
      `from the files of the previous version${skipped ? ` (${skipped} skipped)` : ''}; renamed them to *.imported`,
  );
  return { ...counts, skipped, ...(lastAuditEvent ? { lastAuditEvent } : {}), renamed };
};
