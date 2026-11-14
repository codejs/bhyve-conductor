import type { StationRun } from '../bhyve/types.ts';
import type { AlertState } from '../conductor/alerts.ts';
import type { ZoneConfig } from '../conductor/config.ts';
import type { WateringRun } from '../conductor/history.ts';
import type { PendingSequence } from '../conductor/state.ts';
import type { ConductorStore, SavedZoneSpell, SequenceZone, StoredState, ZoneSpell } from '../conductor/store.ts';
import { log } from '../log.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { ConductorDb } from './database.ts';
import type { Prisma } from './generated/client.ts';
import {
  ALERT_STATES,
  alertKindOf,
  assertOneOf,
  assertStationRun,
  assertTime,
  InvalidDataError,
  parseZoneKey,
  WAVE_DELIVERIES,
  type SequenceResult,
  type SequenceStatus,
  type WaveDelivery,
} from './model.ts';

export { parseZoneKey };

/**
 * The conductor's state, with Prisma: the ConductorStore steps (each one transaction) and loading what a
 * previous run left behind. See docs/sqlite-storage.md §5 for which step writes what.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A Prisma client or the client of an interactive transaction. */
type Tx = Prisma.TransactionClient;

/** A step that matched nothing is a bug (or a write that was lost): refuse it loudly. */
export class NoMatchingRowError extends Error {
  override readonly name = 'NoMatchingRowError';
  constructor(what: string) {
    super(`${what}: no matching row`);
  }
}

const expectChanged = (result: { count: number }, what: string): void => {
  if (result.count === 0) throw new NoMatchingRowError(what);
};

/** Zone rows for keys not registered yet (e.g. a sequence resumed after its zone left the config). */
export const ensureZoneRows = async (tx: Tx, keys: Iterable<string>, at: Date): Promise<void> => {
  for (const key of new Set(keys)) {
    const { deviceId, station } = parseZoneKey(key);
    await tx.zone.upsert({
      where: { zoneKey: key },
      create: { zoneKey: key, deviceId, station, name: `zone ${station}`, firstSeenAt: at, lastSeenAt: at },
      update: {},
    });
  }
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

export class SqliteStore implements ConductorStore {
  readonly #db: ConductorDb;
  readonly #serviceRunId: number | undefined;

  constructor(db: ConductorDb, options: { serviceRunId?: number } = {}) {
    this.#db = db;
    this.#serviceRunId = options.serviceRunId;
  }

  get #prisma() {
    return this.#db.prisma;
  }

  /** Registers the configured zones (upserts names; history outlives zones removed from the config). */
  async syncZones(zones: readonly ZoneConfig[], at: Date): Promise<void> {
    await this.#prisma.$transaction(
      zones.map((z) =>
        this.#prisma.zone.upsert({
          where: { zoneKey: z.key },
          create: { zoneKey: z.key, deviceId: z.deviceId, station: z.station, name: z.name, firstSeenAt: at, lastSeenAt: at },
          update: { name: z.name, lastSeenAt: at },
        }),
      ),
    );
  }

  // ---------- loading ----------

  /**
   * What a previous run left: ledger runs from the last `historyWindowMs` (at least 24 h), unfinished
   * sequences, open alerts and zone spells. A sequence whose waves were all delivered but that was never
   * closed (a crash between the two writes) is completed here, so it can't block its device; with
   * `repair: false` (dry runs write nothing) it is only left out.
   */
  async loadState(now: Date, historyWindowMs: number, options: { repair?: boolean } = {}): Promise<StoredState> {
    const since = new Date(now.getTime() - Math.max(historyWindowMs, DAY_MS));
    const history: WateringRun[] = await this.#prisma.zoneWatering.findMany({
      where: { startedAt: { gte: since } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { zoneKey: true, startedAt: true, minutes: true },
    }).then((rows) => rows.map((r) => ({ zoneKey: r.zoneKey, at: r.startedAt, minutes: r.minutes })));

    const active = await this.#prisma.wateringSequence.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      include: {
        waves: { orderBy: { waveIndex: 'asc' }, include: { stations: { orderBy: { station: 'asc' } } } },
        zones: { orderBy: { zoneKey: 'asc' }, select: { zoneName: true } },
      },
    });
    const sequences: PendingSequence[] = [];
    for (const row of active) {
      // The wave row is the authority for progress: the first one not yet delivered or skipped is next.
      const next = row.waves.find((w) => w.status === 'pending' || w.status === 'sending');
      if (!next) {
        if (options.repair !== false) {
          log.warn(`Watering sequence ${row.id} was fully delivered but never closed; closing it now`);
          await this.#complete(row.id, now);
        }
        continue;
      }
      sequences.push({
        id: row.id,
        deviceId: row.deviceId,
        waves: row.waves.map((w) => w.stations.map((s): StationRun => ({ station: s.station, runTime: s.runMinutes }))),
        soakMinutes: row.soakMinutes,
        ...(row.zones.length > 0 ? { zoneNames: row.zones.map((z) => z.zoneName) } : {}),
        createdAt: row.createdAt,
        nextWave: next.waveIndex,
        // Every due wave has a due time; if one is missing, the creation time makes resume() judge it (too) late.
        dueAt: next.dueAt ?? row.createdAt,
        attempts: next.failedAttempts,
        ...(next.status === 'sending' && next.sentAt ? { inFlight: { wave: next.waveIndex, since: next.sentAt } } : {}),
      });
    }

    const alerts: AlertState = {};
    for (const a of await this.#prisma.openAlert.findMany({ orderBy: { alertKey: 'asc' } })) {
      alerts[a.alertKey] = { state: a.state, since: a.since.toISOString() };
    }

    const zoneSpells: SavedZoneSpell[] = (await this.#prisma.zoneState.findMany({ orderBy: { zoneKey: 'asc' } })).map((z) => ({
      zoneKey: z.zoneKey,
      ...(z.drySince ? { drySince: z.drySince } : {}),
      ...(z.noDataSince ? { noDataSince: z.noDataSince } : {}),
      evaluatedAt: z.evaluatedAt,
    }));

    return { history, sequences, alerts, zoneSpells };
  }

  /** What each sequence planned and delivered (the simulator and reports). */
  async sequenceResults(): Promise<SequenceResult[]> {
    const rows = await this.#prisma.wateringSequence.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { waves: { orderBy: { waveIndex: 'asc' }, include: { stations: true } } },
    });
    return rows.map((s) => {
      const minutes = (w: (typeof s.waves)[number]) => w.stations.reduce((sum, st) => sum + st.runMinutes, 0);
      const delivered = s.waves.filter((w) => w.status === 'delivered');
      const offTimes = delivered.filter((w) => w.sentAt).map((w) => (w.sentAt as Date).getTime() + minutes(w) * 60_000);
      return {
        id: s.id,
        deviceId: s.deviceId,
        createdAt: s.createdAt,
        status: s.status as SequenceStatus,
        endedAt: s.endedAt,
        abandonReason: s.abandonReason,
        cycles: s.waves.length,
        cyclesDelivered: delivered.length,
        plannedMinutes: round1(s.waves.reduce((sum, w) => sum + minutes(w), 0)),
        deliveredMinutes: round1(delivered.reduce((sum, w) => sum + minutes(w), 0)),
        uncertainStationRuns: delivered.filter((w) => w.delivery === 'unconfirmed' || w.delivery === 'assumed').reduce((sum, w) => sum + w.stations.length, 0),
        failedAttempts: s.waves.reduce((sum, w) => sum + w.failedAttempts, 0),
        waterOffAt: offTimes.length > 0 ? new Date(Math.max(...offTimes)) : null,
      };
    });
  }

  // ---------- the Sequencer's steps ----------

  async sequenceStarted(seq: PendingSequence, zones: readonly SequenceZone[]): Promise<void> {
    assertTime(seq.createdAt, 'the sequence start');
    assertTime(seq.dueAt, 'the first due time');
    if (!(seq.soakMinutes >= 0)) throw new InvalidDataError(`the soak must be 0 minutes or more (got ${seq.soakMinutes})`);
    for (const run of seq.waves.flat()) assertStationRun(run.station, run.runTime);
    for (const z of zones) if (!(z.requestedMinutes > 0)) throw new InvalidDataError(`${z.zoneKey}: requested minutes must be positive`);

    await this.#prisma.$transaction(async (tx) => {
      // The Sequencer never runs two sequences on one device; if memory and disk ever disagree, refuse.
      const running = await tx.wateringSequence.findFirst({ where: { deviceId: seq.deviceId, status: 'active' }, select: { id: true } });
      if (running) throw new InvalidDataError(`device ${seq.deviceId} already has an active watering sequence (${running.id})`);
      await ensureZoneRows(tx, [...zones.map((z) => z.zoneKey), ...seq.waves.flat().map((r) => `${seq.deviceId}:${r.station}`)], seq.createdAt);
      await tx.wateringSequence.create({
        data: {
          id: seq.id,
          serviceRunId: this.#serviceRunId ?? null,
          deviceId: seq.deviceId,
          soakMinutes: seq.soakMinutes,
          createdAt: seq.createdAt,
          status: 'active',
          zones: {
            create: zones.map((z) => ({
              zoneKey: z.zoneKey,
              zoneName: z.zoneName,
              moisturePct: z.moisturePct ?? null,
              readingAt: z.readingAt ?? null,
              thresholdPct: z.thresholdPct,
              targetPct: z.targetPct,
              requestedMinutes: z.requestedMinutes,
              allowanceMinutes: z.allowanceMinutes ?? null,
              budgetInches: z.budget?.inches ?? null,
              ...(z.budget ? { budget: z.budget as unknown as Prisma.InputJsonValue } : {}),
              detail: z.detail,
            })),
          },
          waves: {
            create: seq.waves.map((wave, waveIndex) => ({
              waveIndex,
              dueAt: waveIndex === seq.nextWave ? seq.dueAt : null,
              stations: { create: wave.map((r) => ({ station: r.station, runMinutes: r.runTime })) },
            })),
          },
        },
      });
    });
  }

  async waveSending(seq: PendingSequence, wave: number, at: Date): Promise<void> {
    assertTime(at, 'the send time');
    const result = await this.#prisma.sequenceWave.updateMany({
      where: { sequenceId: seq.id, waveIndex: wave, status: 'pending' },
      data: { status: 'sending', sentAt: at },
    });
    expectChanged(result, `marking ${seq.id} cycle ${wave + 1} as sending`);
  }

  async waveFailed(seq: PendingSequence, wave: number): Promise<void> {
    const result = await this.#prisma.sequenceWave.updateMany({
      where: { sequenceId: seq.id, waveIndex: wave, status: { in: ['pending', 'sending'] } },
      data: { status: 'pending', sentAt: null, failedAttempts: { increment: 1 } },
    });
    expectChanged(result, `recording a failed attempt at ${seq.id} cycle ${wave + 1}`);
  }

  async waveDelivered(seq: PendingSequence, wave: number, delivery: WaveDelivery, sentAt: Date, nextDueAt: Date | undefined): Promise<void> {
    assertOneOf(delivery, WAVE_DELIVERIES, 'delivery');
    assertTime(sentAt, 'the send time');
    if (nextDueAt) assertTime(nextDueAt, 'the next due time');
    await this.#prisma.$transaction(async (tx) => {
      // Also from 'pending': if marking it 'sending' failed to save, the delivery must still be recorded.
      const updated = await tx.sequenceWave.updateMany({
        where: { sequenceId: seq.id, waveIndex: wave, status: { in: ['pending', 'sending'] } },
        data: { status: 'delivered', delivery, sentAt },
      });
      expectChanged(updated, `recording ${seq.id} cycle ${wave + 1} as delivered`);
      const stations = await tx.waveStation.findMany({ where: { sequenceId: seq.id, waveIndex: wave }, orderBy: { station: 'asc' } });
      await ensureZoneRows(
        tx,
        stations.map((s) => `${seq.deviceId}:${s.station}`),
        sentAt,
      );
      if (stations.length > 0) {
        await tx.zoneWatering.createMany({
          data: stations.map((s) => ({ zoneKey: `${seq.deviceId}:${s.station}`, startedAt: sentAt, minutes: s.runMinutes, sequenceId: seq.id, waveIndex: wave })),
        });
      }
      if (nextDueAt) {
        const next = await tx.sequenceWave.updateMany({ where: { sequenceId: seq.id, waveIndex: wave + 1 }, data: { dueAt: nextDueAt } });
        expectChanged(next, `scheduling ${seq.id} cycle ${wave + 2}`);
      }
    });
  }

  async sequenceCompleted(seq: PendingSequence, at: Date): Promise<void> {
    await this.#complete(seq.id, at);
  }

  async #complete(id: string, at: Date): Promise<void> {
    assertTime(at, 'the end time');
    const result = await this.#prisma.wateringSequence.updateMany({ where: { id, status: 'active' }, data: { status: 'completed', endedAt: at } });
    expectChanged(result, `completing ${id}`);
  }

  async sequenceAbandoned(seq: PendingSequence, at: Date, reason: string): Promise<void> {
    assertTime(at, 'the end time');
    await this.#prisma.$transaction(async (tx) => {
      const result = await tx.wateringSequence.updateMany({ where: { id: seq.id, status: 'active' }, data: { status: 'abandoned', endedAt: at, abandonReason: reason } });
      expectChanged(result, `abandoning ${seq.id}`);
      await tx.sequenceWave.updateMany({ where: { sequenceId: seq.id, status: 'pending' }, data: { status: 'skipped' } });
    });
  }

  // ---------- the Monitor's ----------

  /** Replaces the open alert conditions, all or nothing. */
  async saveAlerts(alerts: AlertState): Promise<void> {
    const rows = Object.entries(alerts).map(([alertKey, v]) => {
      const since = new Date(v.since);
      assertTime(since, `the start of alert ${alertKey}`);
      return { alertKey, kind: alertKindOf(alertKey), state: assertOneOf(v.state, ALERT_STATES, `the state of alert ${alertKey}`), since };
    });
    await this.#prisma.$transaction([this.#prisma.openAlert.deleteMany(), ...(rows.length > 0 ? [this.#prisma.openAlert.createMany({ data: rows })] : [])]);
  }

  async saveZoneSpells(spells: readonly ZoneSpell[], at: Date): Promise<void> {
    if (spells.length === 0) return;
    assertTime(at, 'the poll time');
    await this.#prisma.$transaction(async (tx) => {
      await ensureZoneRows(
        tx,
        spells.map((s) => s.zoneKey),
        at,
      );
      for (const s of spells) {
        const values = { drySince: s.drySince ?? null, noDataSince: s.noDataSince ?? null, evaluatedAt: at };
        await tx.zoneState.upsert({ where: { zoneKey: s.zoneKey }, create: { zoneKey: s.zoneKey, ...values }, update: values });
      }
    });
  }

  /** Each reading once: Tuya returns the same reading until the sensor reports again. */
  async recordReadings(readings: readonly MoistureReading[], polledAt: Date): Promise<void> {
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
    await this.#prisma.$transaction(
      rows.map((row) =>
        this.#prisma.sensorReading.upsert({ where: { sensorId_measuredAt: { sensorId: row.sensorId, measuredAt: row.measuredAt } }, create: row, update: {} }),
      ),
    );
  }
}
