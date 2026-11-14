import { readdir, readFile } from 'node:fs/promises';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../audit/audit.ts';
import type { StationRun } from '../../bhyve/types.ts';
import { WateringHistory, type WateringRun } from '../../conductor/history.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import {
  auditEvent,
  openAlert,
  pendingSequence,
  sensorReading,
  sequenceResult,
  sequenceWave,
  sequenceZone,
  serviceRun,
  wateringSequence,
  waveStation,
  zone,
  zoneWatering,
  type WaveDelivery,
} from '../../db/schema.ts';

/**
 * The schema exercised through the write points the Sequencer will use (see docs/sqlite-storage.md §5).
 * The helpers below double as examples of the intended queries.
 */

const START = Date.parse('2026-07-01T11:00:00.000Z');
/** Minutes after the start of the simulated day. */
const T = (min: number): Date => new Date(START + min * 60_000);
const DAY_MS = 24 * 60 * 60_000;

const addZone = (db: ConductorDb, deviceId: string, station: number, name = `Zone ${station}`): void => {
  db.insert(zone).values({ zoneKey: `${deviceId}:${station}`, deviceId, station, name, firstSeenAt: T(0), lastSeenAt: T(0) }).run();
};

/** Sequencer.start(): the sequence, why, its waves and stations, in one transaction. Wave 0 is due now. */
const startSequence = (db: ConductorDb, id: string, deviceId: string, waves: StationRun[][], soakMinutes: number, at: Date): void =>
  db.transaction((tx) => {
    tx.insert(wateringSequence).values({ id, deviceId, soakMinutes, createdAt: at }).run();
    const stations = [...new Set(waves.flat().map((r) => r.station))];
    for (const station of stations) {
      const minutes = waves.flat().filter((r) => r.station === station).reduce((sum, r) => sum + r.runTime, 0);
      tx.insert(sequenceZone)
        .values({
          sequenceId: id,
          zoneKey: `${deviceId}:${station}`,
          zoneName: `Zone ${station}`,
          moisturePct: 27,
          readingAt: at,
          thresholdPct: 30,
          targetPct: 40,
          requestedMinutes: minutes,
          detail: `below 30%; watering ${minutes} min`,
        })
        .run();
    }
    waves.forEach((wave, waveIndex) => {
      tx.insert(sequenceWave).values({ sequenceId: id, waveIndex, dueAt: waveIndex === 0 ? at : null }).run();
      tx.insert(waveStation).values(wave.map((r) => ({ sequenceId: id, waveIndex, station: r.station, runMinutes: r.runTime }))).run();
    });
  });

const waveKey = (id: string, waveIndex: number) => and(eq(sequenceWave.sequenceId, id), eq(sequenceWave.waveIndex, waveIndex));

/** #attempt: marked (and committed) before the command is sent. */
const markSending = (db: ConductorDb, id: string, waveIndex: number, at: Date): void => {
  db.update(sequenceWave).set({ status: 'sending', sentAt: at }).where(and(waveKey(id, waveIndex), eq(sequenceWave.status, 'pending'))).run();
};

/** Send failed / device idle twice / deferred: back to pending, one more failed attempt. */
const failAttempt = (db: ConductorDb, id: string, waveIndex: number): void => {
  db.update(sequenceWave)
    .set({ status: 'pending', sentAt: null, failedAttempts: sql`${sequenceWave.failedAttempts} + 1` })
    .where(waveKey(id, waveIndex))
    .run();
};

/** #recordDelivered (+ #complete): wave delivered, ledger rows, next wave's due time, or the end. */
const deliver = (db: ConductorDb, id: string, waveIndex: number, delivery: WaveDelivery): void =>
  db.transaction((tx) => {
    const seq = tx.select().from(wateringSequence).where(eq(wateringSequence.id, id)).get();
    const wave = tx.select().from(sequenceWave).where(waveKey(id, waveIndex)).get();
    if (!seq || !wave?.sentAt) throw new Error(`wave ${id}/${waveIndex} is not in flight`);
    const sentAt = wave.sentAt;
    tx.update(sequenceWave).set({ status: 'delivered', delivery }).where(waveKey(id, waveIndex)).run();
    const stations = tx
      .select()
      .from(waveStation)
      .where(and(eq(waveStation.sequenceId, id), eq(waveStation.waveIndex, waveIndex)))
      .all();
    tx.insert(zoneWatering)
      .values(stations.map((s) => ({ zoneKey: `${seq.deviceId}:${s.station}`, startedAt: sentAt, minutes: s.runMinutes, sequenceId: id, waveIndex })))
      .run();
    const minutes = stations.reduce((sum, s) => sum + s.runMinutes, 0);
    const next = tx
      .update(sequenceWave)
      .set({ dueAt: new Date(sentAt.getTime() + (minutes + seq.soakMinutes) * 60_000) })
      .where(waveKey(id, waveIndex + 1))
      .run();
    if (next.changes === 0) tx.update(wateringSequence).set({ status: 'completed', endedAt: sentAt }).where(eq(wateringSequence.id, id)).run();
  });

/** #abandon */
const abandon = (db: ConductorDb, id: string, at: Date, reason: string): void =>
  db.transaction((tx) => {
    tx.update(wateringSequence).set({ status: 'abandoned', endedAt: at, abandonReason: reason }).where(eq(wateringSequence.id, id)).run();
    tx.update(sequenceWave).set({ status: 'skipped' }).where(and(eq(sequenceWave.sequenceId, id), eq(sequenceWave.status, 'pending'))).run();
  });

/** WateringHistoryView.lastRun over the ledger. */
const lastRun = (db: ConductorDb, zoneKey: string): WateringRun | undefined => {
  const row = db
    .select({ zoneKey: zoneWatering.zoneKey, at: zoneWatering.startedAt, minutes: zoneWatering.minutes })
    .from(zoneWatering)
    .where(eq(zoneWatering.zoneKey, zoneKey))
    .orderBy(desc(zoneWatering.startedAt), desc(zoneWatering.id))
    .limit(1)
    .get();
  return row ?? undefined;
};

/** WateringHistoryView.minutesInLastDay over the ledger. */
const minutesInLastDay = (db: ConductorDb, zoneKey: string, now: Date): number =>
  db
    .select({ minutes: sql<number>`coalesce(sum(${zoneWatering.minutes}), 0)` })
    .from(zoneWatering)
    .where(and(eq(zoneWatering.zoneKey, zoneKey), gt(zoneWatering.startedAt, new Date(now.getTime() - DAY_MS)), lte(zoneWatering.startedAt, now)))
    .get()?.minutes ?? 0;

/**
 * What SQLite said when it refused a statement. drizzle wraps driver errors in a DrizzleQueryError whose
 * message is the failed query; SQLite's own message (e.g. "UNIQUE constraint failed: ...") is its `cause`.
 */
const rejection = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the database to reject the statement');
};

const eightMinuteCycles: StationRun[][] = [[{ station: 1, runTime: 8 }], [{ station: 1, runTime: 8 }], [{ station: 1, runTime: 8 }]];

describe('database schema', () => {
  let db: ConductorDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
    addZone(db, 'timer-1', 1, 'Front lawn');
    addZone(db, 'timer-1', 2, 'Back lawn');
  });

  afterEach(() => {
    db.$client.close();
  });

  describe('timestamps', () => {
    it('are Dates in TypeScript and toISOString() text on disk', () => {
      const at = new Date('2026-07-01T11:00:00.5Z');
      db.insert(openAlert).values({ alertKey: 'device:d1', state: 'offline', since: at }).run();

      expect(db.select().from(openAlert).get()?.since).toEqual(at);
      expect(db.$client.prepare('SELECT since FROM open_alert').get()).toEqual({ since: '2026-07-01T11:00:00.500Z' });
    });

    it.each([
      ['no milliseconds', '2026-07-01T11:00:00Z'],
      ['an offset', '2026-07-01T11:00:00.000+00:00'],
      ['a local time', '2026-07-01 06:00:00'],
    ])('rejects %s, which would break time ordering', (_, text) => {
      expect(() => db.$client.prepare(`INSERT INTO open_alert (alert_key, state, since) VALUES ('device:d1', 'offline', ?)`).run(text)).toThrow(
        /CHECK constraint failed: open_alert_since_iso/,
      );
    });

    it('refuses an invalid Date instead of storing it', () => {
      expect(() => db.insert(openAlert).values({ alertKey: 'device:d1', state: 'offline', since: new Date(Number.NaN) }).run()).toThrow(RangeError);
    });
  });

  describe('watering sequences', () => {
    it('follow a crash mid-send and its recovery (the crash-mid-soak scenario)', async () => {
      const id = '3d7cc742-1f0e-4c1e-9a57-0c1d2e3f4a5b';
      startSequence(db, id, 'timer-1', eightMinuteCycles, 20, T(0));
      markSending(db, id, 0, T(0));
      deliver(db, id, 0, 'event');
      markSending(db, id, 1, T(28));
      deliver(db, id, 1, 'event');
      failAttempt(db, id, 2); // socket down
      markSending(db, id, 2, T(56)); // ...and the process dies here

      // At restart: exactly the PendingSequence the Sequencer needs.
      expect(db.select().from(pendingSequence).all()).toEqual([
        {
          id,
          deviceId: 'timer-1',
          soakMinutes: 20,
          createdAt: T(0),
          waveCount: 3,
          nextWave: 2,
          dueAt: T(56),
          attempts: 1,
          inFlightWave: 2,
          inFlightSince: T(56),
          zoneNames: ['Zone 1'],
        },
      ]);
      const [loaded] = await db.query.wateringSequence.findMany({
        where: { status: 'active' },
        with: { waves: { orderBy: { waveIndex: 'asc' }, with: { stations: { orderBy: { station: 'asc' } } } } },
      });
      expect(loaded?.waves.map((w) => w.stations.map((s) => ({ station: s.station, runTime: s.runMinutes })))).toEqual(eightMinuteCycles);

      // Found in flight: counted as delivered, never re-sent.
      deliver(db, id, 2, 'assumed');

      expect(db.select().from(pendingSequence).all()).toEqual([]);
      expect(db.select().from(sequenceResult).get()).toEqual({
        id,
        deviceId: 'timer-1',
        createdAt: T(0),
        status: 'completed',
        endedAt: T(56),
        abandonReason: null,
        cycles: 3,
        cyclesDelivered: 3,
        plannedMinutes: 24,
        deliveredMinutes: 24,
        uncertainStationRuns: 1,
        failedAttempts: 1,
        waterOffAt: T(64),
      });
      // The schedule: each wave due at the previous send + its 8 minutes + the 20-minute soak.
      expect(db.select({ dueAt: sequenceWave.dueAt }).from(sequenceWave).orderBy(asc(sequenceWave.waveIndex)).all()).toEqual([
        { dueAt: T(0) },
        { dueAt: T(28) },
        { dueAt: T(56) },
      ]);
      expect(lastRun(db, 'timer-1:1')).toEqual({ zoneKey: 'timer-1:1', at: T(56), minutes: 8 });
    });

    it('lists a sequence whose waves are all delivered but that was never closed, so the loader can close it', () => {
      startSequence(db, 'stuck', 'timer-1', [[{ station: 1, runTime: 5 }]], 0, T(0));
      db.update(sequenceWave).set({ status: 'delivered', sentAt: T(0), delivery: 'event' }).where(waveKey('stuck', 0)).run();

      expect(db.select({ nextWave: pendingSequence.nextWave, waveCount: pendingSequence.waveCount }).from(pendingSequence).all()).toEqual([
        { nextWave: 1, waveCount: 1 },
      ]);
    });

    it('allows only one active sequence per device', () => {
      startSequence(db, 'first', 'timer-1', eightMinuteCycles, 20, T(0));

      expect(rejection(() => startSequence(db, 'second', 'timer-1', eightMinuteCycles, 20, T(1)))).toMatch(/UNIQUE constraint failed: watering_sequence.device_id/);
      expect(db.select().from(wateringSequence).all().map((s) => s.id)).toEqual(['first']); // the failed start left nothing behind

      abandon(db, 'first', T(5), 'the device was switched off');
      startSequence(db, 'second', 'timer-1', eightMinuteCycles, 20, T(6));
      expect(db.select({ id: pendingSequence.id }).from(pendingSequence).all()).toEqual([{ id: 'second' }]);
    });

    it('records an abandoned sequence with what was and was not delivered', () => {
      startSequence(db, 'gone', 'timer-1', [[{ station: 2, runTime: 5 }], [{ station: 2, runTime: 5 }]], 20, T(300));
      markSending(db, 'gone', 0, T(300));
      deliver(db, 'gone', 0, 'status');
      abandon(db, 'gone', T(320), 'a 48h rain delay was set');

      expect(db.select().from(sequenceWave).orderBy(asc(sequenceWave.waveIndex)).all().map((w) => w.status)).toEqual(['delivered', 'skipped']);
      expect(db.select().from(sequenceResult).get()).toMatchObject({
        status: 'abandoned',
        abandonReason: 'a 48h rain delay was set',
        cycles: 2,
        cyclesDelivered: 1,
        plannedMinutes: 10,
        deliveredMinutes: 5,
        waterOffAt: T(305),
      });
    });

    it.each([
      ['a delivered wave without a send time', { status: 'delivered' as const, delivery: 'event' as const }],
      ['a wave in flight with a delivery', { status: 'sending' as const, sentAt: T(0), delivery: 'event' as const }],
      ['a pending wave with a send time', { status: 'pending' as const, sentAt: T(0) }],
      ['a negative attempt count', { failedAttempts: -1 }],
    ])('rejects %s', (_, values) => {
      startSequence(db, 's', 'timer-1', eightMinuteCycles, 20, T(0));
      expect(rejection(() => db.update(sequenceWave).set(values).where(waveKey('s', 0)).run())).toMatch(/CHECK constraint failed/);
    });

    it('rejects runs B-hyve would not accept and finished sequences without an end', () => {
      expect(rejection(() => startSequence(db, 'long', 'timer-1', [[{ station: 1, runTime: 241 }]], 0, T(0)))).toMatch(/wave_station_run_minutes_range/);
      startSequence(db, 's', 'timer-1', eightMinuteCycles, 20, T(0));
      expect(rejection(() => db.update(wateringSequence).set({ status: 'completed' }).run())).toMatch(/watering_sequence_ended_iff_not_active/);
      expect(rejection(() => db.update(wateringSequence).set({ status: 'abandoned', endedAt: T(1) }).run())).toMatch(/watering_sequence_reason_iff_abandoned/);
    });
  });

  describe('watering ledger', () => {
    it('answers cooldown and daily-cap questions exactly like WateringHistory', () => {
      const runs: WateringRun[] = [
        { zoneKey: 'timer-1:1', at: T(0), minutes: 8 },
        { zoneKey: 'timer-1:1', at: T(28), minutes: 8.5 },
        { zoneKey: 'timer-1:1', at: T(28), minutes: 1 }, // same instant: insertion order decides, as in history.ts
        { zoneKey: 'timer-1:1', at: T(24 * 60), minutes: 10 }, // exactly 24 h after the first
        { zoneKey: 'timer-1:1', at: T(24 * 60 + 600), minutes: 12 },
        { zoneKey: 'timer-1:2', at: T(90), minutes: 5 },
        { zoneKey: 'timer-1:2', at: T(-30), minutes: 7 },
      ];
      db.insert(zoneWatering).values(runs.map((r) => ({ zoneKey: r.zoneKey, startedAt: r.at, minutes: r.minutes }))).run();
      const history = new WateringHistory(runs);

      for (const key of ['timer-1:1', 'timer-1:2', 'timer-9:9']) {
        expect(lastRun(db, key), key).toEqual(history.lastRun(key));
        for (const now of [T(-60), T(0), T(27), T(28), T(100), T(24 * 60 - 1), T(24 * 60), T(24 * 60 + 28), T(24 * 60 + 29), T(3 * 24 * 60)]) {
          expect(minutesInLastDay(db, key, now), `${key} @ ${now.toISOString()}`).toBeCloseTo(history.minutesInLastDay(key, now), 9);
        }
      }
    });

    it('uses its index for the daily-cap query', () => {
      const plan = db.$client
        .prepare('EXPLAIN QUERY PLAN SELECT sum(minutes) FROM zone_watering WHERE zone_key = ? AND started_at > ? AND started_at <= ?')
        .all() as { detail: string }[];
      expect(plan.map((p) => p.detail).join(' ')).toContain('USING INDEX zone_watering_zone_time');
    });

    it('never counts a wave twice, never changes, and outlives the sequences it came from', () => {
      startSequence(db, 's', 'timer-1', eightMinuteCycles, 20, T(0));
      markSending(db, 's', 0, T(0));
      deliver(db, 's', 0, 'event');

      expect(
        rejection(() => db.insert(zoneWatering).values({ zoneKey: 'timer-1:1', startedAt: T(0), minutes: 8, sequenceId: 's', waveIndex: 0 }).run()),
      ).toMatch(/UNIQUE constraint failed/);
      expect(rejection(() => db.update(zoneWatering).set({ minutes: 0 }).run())).toMatch(/zone_watering is append-only/);
      expect(rejection(() => db.update(zoneWatering).set({ startedAt: T(-600) }).run())).toMatch(/zone_watering is append-only/);
      // Detaching provenance is only allowed together with nothing else.
      expect(rejection(() => db.update(zoneWatering).set({ sequenceId: null, waveIndex: null, minutes: 1 }).run())).toMatch(
        /zone_watering is append-only/,
      );
      expect(rejection(() => db.insert(zoneWatering).values({ zoneKey: 'nope:1', startedAt: T(0), minutes: 5 }).run())).toMatch(/FOREIGN KEY/);

      abandon(db, 's', T(10), 'test');
      db.delete(wateringSequence).where(eq(wateringSequence.id, 's')).run(); // retention
      expect(db.select().from(sequenceWave).all()).toEqual([]); // cascaded
      expect(db.select().from(zoneWatering).all()).toEqual([
        { id: 1, zoneKey: 'timer-1:1', startedAt: T(0), minutes: 8, sequenceId: null, waveIndex: null },
      ]);
    });
  });

  describe('open alerts', () => {
    it('derive their kind from the AlertTracker key and reject unknown kinds or states', () => {
      const since = T(0);
      db.insert(openAlert)
        .values([
          { alertKey: 'battery:sensor:front-a', state: 'low', since },
          { alertKey: 'moisture:timer-1:1:front-a', state: 'high', since },
          { alertKey: 'daily-limit:timer-1:2', state: 'reached', since },
        ])
        .run();

      expect(db.select({ key: openAlert.alertKey, kind: openAlert.kind }).from(openAlert).orderBy(asc(openAlert.alertKey)).all()).toEqual([
        { key: 'battery:sensor:front-a', kind: 'battery' },
        { key: 'daily-limit:timer-1:2', kind: 'daily-limit' },
        { key: 'moisture:timer-1:1:front-a', kind: 'moisture' },
      ]);
      expect(() => db.$client.prepare(`INSERT INTO open_alert (alert_key, state, since) VALUES ('foo:bar', 'low', ?)`).run(since.toISOString())).toThrow(
        /open_alert_kind/,
      );
      expect(() => db.$client.prepare(`INSERT INTO open_alert (alert_key, state, since) VALUES ('device:d', 'dead', ?)`).run(since.toISOString())).toThrow(
        /open_alert_state/,
      );
    });
  });

  describe('audit trail', () => {
    const simulations = new URL('../../../simulations/', import.meta.url);

    it('stores every simulated audit event and gives it back unchanged', async () => {
      const files = (await readdir(simulations)).filter((f) => f.endsWith('.audit.jsonl')).sort();
      const original: AuditEvent[] = [];
      for (const file of files) {
        const text = await readFile(new URL(file, simulations), 'utf8');
        original.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditEvent));
      }
      expect(original.length).toBeGreaterThan(200);

      db.insert(auditEvent)
        .values(original.map(({ ts, type, ...data }) => ({ ts: new Date(ts), type, data })))
        .run();

      const rows = db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
      expect(rows.map((r) => ({ ts: r.ts.toISOString(), type: r.type, ...r.data }))).toEqual(original);
      // The filter columns match the payload.
      for (const r of rows) {
        expect(r.deviceId).toBe(typeof r.data.device === 'string' ? r.data.device : null);
        expect(r.sequenceId).toBe(typeof r.data.sequence === 'string' ? r.data.sequence : null);
        expect(r.zoneKey).toBe(typeof r.data.zone === 'string' ? r.data.zone : null);
      }
    });

    it('accepts any payload, finds events by sequence through an index, and is append-only', () => {
      db.insert(auditEvent)
        .values([
          { ts: T(0), type: 'wave.sent', data: { sequence: 'abc', device: 12345 } },
          { ts: T(1), type: 'service.stopped' }, // no payload at all
          { ts: T(2), type: 'wave.confirmed', data: { sequence: 'abc', zone: ['not', 'a', 'string'] } },
        ])
        .run();

      expect(db.select({ type: auditEvent.type }).from(auditEvent).where(eq(auditEvent.sequenceId, 'abc')).orderBy(asc(auditEvent.ts)).all()).toEqual([
        { type: 'wave.sent' },
        { type: 'wave.confirmed' },
      ]);
      expect(db.select({ deviceId: auditEvent.deviceId }).from(auditEvent).where(eq(auditEvent.type, 'wave.sent')).get()).toEqual({ deviceId: '12345' });
      expect(db.select({ data: auditEvent.data }).from(auditEvent).where(eq(auditEvent.type, 'service.stopped')).get()).toEqual({ data: {} });
      const plan = db.$client.prepare('EXPLAIN QUERY PLAN SELECT * FROM audit_event WHERE sequence_id = ? ORDER BY ts').all() as { detail: string }[];
      expect(plan.map((p) => p.detail).join(' ')).toContain('USING INDEX audit_event_sequence');

      expect(rejection(() => db.update(auditEvent).set({ type: 'wave.sent' }).run())).toMatch(/audit_event is append-only/);
      db.delete(auditEvent).where(lte(auditEvent.ts, T(0))).run(); // retention is allowed
      expect(db.select().from(auditEvent).all()).toHaveLength(2);
    });
  });

  describe('service runs and sensor readings', () => {
    it('find the runs that never stopped (unclean shutdowns)', () => {
      const run = { mode: 'continuous' as const, dryRun: false, configHash: 'h', config: { zones: 2 } };
      db.insert(serviceRun)
        .values([
          { ...run, startedAt: T(0), heartbeatAt: T(30), stoppedAt: T(31), stopReason: 'SIGTERM' },
          { ...run, startedAt: T(40), heartbeatAt: T(95) },
        ])
        .run();

      expect(db.select({ id: serviceRun.id, lastAlive: serviceRun.heartbeatAt }).from(serviceRun).where(sql`${serviceRun.stoppedAt} IS NULL`).all()).toEqual([
        { id: 2, lastAlive: T(95) },
      ]);
      expect(rejection(() => db.update(serviceRun).set({ stoppedAt: T(100) }).where(eq(serviceRun.id, 2)).run())).toMatch(/service_run_stopped_pair/);
    });

    it('store each sensor reading once, however often it is polled', () => {
      const reading = { sensorId: 'front-a', measuredAt: T(0), moisturePct: 26, temperatureC: 21.5, batteryPct: 80, online: true };
      db.insert(sensorReading).values({ ...reading, polledAt: T(0) }).onConflictDoNothing().run();
      db.insert(sensorReading).values({ ...reading, polledAt: T(15) }).onConflictDoNothing().run();
      db.insert(sensorReading).values({ ...reading, measuredAt: T(20), moisturePct: 27, polledAt: T(30) }).onConflictDoNothing().run();

      expect(db.select({ at: sensorReading.measuredAt, polled: sensorReading.polledAt, online: sensorReading.online }).from(sensorReading).all()).toEqual([
        { at: T(0), polled: T(0), online: true },
        { at: T(20), polled: T(30), online: true },
      ]);
    });
  });
});
