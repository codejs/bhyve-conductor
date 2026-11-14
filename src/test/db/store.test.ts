import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingSequence } from '../../conductor/state.ts';
import type { SequenceZone } from '../../conductor/store.ts';
import type { WaterBudget } from '../../conductor/water-budget.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { openAlert, sensorReading, sequenceWave, sequenceZone, wateringSequence, waveStation, zone, zoneState, zoneWatering } from '../../db/schema.ts';
import { parseZoneKey, SqliteStore } from '../../db/store.ts';
import { log } from '../../log.ts';
import { reading, zone as zoneConfig } from '../utils/conductor.ts';

const T0 = new Date('2026-07-01T11:00:00.000Z');
const T = (min: number): Date => new Date(T0.getTime() + min * 60_000);

/** Two 10-minute cycles on station 1 and a 5-minute run on station 2 in the first, 30-minute soak. */
const sequence = (overrides: Partial<PendingSequence> = {}): PendingSequence => ({
  id: 'seq-1',
  deviceId: 'dev1',
  waves: [
    [
      { station: 1, runTime: 10 },
      { station: 2, runTime: 5 },
    ],
    [{ station: 1, runTime: 10 }],
  ],
  soakMinutes: 30,
  createdAt: T0,
  nextWave: 0,
  dueAt: T0,
  attempts: 0,
  ...overrides,
});

const budget = { inches: 0.5, minutes: 20, summary: 'apply 0.5in (20 min)' } as WaterBudget;
const why: SequenceZone[] = [
  {
    zoneKey: 'dev1:1',
    zoneName: 'Front',
    thresholdPct: 30,
    targetPct: 40,
    requestedMinutes: 20,
    moisturePct: 22,
    readingAt: T(-5),
    allowanceMinutes: 30,
    budget,
    detail: 'Front below 30%',
  },
  { zoneKey: 'dev1:2', zoneName: 'Back', thresholdPct: 25, targetPct: 35, requestedMinutes: 5, detail: 'Back below 25%' },
];

describe('SqliteStore', () => {
  let db: ConductorDb;
  let store: SqliteStore;
  const waves = () =>
    db
      .select({ i: sequenceWave.waveIndex, status: sequenceWave.status, dueAt: sequenceWave.dueAt, sentAt: sequenceWave.sentAt, delivery: sequenceWave.delivery, failed: sequenceWave.failedAttempts })
      .from(sequenceWave)
      .orderBy(asc(sequenceWave.waveIndex))
      .all();
  const ledger = () =>
    db
      .select({ zoneKey: zoneWatering.zoneKey, at: zoneWatering.startedAt, minutes: zoneWatering.minutes, wave: zoneWatering.waveIndex })
      .from(zoneWatering)
      .orderBy(asc(zoneWatering.id))
      .all();

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new SqliteStore(db);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.$client.close();
  });

  describe('parseZoneKey', () => {
    it.each([
      ['dev1:2', { deviceId: 'dev1', station: 2 }],
      ['a:b:c:12', { deviceId: 'a:b:c', station: 12 }],
    ])('%s', (key, parts) => expect(parseZoneKey(key)).toEqual(parts));

    it.each(['dev1', ':2', 'dev1:0', 'dev1:x', 'dev1:1.5'])('rejects %s', (key) => expect(() => parseZoneKey(key)).toThrow(/not a zone key/));
  });

  describe('zones', () => {
    it('registers configured zones and updates their names, keeping when they were first seen', () => {
      store.syncZones([zoneConfig({ name: 'Front' }), zoneConfig({ station: 2, name: 'Back' })], T0);
      store.syncZones([zoneConfig({ name: 'Front lawn' })], T(60)); // Back removed from the config

      expect(db.select().from(zone).orderBy(asc(zone.zoneKey)).all()).toEqual([
        { zoneKey: 'dev1:1', deviceId: 'dev1', station: 1, name: 'Front lawn', firstSeenAt: T0, lastSeenAt: T(60) },
        { zoneKey: 'dev1:2', deviceId: 'dev1', station: 2, name: 'Back', firstSeenAt: T0, lastSeenAt: T0 }, // kept: it has history
      ]);
    });
  });

  describe('the Sequencer steps', () => {
    it('saves a planned sequence: why each zone is in it, its waves and stations; the first wave is due', () => {
      store.sequenceStarted(sequence(), why);

      expect(db.select().from(wateringSequence).all()).toEqual([
        { id: 'seq-1', serviceRunId: null, deviceId: 'dev1', soakMinutes: 30, createdAt: T0, status: 'active', endedAt: null, abandonReason: null },
      ]);
      expect(db.select().from(sequenceZone).orderBy(asc(sequenceZone.zoneKey)).all()).toEqual([
        { sequenceId: 'seq-1', zoneKey: 'dev1:1', zoneName: 'Front', moisturePct: 22, readingAt: T(-5), thresholdPct: 30, targetPct: 40, requestedMinutes: 20, allowanceMinutes: 30, budgetInches: 0.5, budget, detail: 'Front below 30%' },
        { sequenceId: 'seq-1', zoneKey: 'dev1:2', zoneName: 'Back', moisturePct: null, readingAt: null, thresholdPct: 25, targetPct: 35, requestedMinutes: 5, allowanceMinutes: null, budgetInches: null, budget: null, detail: 'Back below 25%' },
      ]);
      expect(waves()).toEqual([
        { i: 0, status: 'pending', dueAt: T0, sentAt: null, delivery: null, failed: 0 },
        { i: 1, status: 'pending', dueAt: null, sentAt: null, delivery: null, failed: 0 },
      ]);
      expect(db.select().from(waveStation).orderBy(asc(waveStation.waveIndex), asc(waveStation.station)).all()).toEqual([
        { sequenceId: 'seq-1', waveIndex: 0, station: 1, runMinutes: 10 },
        { sequenceId: 'seq-1', waveIndex: 0, station: 2, runMinutes: 5 },
        { sequenceId: 'seq-1', waveIndex: 1, station: 1, runMinutes: 10 },
      ]);
    });

    it('registers zones it has not seen (e.g. no reasons given), so history can refer to them', () => {
      store.sequenceStarted(sequence({ deviceId: 'dev9' }), []);

      expect(db.select({ key: zone.zoneKey, name: zone.name }).from(zone).orderBy(asc(zone.zoneKey)).all()).toEqual([
        { key: 'dev9:1', name: 'zone 1' },
        { key: 'dev9:2', name: 'zone 2' },
      ]);
    });

    it('saves nothing of a sequence that cannot be saved whole', () => {
      store.sequenceStarted(sequence(), why);

      expect(() => store.sequenceStarted(sequence({ id: 'seq-2' }), why)).toThrow(); // a second active sequence on dev1
      expect(db.select({ id: wateringSequence.id }).from(wateringSequence).all()).toEqual([{ id: 'seq-1' }]);
      expect(db.select().from(sequenceWave).where(eq(sequenceWave.sequenceId, 'seq-2')).all()).toEqual([]);
    });

    it('follows a wave from sending to delivered, writing the ledger and scheduling the next wave', () => {
      const s = sequence();
      store.sequenceStarted(s, why);

      store.waveSending(s, 0, T(1));
      expect(waves()[0]).toMatchObject({ status: 'sending', sentAt: T(1) });
      store.waveDelivered(s, 0, 'event', T(1), T(46));

      expect(waves()).toEqual([
        { i: 0, status: 'delivered', dueAt: T0, sentAt: T(1), delivery: 'event', failed: 0 },
        { i: 1, status: 'pending', dueAt: T(46), sentAt: null, delivery: null, failed: 0 },
      ]);
      expect(ledger()).toEqual([
        { zoneKey: 'dev1:1', at: T(1), minutes: 10, wave: 0 },
        { zoneKey: 'dev1:2', at: T(1), minutes: 5, wave: 0 },
      ]);
    });

    it('records a delivery even if marking the wave as sending was never saved', () => {
      const s = sequence();
      store.sequenceStarted(s, why);

      store.waveDelivered(s, 0, 'unconfirmed', T(2), T(47));

      expect(waves()[0]).toMatchObject({ status: 'delivered', sentAt: T(2), delivery: 'unconfirmed' });
    });

    it('never counts a wave twice', () => {
      const s = sequence();
      store.sequenceStarted(s, why);
      store.waveDelivered(s, 0, 'event', T(1), T(46));

      expect(() => store.waveDelivered(s, 0, 'event', T(1), T(46))).toThrow(/no matching row/);
      expect(ledger()).toHaveLength(2);
    });

    it('counts failed attempts, and puts a wave that was being sent back to pending', () => {
      const s = sequence();
      store.sequenceStarted(s, why);

      store.waveFailed(s, 0); // deferred
      store.waveSending(s, 0, T(2));
      store.waveFailed(s, 0); // send failed

      expect(waves()[0]).toEqual({ i: 0, status: 'pending', dueAt: T0, sentAt: null, delivery: null, failed: 2 });
    });

    it.each([
      ['sending a wave of an unknown sequence', (st: SqliteStore) => st.waveSending(sequence({ id: 'nope' }), 0, T0)],
      ['sending a wave that is not pending', (st: SqliteStore) => st.waveSending(sequence(), 0, T0)],
      ['failing an unknown wave', (st: SqliteStore) => st.waveFailed(sequence(), 7)],
      ['delivering an unknown wave', (st: SqliteStore) => st.waveDelivered(sequence(), 7, 'event', T0, undefined)],
      ['completing an unknown sequence', (st: SqliteStore) => st.sequenceCompleted(sequence({ id: 'nope' }), T0)],
      ['abandoning an unknown sequence', (st: SqliteStore) => st.sequenceAbandoned(sequence({ id: 'nope' }), T0, 'x')],
    ])('refuses %s (a step that matches nothing is a bug)', (_, step) => {
      store.sequenceStarted(sequence({ id: 'seq-1' }), why);
      store.waveSending(sequence(), 0, T0); // wave 0 is 'sending' now
      expect(() => step(store)).toThrow(/no matching row/);
    });

    it('refuses to schedule a wave that does not exist, and then saves none of the delivery', () => {
      const single = sequence({ id: 'single', waves: [[{ station: 1, runTime: 5 }]] });
      store.sequenceStarted(single, why);

      expect(() => store.waveDelivered(single, 0, 'event', T0, T(5))).toThrow(/scheduling single cycle 2: no matching row/);
      expect(waves()[0]?.status).toBe('pending');
      expect(ledger()).toEqual([]);
    });

    it('completes a sequence once', () => {
      const s = sequence();
      store.sequenceStarted(s, why);

      store.sequenceCompleted(s, T(60));

      expect(db.select({ status: wateringSequence.status, endedAt: wateringSequence.endedAt }).from(wateringSequence).get()).toEqual({ status: 'completed', endedAt: T(60) });
      expect(() => store.sequenceCompleted(s, T(61))).toThrow(/no matching row/);
    });

    it('abandons the rest of a sequence, keeping what was delivered', () => {
      const s = sequence();
      store.sequenceStarted(s, why);
      store.waveDelivered(s, 0, 'status', T(1), T(46));

      store.sequenceAbandoned(s, T(50), 'the device was switched off');

      expect(db.select({ status: wateringSequence.status, reason: wateringSequence.abandonReason }).from(wateringSequence).get()).toEqual({
        status: 'abandoned',
        reason: 'the device was switched off',
      });
      expect(waves().map((w) => w.status)).toEqual(['delivered', 'skipped']);
      expect(ledger()).toHaveLength(2);
    });
  });

  describe('loadState', () => {
    it('gives back unfinished sequences exactly as the Sequencer needs them', () => {
      const s = sequence();
      store.sequenceStarted(s, why);
      store.waveDelivered(s, 0, 'event', T(1), T(46));
      store.waveFailed(s, 1);
      store.waveSending(s, 1, T(48));
      const other = sequence({ id: 'seq-2', deviceId: 'dev2', createdAt: T(5), dueAt: T(5) });
      store.sequenceStarted(other, []);

      expect(store.loadState(T(50), 0).sequences).toEqual([
        { ...s, zoneNames: ['Front', 'Back'], nextWave: 1, dueAt: T(46), attempts: 1, inFlight: { wave: 1, since: T(48) } },
        { ...other }, // no zone names without reasons
      ]);
    });

    it('leaves out finished sequences', () => {
      const s = sequence();
      store.sequenceStarted(s, why);
      store.sequenceAbandoned(s, T(1), 'x');

      expect(store.loadState(T(2), 0).sequences).toEqual([]);
    });

    it('closes a sequence that was fully delivered but never closed, so it cannot block its device', () => {
      const s = sequence({ waves: [[{ station: 1, runTime: 5 }]] });
      store.sequenceStarted(s, why);
      store.waveDelivered(s, 0, 'event', T(1), undefined); // crash before sequenceCompleted

      expect(store.loadState(T(10), 0, { repair: false }).sequences).toEqual([]);
      expect(db.select({ status: wateringSequence.status }).from(wateringSequence).get()).toEqual({ status: 'active' }); // a dry run writes nothing
      store.loadState(T(10), 0);
      expect(db.select({ status: wateringSequence.status, endedAt: wateringSequence.endedAt }).from(wateringSequence).get()).toEqual({ status: 'completed', endedAt: T(10) });
      store.sequenceStarted(sequence({ id: 'next' }), []); // the device is free again
    });

    it('treats a missing due time as the creation time, so resume() judges the wave late rather than never', () => {
      const s = sequence({ nextWave: 0 });
      store.sequenceStarted(s, why);
      db.update(sequenceWave).set({ dueAt: null }).where(eq(sequenceWave.waveIndex, 0)).run();

      expect(store.loadState(T(1), 0).sequences[0]?.dueAt).toEqual(T0);
    });

    it('returns the ledger runs of the window (at least 24 h), in time order', () => {
      const day = 24 * 60;
      db.insert(zone).values({ zoneKey: 'dev1:1', deviceId: 'dev1', station: 1, name: 'Z', firstSeenAt: T0, lastSeenAt: T0 }).run();
      db.insert(zoneWatering)
        .values([
          { zoneKey: 'dev1:1', startedAt: T(-3 * day), minutes: 1 },
          { zoneKey: 'dev1:1', startedAt: T(-day), minutes: 2 }, // exactly 24 h before: kept (the cap query decides)
          { zoneKey: 'dev1:1', startedAt: T(-10), minutes: 3 },
        ])
        .run();

      expect(store.loadState(T0, 0).history.map((r) => r.minutes)).toEqual([2, 3]);
      expect(store.loadState(T0, 4 * day * 60_000).history.map((r) => r.minutes)).toEqual([1, 2, 3]);
      expect(store.loadState(T0, 0).history[0]).toEqual({ zoneKey: 'dev1:1', at: T(-day), minutes: 2 });
    });

    it('returns open alerts and zone spells', () => {
      store.saveAlerts({ 'battery:sensor:s1': { state: 'low', since: T0.toISOString() } });
      store.saveZoneSpells([{ zoneKey: 'dev1:1', drySince: T0 }, { zoneKey: 'dev1:2', noDataSince: T(5) }], T(15));

      const state = store.loadState(T(20), 0);

      expect(state.alerts).toEqual({ 'battery:sensor:s1': { state: 'low', since: T0.toISOString() } });
      expect(state.zoneSpells).toEqual([
        { zoneKey: 'dev1:1', drySince: T0, evaluatedAt: T(15) },
        { zoneKey: 'dev1:2', noDataSince: T(5), evaluatedAt: T(15) },
      ]);
    });

    it('is empty for a new database', () => {
      expect(store.loadState(T0, 0)).toEqual({ history: [], sequences: [], alerts: {}, zoneSpells: [] });
    });
  });

  describe('the Monitor steps', () => {
    it('replaces the open alerts, all or nothing', () => {
      store.saveAlerts({ 'device:d1': { state: 'offline', since: T0.toISOString() }, 'battery:sensor:s1': { state: 'low', since: T0.toISOString() } });
      store.saveAlerts({ 'device:d1': { state: 'offline', since: T0.toISOString() } });
      expect(db.select({ key: openAlert.alertKey }).from(openAlert).all()).toEqual([{ key: 'device:d1' }]);

      expect(() => store.saveAlerts({ 'mystery:x': { state: 'low', since: T0.toISOString() } })).toThrow();
      expect(db.select({ key: openAlert.alertKey }).from(openAlert).all()).toEqual([{ key: 'device:d1' }]); // unchanged

      store.saveAlerts({});
      expect(db.select().from(openAlert).all()).toEqual([]);
    });

    it('upserts zone spells, clearing what has ended', () => {
      store.saveZoneSpells([{ zoneKey: 'dev1:1', drySince: T0, noDataSince: T0 }], T0);
      store.saveZoneSpells([{ zoneKey: 'dev1:1' }], T(15));
      store.saveZoneSpells([], T(30)); // nothing to do

      expect(db.select().from(zoneState).all()).toEqual([{ zoneKey: 'dev1:1', drySince: null, noDataSince: null, evaluatedAt: T(15) }]);
    });

    it('saves each sensor reading once, keeping raw values and skipping ones it cannot place in time', () => {
      const r = reading('s1', 42.5, { at: T0, batteryPct: 80, temperatureC: 19.5 });
      store.recordReadings([r, reading('s2', Number.NaN, { at: T0, online: false }), reading('s3', 30, { at: new Date(Number.NaN) })], T0);
      store.recordReadings([r], T(15)); // polled again, the sensor hasn't reported since
      store.recordReadings([], T(30));

      expect(db.select().from(sensorReading).orderBy(asc(sensorReading.sensorId)).all()).toEqual([
        { sensorId: 's1', measuredAt: T0, polledAt: T0, moisturePct: 42.5, temperatureC: 19.5, batteryPct: 80, online: true },
        { sensorId: 's2', measuredAt: T0, polledAt: T0, moisturePct: null, temperatureC: null, batteryPct: null, online: false },
      ]);
    });
  });

  it('links sequences to the service run that started them', () => {
    const run = db.$client.prepare(`INSERT INTO service_run (started_at, mode, dry_run, config_hash, config_json, heartbeat_at) VALUES (?, 'continuous', 0, 'h', '{}', ?)`).run(T0.toISOString(), T0.toISOString());
    new SqliteStore(db, { serviceRunId: Number(run.lastInsertRowid) }).sequenceStarted(sequence(), []);

    expect(db.select({ run: wateringSequence.serviceRunId }).from(wateringSequence).get()).toEqual({ run: Number(run.lastInsertRowid) });
  });
});
