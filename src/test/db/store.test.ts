import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingSequence } from '../../conductor/state.ts';
import type { SequenceZone } from '../../conductor/store.ts';
import type { WaterBudget } from '../../conductor/water-budget.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { InvalidDataError } from '../../db/model.ts';
import { NoMatchingRowError, parseZoneKey, SqliteStore } from '../../db/store.ts';
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
    db.prisma.sequenceWave.findMany({
      orderBy: [{ sequenceId: 'asc' }, { waveIndex: 'asc' }],
      select: { waveIndex: true, status: true, dueAt: true, sentAt: true, delivery: true, failedAttempts: true },
    });
  const ledger = () =>
    db.prisma.zoneWatering.findMany({ orderBy: { id: 'asc' }, select: { zoneKey: true, startedAt: true, minutes: true, waveIndex: true } });

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new SqliteStore(db);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    await db.close();
  });

  describe('parseZoneKey', () => {
    it.each([
      ['dev1:2', { deviceId: 'dev1', station: 2 }],
      ['a:b:c:12', { deviceId: 'a:b:c', station: 12 }],
    ])('%s', (key, parts) => expect(parseZoneKey(key)).toEqual(parts));

    it.each(['dev1', ':2', 'dev1:0', 'dev1:x', 'dev1:1.5'])('rejects %s', (key) => expect(() => parseZoneKey(key)).toThrow(/not a zone key/));
  });

  describe('zones', () => {
    it('registers configured zones and updates their names, keeping when they were first seen', async () => {
      await store.syncZones([zoneConfig({ name: 'Front' }), zoneConfig({ station: 2, name: 'Back' })], T0);
      await store.syncZones([zoneConfig({ name: 'Front lawn' })], T(60)); // Back removed from the config

      expect(await db.prisma.zone.findMany({ orderBy: { zoneKey: 'asc' } })).toEqual([
        { zoneKey: 'dev1:1', deviceId: 'dev1', station: 1, name: 'Front lawn', firstSeenAt: T0, lastSeenAt: T(60) },
        { zoneKey: 'dev1:2', deviceId: 'dev1', station: 2, name: 'Back', firstSeenAt: T0, lastSeenAt: T0 }, // kept: it has history
      ]);
    });
  });

  describe('the Sequencer steps', () => {
    it('saves a planned sequence: why each zone is in it, its waves and stations; the first wave is due', async () => {
      await store.sequenceStarted(sequence(), why);

      expect(await db.prisma.wateringSequence.findMany()).toEqual([
        { id: 'seq-1', serviceRunId: null, deviceId: 'dev1', soakMinutes: 30, createdAt: T0, status: 'active', endedAt: null, abandonReason: null },
      ]);
      expect(await db.prisma.sequenceZone.findMany({ orderBy: { zoneKey: 'asc' } })).toEqual([
        { sequenceId: 'seq-1', zoneKey: 'dev1:1', zoneName: 'Front', moisturePct: 22, readingAt: T(-5), thresholdPct: 30, targetPct: 40, requestedMinutes: 20, allowanceMinutes: 30, budgetInches: 0.5, budget, detail: 'Front below 30%' },
        { sequenceId: 'seq-1', zoneKey: 'dev1:2', zoneName: 'Back', moisturePct: null, readingAt: null, thresholdPct: 25, targetPct: 35, requestedMinutes: 5, allowanceMinutes: null, budgetInches: null, budget: null, detail: 'Back below 25%' },
      ]);
      expect(await waves()).toEqual([
        { waveIndex: 0, status: 'pending', dueAt: T0, sentAt: null, delivery: null, failedAttempts: 0 },
        { waveIndex: 1, status: 'pending', dueAt: null, sentAt: null, delivery: null, failedAttempts: 0 },
      ]);
      expect(await db.prisma.waveStation.findMany({ orderBy: [{ waveIndex: 'asc' }, { station: 'asc' }] })).toEqual([
        { sequenceId: 'seq-1', waveIndex: 0, station: 1, runMinutes: 10 },
        { sequenceId: 'seq-1', waveIndex: 0, station: 2, runMinutes: 5 },
        { sequenceId: 'seq-1', waveIndex: 1, station: 1, runMinutes: 10 },
      ]);
    });

    it('stores times as Date#toISOString() text, as they always were', async () => {
      await store.sequenceStarted(sequence({ createdAt: new Date('2026-07-01T11:00:00.5Z'), dueAt: new Date('2026-07-01T11:00:00.5Z') }), why);

      expect(db.sqlite.prepare('SELECT created_at, typeof(created_at) AS t FROM watering_sequence').get()).toEqual({ created_at: '2026-07-01T11:00:00.500Z', t: 'text' });
    });

    it('registers zones it has not seen (e.g. no reasons given), so history can refer to them', async () => {
      await store.sequenceStarted(sequence({ deviceId: 'dev9' }), []);

      expect(await db.prisma.zone.findMany({ orderBy: { zoneKey: 'asc' }, select: { zoneKey: true, name: true } })).toEqual([
        { zoneKey: 'dev9:1', name: 'zone 1' },
        { zoneKey: 'dev9:2', name: 'zone 2' },
      ]);
    });

    it('allows one active sequence per device, and saves nothing of one it refuses', async () => {
      await store.sequenceStarted(sequence(), why);

      await expect(store.sequenceStarted(sequence({ id: 'seq-2' }), why)).rejects.toThrow(/device dev1 already has an active watering sequence \(seq-1\)/);
      expect(await db.prisma.wateringSequence.findMany({ select: { id: true } })).toEqual([{ id: 'seq-1' }]);
      expect(await db.prisma.sequenceWave.count({ where: { sequenceId: 'seq-2' } })).toBe(0);

      await store.sequenceAbandoned(sequence(), T(5), 'switched off');
      await store.sequenceStarted(sequence({ id: 'seq-2' }), why); // the device is free again
      await store.sequenceStarted(sequence({ id: 'seq-3', deviceId: 'dev2' }), []); // another device never was blocked
    });

    it.each([
      ['a run longer than B-hyve accepts', sequence({ waves: [[{ station: 1, runTime: 241 }]] }), /at most 240 min/],
      ['an empty run', sequence({ waves: [[{ station: 1, runTime: 0 }]] }), /more than 0/],
      ['station 0', sequence({ waves: [[{ station: 0, runTime: 5 }]] }), /station must be a positive whole number/],
      ['a negative soak', sequence({ soakMinutes: -1 }), /soak must be 0 minutes or more/],
      ['an invalid start time', sequence({ createdAt: new Date(Number.NaN) }), /sequence start is not a valid time/],
    ])('refuses %s (what a CHECK constraint used to catch)', async (_, seq, message) => {
      await expect(store.sequenceStarted(seq, [])).rejects.toThrow(message);
      await expect(store.sequenceStarted(seq, [])).rejects.toBeInstanceOf(InvalidDataError);
      expect(await db.prisma.wateringSequence.count()).toBe(0);
    });

    it('refuses a zone reason without minutes', async () => {
      await expect(store.sequenceStarted(sequence(), [{ ...why[1], requestedMinutes: 0 } as SequenceZone])).rejects.toThrow(/requested minutes must be positive/);
    });

    it('follows a wave from sending to delivered, writing the ledger and scheduling the next wave', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);

      await store.waveSending(s, 0, T(1));
      expect((await waves())[0]).toMatchObject({ status: 'sending', sentAt: T(1) });
      await store.waveDelivered(s, 0, 'event', T(1), T(46));

      expect(await waves()).toEqual([
        { waveIndex: 0, status: 'delivered', dueAt: T0, sentAt: T(1), delivery: 'event', failedAttempts: 0 },
        { waveIndex: 1, status: 'pending', dueAt: T(46), sentAt: null, delivery: null, failedAttempts: 0 },
      ]);
      expect(await ledger()).toEqual([
        { zoneKey: 'dev1:1', startedAt: T(1), minutes: 10, waveIndex: 0 },
        { zoneKey: 'dev1:2', startedAt: T(1), minutes: 5, waveIndex: 0 },
      ]);
    });

    it('records a delivery even if marking the wave as sending was never saved', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);

      await store.waveDelivered(s, 0, 'unconfirmed', T(2), T(47));

      expect((await waves())[0]).toMatchObject({ status: 'delivered', sentAt: T(2), delivery: 'unconfirmed' });
    });

    it('never counts a wave twice', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);
      await store.waveDelivered(s, 0, 'event', T(1), T(46));

      await expect(store.waveDelivered(s, 0, 'event', T(1), T(46))).rejects.toThrow(NoMatchingRowError);
      expect(await ledger()).toHaveLength(2);
    });

    it('refuses an unknown delivery kind', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);

      await expect(store.waveDelivered(s, 0, 'guessed' as never, T(1), undefined)).rejects.toThrow(/delivery must be one of event, status, unconfirmed, assumed/);
    });

    it('counts failed attempts, and puts a wave that was being sent back to pending', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);

      await store.waveFailed(s, 0); // deferred
      await store.waveSending(s, 0, T(2));
      await store.waveFailed(s, 0); // send failed

      expect((await waves())[0]).toEqual({ waveIndex: 0, status: 'pending', dueAt: T0, sentAt: null, delivery: null, failedAttempts: 2 });
    });

    it.each([
      ['sending a wave of an unknown sequence', (st: SqliteStore) => st.waveSending(sequence({ id: 'nope' }), 0, T0)],
      ['sending a wave that is not pending', (st: SqliteStore) => st.waveSending(sequence(), 0, T0)],
      ['failing an unknown wave', (st: SqliteStore) => st.waveFailed(sequence(), 7)],
      ['delivering an unknown wave', (st: SqliteStore) => st.waveDelivered(sequence(), 7, 'event', T0, undefined)],
      ['completing an unknown sequence', (st: SqliteStore) => st.sequenceCompleted(sequence({ id: 'nope' }), T0)],
      ['abandoning an unknown sequence', (st: SqliteStore) => st.sequenceAbandoned(sequence({ id: 'nope' }), T0, 'x')],
    ])('refuses %s (a step that matches nothing is a bug)', async (_, step) => {
      await store.sequenceStarted(sequence({ id: 'seq-1' }), why);
      await store.waveSending(sequence(), 0, T0); // wave 0 is 'sending' now
      await expect(step(store)).rejects.toThrow(/no matching row/);
    });

    it('refuses to schedule a wave that does not exist, and then saves none of the delivery', async () => {
      const single = sequence({ id: 'single', waves: [[{ station: 1, runTime: 5 }]] });
      await store.sequenceStarted(single, why);

      await expect(store.waveDelivered(single, 0, 'event', T0, T(5))).rejects.toThrow(/scheduling single cycle 2: no matching row/);
      expect((await waves())[0]?.status).toBe('pending');
      expect(await ledger()).toEqual([]);
    });

    it('completes a sequence once', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);

      await store.sequenceCompleted(s, T(60));

      expect(await db.prisma.wateringSequence.findUnique({ where: { id: 'seq-1' }, select: { status: true, endedAt: true } })).toEqual({ status: 'completed', endedAt: T(60) });
      await expect(store.sequenceCompleted(s, T(61))).rejects.toThrow(/no matching row/);
    });

    it('abandons the rest of a sequence, keeping what was delivered', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);
      await store.waveDelivered(s, 0, 'status', T(1), T(46));

      await store.sequenceAbandoned(s, T(50), 'the device was switched off');

      expect(await db.prisma.wateringSequence.findUnique({ where: { id: 'seq-1' }, select: { status: true, abandonReason: true } })).toEqual({
        status: 'abandoned',
        abandonReason: 'the device was switched off',
      });
      expect((await waves()).map((w) => w.status)).toEqual(['delivered', 'skipped']);
      expect(await ledger()).toHaveLength(2);
    });

    it('keeps the ledger when an old sequence is deleted (retention), without its provenance', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);
      await store.waveDelivered(s, 0, 'event', T(1), T(46));
      await store.sequenceAbandoned(s, T(2), 'x');

      await db.prisma.wateringSequence.delete({ where: { id: 'seq-1' } });

      expect(await db.prisma.sequenceWave.count()).toBe(0); // cascaded
      expect(await db.prisma.zoneWatering.findMany({ select: { zoneKey: true, minutes: true, sequenceId: true, waveIndex: true } })).toEqual([
        { zoneKey: 'dev1:1', minutes: 10, sequenceId: null, waveIndex: null },
        { zoneKey: 'dev1:2', minutes: 5, sequenceId: null, waveIndex: null },
      ]);
    });
  });

  describe('loadState', () => {
    it('gives back unfinished sequences exactly as the Sequencer needs them', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);
      await store.waveDelivered(s, 0, 'event', T(1), T(46));
      await store.waveFailed(s, 1);
      await store.waveSending(s, 1, T(48));
      const other = sequence({ id: 'seq-2', deviceId: 'dev2', createdAt: T(5), dueAt: T(5) });
      await store.sequenceStarted(other, []);

      expect((await store.loadState(T(50), 0)).sequences).toEqual([
        { ...s, zoneNames: ['Front', 'Back'], nextWave: 1, dueAt: T(46), attempts: 1, inFlight: { wave: 1, since: T(48) } },
        { ...other }, // no zone names without reasons
      ]);
    });

    it('leaves out finished sequences', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);
      await store.sequenceAbandoned(s, T(1), 'x');

      expect((await store.loadState(T(2), 0)).sequences).toEqual([]);
    });

    it('closes a sequence that was fully delivered but never closed, so it cannot block its device', async () => {
      const s = sequence({ waves: [[{ station: 1, runTime: 5 }]] });
      await store.sequenceStarted(s, why);
      await store.waveDelivered(s, 0, 'event', T(1), undefined); // crash before sequenceCompleted

      expect((await store.loadState(T(10), 0, { repair: false })).sequences).toEqual([]);
      expect(await db.prisma.wateringSequence.findUnique({ where: { id: 'seq-1' }, select: { status: true } })).toEqual({ status: 'active' }); // a dry run writes nothing
      await store.loadState(T(10), 0);
      expect(await db.prisma.wateringSequence.findUnique({ where: { id: 'seq-1' }, select: { status: true, endedAt: true } })).toEqual({ status: 'completed', endedAt: T(10) });
      await store.sequenceStarted(sequence({ id: 'next' }), []); // the device is free again
    });

    it('treats a missing due time as the creation time, so resume() judges the wave late rather than never', async () => {
      await store.sequenceStarted(sequence(), why);
      await db.prisma.sequenceWave.updateMany({ where: { waveIndex: 0 }, data: { dueAt: null } });

      expect((await store.loadState(T(1), 0)).sequences[0]?.dueAt).toEqual(T0);
    });

    it('returns the ledger runs of the window (at least 24 h), in time order', async () => {
      const day = 24 * 60;
      await db.prisma.zone.create({ data: { zoneKey: 'dev1:1', deviceId: 'dev1', station: 1, name: 'Z', firstSeenAt: T0, lastSeenAt: T0 } });
      await db.prisma.zoneWatering.createMany({
        data: [
          { zoneKey: 'dev1:1', startedAt: T(-3 * day), minutes: 1 },
          { zoneKey: 'dev1:1', startedAt: T(-day), minutes: 2 }, // exactly 24 h before: kept (the cap query decides)
          { zoneKey: 'dev1:1', startedAt: T(-10), minutes: 3 },
        ],
      });

      expect((await store.loadState(T0, 0)).history.map((r) => r.minutes)).toEqual([2, 3]);
      expect((await store.loadState(T0, 4 * day * 60_000)).history.map((r) => r.minutes)).toEqual([1, 2, 3]);
      expect((await store.loadState(T0, 0)).history[0]).toEqual({ zoneKey: 'dev1:1', at: T(-day), minutes: 2 });
    });

    it('returns open alerts and zone spells', async () => {
      await store.saveAlerts({ 'battery:sensor:s1': { state: 'low', since: T0.toISOString() } });
      await store.saveZoneSpells([{ zoneKey: 'dev1:1', drySince: T0 }, { zoneKey: 'dev1:2', noDataSince: T(5) }], T(15));

      const state = await store.loadState(T(20), 0);

      expect(state.alerts).toEqual({ 'battery:sensor:s1': { state: 'low', since: T0.toISOString() } });
      expect(state.zoneSpells).toEqual([
        { zoneKey: 'dev1:1', drySince: T0, evaluatedAt: T(15) },
        { zoneKey: 'dev1:2', noDataSince: T(5), evaluatedAt: T(15) },
      ]);
    });

    it('is empty for a new database', async () => {
      expect(await store.loadState(T0, 0)).toEqual({ history: [], sequences: [], alerts: {}, zoneSpells: [] });
    });
  });

  describe('sequenceResults', () => {
    it('tells what each sequence planned and delivered, and when the water went off', async () => {
      const s = sequence();
      await store.sequenceStarted(s, why);
      await store.waveFailed(s, 0);
      await store.waveDelivered(s, 0, 'event', T(1), T(46));
      await store.waveDelivered(s, 1, 'assumed', T(46), undefined);
      await store.sequenceCompleted(s, T(56));
      const gone = sequence({ id: 'gone', deviceId: 'dev2' });
      await store.sequenceStarted(gone, []);
      await store.sequenceAbandoned(gone, T(3), 'switched off');

      expect(await store.sequenceResults()).toEqual([
        {
          id: 'gone',
          deviceId: 'dev2',
          createdAt: T0,
          status: 'abandoned',
          endedAt: T(3),
          abandonReason: 'switched off',
          cycles: 2,
          cyclesDelivered: 0,
          plannedMinutes: 25,
          deliveredMinutes: 0,
          uncertainStationRuns: 0,
          failedAttempts: 0,
          waterOffAt: null,
        },
        {
          id: 'seq-1',
          deviceId: 'dev1',
          createdAt: T0,
          status: 'completed',
          endedAt: T(56),
          abandonReason: null,
          cycles: 2,
          cyclesDelivered: 2,
          plannedMinutes: 25,
          deliveredMinutes: 25,
          uncertainStationRuns: 1,
          failedAttempts: 1,
          waterOffAt: T(56), // cycle 2: sent at 46 + 10 minutes
        },
      ]);
    });
  });

  describe('the Monitor steps', () => {
    it('replaces the open alerts, all or nothing, and derives their kind', async () => {
      await store.saveAlerts({ 'device:d1': { state: 'offline', since: T0.toISOString() }, 'battery:sensor:s1': { state: 'low', since: T0.toISOString() } });
      await store.saveAlerts({ 'device:d1': { state: 'offline', since: T0.toISOString() }, 'daily-limit:dev1:2': { state: 'reached', since: T0.toISOString() } });
      expect(await db.prisma.openAlert.findMany({ orderBy: { alertKey: 'asc' }, select: { alertKey: true, kind: true } })).toEqual([
        { alertKey: 'daily-limit:dev1:2', kind: 'daily-limit' },
        { alertKey: 'device:d1', kind: 'device' },
      ]);

      await expect(store.saveAlerts({ 'mystery:x': { state: 'low', since: T0.toISOString() } })).rejects.toThrow(/kind of alert "mystery:x" must be one of/);
      await expect(store.saveAlerts({ 'device:x': { state: 'dead', since: T0.toISOString() } })).rejects.toThrow(/state of alert device:x must be one of low, high, offline, reached/);
      await expect(store.saveAlerts({ 'device:x': { state: 'low', since: 'yesterday' } })).rejects.toThrow(/start of alert device:x is not a valid time/);
      expect(await db.prisma.openAlert.count()).toBe(2); // unchanged

      await store.saveAlerts({});
      expect(await db.prisma.openAlert.count()).toBe(0);
    });

    it('upserts zone spells, clearing what has ended', async () => {
      await store.saveZoneSpells([{ zoneKey: 'dev1:1', drySince: T0, noDataSince: T0 }], T0);
      await store.saveZoneSpells([{ zoneKey: 'dev1:1' }], T(15));
      await store.saveZoneSpells([], T(30)); // nothing to do

      expect(await db.prisma.zoneState.findMany()).toEqual([{ zoneKey: 'dev1:1', drySince: null, noDataSince: null, evaluatedAt: T(15) }]);
    });

    it('saves each sensor reading once, keeping raw values and skipping ones it cannot place in time', async () => {
      const r = reading('s1', 42.5, { at: T0, batteryPct: 80, temperatureC: 19.5 });
      await store.recordReadings([r, reading('s2', Number.NaN, { at: T0, online: false }), reading('s3', 30, { at: new Date(Number.NaN) })], T0);
      await store.recordReadings([r], T(15)); // polled again, the sensor hasn't reported since
      await store.recordReadings([], T(30));

      expect(await db.prisma.sensorReading.findMany({ orderBy: { sensorId: 'asc' } })).toEqual([
        { sensorId: 's1', measuredAt: T0, polledAt: T0, moisturePct: 42.5, temperatureC: 19.5, batteryPct: 80, online: true },
        { sensorId: 's2', measuredAt: T0, polledAt: T0, moisturePct: null, temperatureC: null, batteryPct: null, online: false },
      ]);
    });
  });

  it('links sequences to the service run that started them', async () => {
    const run = await db.prisma.serviceRun.create({
      data: { startedAt: T0, mode: 'continuous', dryRun: false, configHash: 'h', config: {}, heartbeatAt: T0 },
      select: { id: true },
    });
    await new SqliteStore(db, { serviceRunId: run.id }).sequenceStarted(sequence(), []);

    expect(await db.prisma.wateringSequence.findFirst({ select: { serviceRunId: true } })).toEqual({ serviceRunId: run.id });
  });
});
