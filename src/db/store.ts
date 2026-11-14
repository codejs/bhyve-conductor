import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { StationRun } from '../bhyve/types.ts';
import type { AlertState } from '../conductor/alerts.ts';
import type { ZoneConfig } from '../conductor/config.ts';
import type { WateringRun } from '../conductor/history.ts';
import type { PendingSequence } from '../conductor/state.ts';
import type { ConductorStore, SavedZoneSpell, SequenceZone, StoredState, WaveDelivery, ZoneSpell } from '../conductor/store.ts';
import { log } from '../log.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { ConductorDb } from './database.ts';
import {
  openAlert,
  pendingSequence,
  sensorReading,
  sequenceWave,
  sequenceZone,
  wateringSequence,
  waveStation,
  zone,
  zoneState,
  zoneWatering,
  type AlertConditionState,
} from './schema.ts';

/**
 * The conductor's state in SQLite: the ConductorStore steps (each one transaction), and loading what a
 * previous run left behind. See docs/sqlite-storage.md §5 for which step writes what.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type Tx = Parameters<Parameters<ConductorDb['transaction']>[0]>[0];

/** "<deviceId>:<station>" → its parts (device ids may contain ':'; the station is after the last one). */
export const parseZoneKey = (key: string): { deviceId: string; station: number } => {
  const sep = key.lastIndexOf(':');
  const station = Number(key.slice(sep + 1));
  if (sep <= 0 || !Number.isInteger(station) || station < 1) throw new Error(`not a zone key: "${key}"`);
  return { deviceId: key.slice(0, sep), station };
};

/** Zone rows for keys not registered yet (e.g. a sequence resumed after its zone left the config). */
export const ensureZoneRows = (tx: Tx, keys: Iterable<string>, at: Date): void => {
  for (const key of new Set(keys)) {
    const { deviceId, station } = parseZoneKey(key);
    tx.insert(zone).values({ zoneKey: key, deviceId, station, name: `zone ${station}`, firstSeenAt: at, lastSeenAt: at }).onConflictDoNothing().run();
  }
};

/** Throws unless a statement changed exactly what it should have: a step that matched nothing is a bug. */
const expectChanged = (result: { changes: number | bigint }, what: string): void => {
  if (Number(result.changes) === 0) throw new Error(`${what}: no matching row`);
};

export class SqliteStore implements ConductorStore {
  readonly #db: ConductorDb;
  readonly #serviceRunId: number | undefined;

  constructor(db: ConductorDb, options: { serviceRunId?: number } = {}) {
    this.#db = db;
    this.#serviceRunId = options.serviceRunId;
  }

  /** Registers the configured zones (upserts names; history outlives zones removed from the config). */
  syncZones(zones: readonly ZoneConfig[], at: Date): void {
    this.#db.transaction((tx) => {
      for (const z of zones) {
        tx.insert(zone)
          .values({ zoneKey: z.key, deviceId: z.deviceId, station: z.station, name: z.name, firstSeenAt: at, lastSeenAt: at })
          .onConflictDoUpdate({ target: zone.zoneKey, set: { name: z.name, lastSeenAt: at } })
          .run();
      }
    });
  }

  // ---------- loading ----------

  /**
   * What a previous run left: ledger runs from the last `historyWindowMs` (at least 24 h), unfinished
   * sequences, open alerts and zone spells. A sequence whose waves were all delivered but that was never
   * closed (a crash between the two writes) is completed here, so it can't block its device; with
   * `repair: false` (dry runs write nothing) it is only left out.
   */
  loadState(now: Date, historyWindowMs: number, options: { repair?: boolean } = {}): StoredState {
    const since = new Date(now.getTime() - Math.max(historyWindowMs, DAY_MS));
    const history: WateringRun[] = this.#db
      .select({ zoneKey: zoneWatering.zoneKey, at: zoneWatering.startedAt, minutes: zoneWatering.minutes })
      .from(zoneWatering)
      .where(gte(zoneWatering.startedAt, since))
      .orderBy(asc(zoneWatering.startedAt), asc(zoneWatering.id))
      .all();

    const sequences: PendingSequence[] = [];
    for (const row of this.#db.select().from(pendingSequence).orderBy(asc(pendingSequence.createdAt)).all()) {
      if (row.nextWave >= row.waveCount) {
        if (options.repair !== false) {
          log.warn(`Watering sequence ${row.id} was fully delivered but never closed; closing it now`);
          this.#complete(row.id, now);
        }
        continue;
      }
      const stations = this.#db
        .select()
        .from(waveStation)
        .where(eq(waveStation.sequenceId, row.id))
        .orderBy(asc(waveStation.waveIndex), asc(waveStation.station))
        .all();
      const waves: StationRun[][] = Array.from({ length: row.waveCount }, () => []);
      for (const s of stations) waves[s.waveIndex]?.push({ station: s.station, runTime: s.runMinutes });
      sequences.push({
        id: row.id,
        deviceId: row.deviceId,
        waves,
        soakMinutes: row.soakMinutes,
        ...(row.zoneNames.length > 0 ? { zoneNames: row.zoneNames } : {}),
        createdAt: row.createdAt,
        nextWave: row.nextWave,
        // Every due wave has a due time; if one is missing, the creation time makes resume() judge it (too) late.
        dueAt: row.dueAt ?? row.createdAt,
        attempts: row.attempts,
        ...(row.inFlightWave !== null && row.inFlightSince ? { inFlight: { wave: row.inFlightWave, since: row.inFlightSince } } : {}),
      });
    }

    const alerts: AlertState = {};
    for (const a of this.#db.select().from(openAlert).orderBy(asc(openAlert.alertKey)).all()) {
      alerts[a.alertKey] = { state: a.state, since: a.since.toISOString() };
    }

    const zoneSpells: SavedZoneSpell[] = this.#db
      .select()
      .from(zoneState)
      .orderBy(asc(zoneState.zoneKey))
      .all()
      .map((z) => ({
        zoneKey: z.zoneKey,
        ...(z.drySince ? { drySince: z.drySince } : {}),
        ...(z.noDataSince ? { noDataSince: z.noDataSince } : {}),
        evaluatedAt: z.evaluatedAt,
      }));

    return { history, sequences, alerts, zoneSpells };
  }

  // ---------- the Sequencer's steps ----------

  sequenceStarted(seq: PendingSequence, zones: readonly SequenceZone[]): void {
    this.#db.transaction((tx) => {
      const stationKeys = seq.waves.flat().map((r) => `${seq.deviceId}:${r.station}`);
      ensureZoneRows(tx, [...zones.map((z) => z.zoneKey), ...stationKeys], seq.createdAt);
      tx.insert(wateringSequence)
        .values({
          id: seq.id,
          serviceRunId: this.#serviceRunId ?? null,
          deviceId: seq.deviceId,
          soakMinutes: seq.soakMinutes,
          createdAt: seq.createdAt,
        })
        .run();
      for (const z of zones) {
        tx.insert(sequenceZone)
          .values({
            sequenceId: seq.id,
            zoneKey: z.zoneKey,
            zoneName: z.zoneName,
            moisturePct: z.moisturePct ?? null,
            readingAt: z.readingAt ?? null,
            thresholdPct: z.thresholdPct,
            targetPct: z.targetPct,
            requestedMinutes: z.requestedMinutes,
            allowanceMinutes: z.allowanceMinutes ?? null,
            budgetInches: z.budget?.inches ?? null,
            budget: z.budget ?? null,
            detail: z.detail,
          })
          .run();
      }
      seq.waves.forEach((wave, waveIndex) => {
        tx.insert(sequenceWave)
          .values({ sequenceId: seq.id, waveIndex, dueAt: waveIndex === seq.nextWave ? seq.dueAt : null })
          .run();
        if (wave.length > 0) {
          tx.insert(waveStation)
            .values(wave.map((r) => ({ sequenceId: seq.id, waveIndex, station: r.station, runMinutes: r.runTime })))
            .run();
        }
      });
    });
  }

  #wave(seq: PendingSequence, index: number) {
    return and(eq(sequenceWave.sequenceId, seq.id), eq(sequenceWave.waveIndex, index));
  }

  waveSending(seq: PendingSequence, wave: number, at: Date): void {
    const result = this.#db
      .update(sequenceWave)
      .set({ status: 'sending', sentAt: at })
      .where(and(this.#wave(seq, wave), eq(sequenceWave.status, 'pending')))
      .run();
    expectChanged(result, `marking ${seq.id} cycle ${wave + 1} as sending`);
  }

  waveFailed(seq: PendingSequence, wave: number): void {
    const result = this.#db
      .update(sequenceWave)
      .set({ status: 'pending', sentAt: null, failedAttempts: sql`${sequenceWave.failedAttempts} + 1` })
      .where(and(this.#wave(seq, wave), inArray(sequenceWave.status, ['pending', 'sending'])))
      .run();
    expectChanged(result, `recording a failed attempt at ${seq.id} cycle ${wave + 1}`);
  }

  waveDelivered(seq: PendingSequence, wave: number, delivery: WaveDelivery, sentAt: Date, nextDueAt: Date | undefined): void {
    this.#db.transaction((tx) => {
      // Also from 'pending': if marking it 'sending' failed to save, the delivery must still be recorded.
      const updated = tx
        .update(sequenceWave)
        .set({ status: 'delivered', delivery, sentAt })
        .where(and(this.#wave(seq, wave), inArray(sequenceWave.status, ['pending', 'sending'])))
        .run();
      expectChanged(updated, `recording ${seq.id} cycle ${wave + 1} as delivered`);
      const stations = tx
        .select()
        .from(waveStation)
        .where(and(eq(waveStation.sequenceId, seq.id), eq(waveStation.waveIndex, wave)))
        .all();
      const keys = stations.map((s) => `${seq.deviceId}:${s.station}`);
      ensureZoneRows(tx, keys, sentAt);
      if (stations.length > 0) {
        tx.insert(zoneWatering)
          .values(stations.map((s) => ({ zoneKey: `${seq.deviceId}:${s.station}`, startedAt: sentAt, minutes: s.runMinutes, sequenceId: seq.id, waveIndex: wave })))
          .run();
      }
      if (nextDueAt) {
        const next = tx.update(sequenceWave).set({ dueAt: nextDueAt }).where(this.#wave(seq, wave + 1)).run();
        expectChanged(next, `scheduling ${seq.id} cycle ${wave + 2}`);
      }
    });
  }

  sequenceCompleted(seq: PendingSequence, at: Date): void {
    this.#complete(seq.id, at);
  }

  #complete(id: string, at: Date): void {
    const result = this.#db
      .update(wateringSequence)
      .set({ status: 'completed', endedAt: at })
      .where(and(eq(wateringSequence.id, id), eq(wateringSequence.status, 'active')))
      .run();
    expectChanged(result, `completing ${id}`);
  }

  sequenceAbandoned(seq: PendingSequence, at: Date, reason: string): void {
    this.#db.transaction((tx) => {
      const result = tx
        .update(wateringSequence)
        .set({ status: 'abandoned', endedAt: at, abandonReason: reason })
        .where(and(eq(wateringSequence.id, seq.id), eq(wateringSequence.status, 'active')))
        .run();
      expectChanged(result, `abandoning ${seq.id}`);
      tx.update(sequenceWave)
        .set({ status: 'skipped' })
        .where(and(eq(sequenceWave.sequenceId, seq.id), eq(sequenceWave.status, 'pending')))
        .run();
    });
  }

  // ---------- the Monitor's ----------

  saveAlerts(alerts: AlertState): void {
    this.#db.transaction((tx) => {
      tx.delete(openAlert).run();
      const rows = Object.entries(alerts).map(([alertKey, v]) => ({ alertKey, state: v.state as AlertConditionState, since: new Date(v.since) }));
      if (rows.length > 0) tx.insert(openAlert).values(rows).run();
    });
  }

  saveZoneSpells(spells: readonly ZoneSpell[], at: Date): void {
    if (spells.length === 0) return;
    this.#db.transaction((tx) => {
      ensureZoneRows(
        tx,
        spells.map((s) => s.zoneKey),
        at,
      );
      for (const s of spells) {
        const values = { drySince: s.drySince ?? null, noDataSince: s.noDataSince ?? null, evaluatedAt: at };
        tx.insert(zoneState)
          .values({ zoneKey: s.zoneKey, ...values })
          .onConflictDoUpdate({ target: zoneState.zoneKey, set: values })
          .run();
      }
    });
  }

  /** Each reading once: Tuya returns the same reading until the sensor reports again. */
  recordReadings(readings: readonly MoistureReading[], polledAt: Date): void {
    const rows = readings
      .filter((r) => Number.isFinite(r.at.getTime()))
      .map((r) => ({
        sensorId: r.sensorId,
        measuredAt: r.at,
        polledAt,
        moisturePct: Number.isFinite(r.moisturePct) ? r.moisturePct : null,
        temperatureC: r.temperatureC ?? null,
        batteryPct: r.batteryPct ?? null,
        online: r.online,
      }));
    if (rows.length === 0) return;
    this.#db.transaction((tx) => {
      for (const row of rows) tx.insert(sensorReading).values(row).onConflictDoNothing().run();
    });
  }
}
