import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BhyveDevice } from '../../bhyve/types.ts';
import type { ConductorConfig, ZoneConfig } from '../../conductor/config.ts';
import { WateringHistory } from '../../conductor/history.ts';
import { Monitor, POLL_DEADLINE_MS } from '../../conductor/monitor.ts';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { PendingSequence } from '../../conductor/state.ts';
import type { ConductorStore, SavedZoneSpell } from '../../conductor/store.ts';
import { openDatabase } from '../../db/database.ts';
import { SqliteStore } from '../../db/store.ts';
import { log } from '../../log.ts';
import type { MoistureReading } from '../../sensors/types.ts';
import type { Forecast, ForecastHour, WeatherProvider } from '../../weather/types.ts';
import { flush } from '../utils/fetch.ts';
import { bhyveDevice, minutesAgo, NOW, reading, zone } from '../utils/conductor.ts';
import { fakeBhyve } from '../utils/fake-bhyve.ts';

/** Event types other than zone.decision (tested on its own). */
const nonDecisionTypes = (audit: MemoryAuditLog) => audit.events.map((e) => e.type).filter((t) => t !== 'zone.decision');

const config = (zones: ZoneConfig[], overrides: Partial<ConductorConfig> = {}): ConductorConfig => ({
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  // No waiting for acknowledgements that the fake device sends synchronously anyway.
  recovery: { confirmTimeoutSeconds: 0, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  // Periodic controller checks off, so B-hyve is only contacted when watering (tests enable it explicitly).
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 0 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones,
  ...overrides,
});

/** Test double for the sensors + B-hyve, with a controllable clock. */
const setup = (
  cfg: ConductorConfig,
  opts: {
    history?: WateringHistory;
    store?: ConductorStore;
    weather?: WeatherProvider;
    audit?: MemoryAuditLog;
    pendingSequences?: PendingSequence[];
    zoneSpells?: SavedZoneSpell[];
    heartbeat?: () => void;
    /** When the monitor is created (default NOW). */
    start?: Date;
  } = {},
) => {
  let readings: MoistureReading[] = [];
  let now = opts.start ?? NOW;

  const source = { id: 'fake', read: vi.fn(async () => readings) };
  const fake = fakeBhyve([bhyveDevice('dev1'), bhyveDevice('dev2')]);
  const bhyve = fake.bhyve;
  const history = opts.history ?? new WateringHistory();
  const monitor = new Monitor({
    config: cfg,
    source,
    bhyve: fake.control,
    history,
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.weather ? { weather: opts.weather } : {}),
    ...(opts.audit ? { audit: opts.audit } : {}),
    ...(opts.pendingSequences ? { pendingSequences: opts.pendingSequences } : {}),
    ...(opts.zoneSpells ? { zoneSpells: opts.zoneSpells } : {}),
    ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}),
    now: () => now,
  });

  return {
    monitor,
    source,
    bhyve,
    history,
    now: () => now,
    setReadings: (...rs: MoistureReading[]) => {
      readings = rs;
    },
    setDevices: (...ds: BhyveDevice[]) => fake.setDevices(...ds),
    /** Move the clock forward; readings are re-stamped so they stay fresh. */
    advance: (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60_000);
      readings = readings.map((r) => ({ ...r, at: now }));
    },
  };
};

/** A real database and the store over it. */
const sqlite = (path = ':memory:') => {
  const db = openDatabase(path);
  const store = new SqliteStore(db);
  /** What the next start would load. */
  const load = (at: Date = NOW) => store.loadState(at, 0);
  /** Rows in the tables a dry run must leave alone. */
  const operationalRows = async (): Promise<number> => {
    const { prisma } = db;
    const counts = await prisma.$transaction([
      prisma.wateringSequence.count(),
      prisma.zoneWatering.count(),
      prisma.sensorReading.count(),
      prisma.zoneState.count(),
      prisma.openAlert.count(),
      prisma.zone.count(),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  };
  return { db, store, load, operationalRows };
};

describe('Monitor.runCycle', () => {
  let info: MockInstance<typeof log.info>;
  let warn: MockInstance<typeof log.warn>;
  let error: MockInstance<typeof log.error>;

  beforeEach(() => {
    info = vi.spyOn(log, 'info').mockImplementation(() => {});
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    error = vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  it('does not touch B-hyve when every zone is moist enough', async () => {
    const t = setup(config([zone({ sensorIds: ['s1'] })]));
    t.setReadings(reading('s1', 45));

    const result = await t.monitor.runCycle();

    expect(result.decisions.map((d) => d.reason)).toEqual(['moist']);
    expect(result.sent).toEqual([]);
    expect(t.bhyve.getDevices).not.toHaveBeenCalled();
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
  });

  it('waters a dry zone and records the run', async () => {
    const { store, load } = sqlite();
    const t = setup(config([zone({ station: 2, runMinutes: 12 })]), { store });
    t.setReadings(reading('s1', 18));

    const result = await t.monitor.runCycle();

    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 2, runTime: 12 }]);
    expect(result.sent).toHaveLength(1);
    expect(t.history.runs).toEqual([{ zoneKey: 'dev1:2', at: NOW, minutes: 12 }]);
    // Saved: the run in the ledger, the sequence completed (the in-flight save is checked in sequencer.test.ts).
    expect((await load(NOW)).history).toEqual([{ zoneKey: 'dev1:2', at: NOW, minutes: 12 }]);
    expect((await load(NOW)).sequences).toEqual([]);
    expect(await store.sequenceResults()).toEqual([expect.objectContaining({ status: 'completed', deliveredMinutes: 12 })]);
    expect(info).toHaveBeenCalledWith('Watering device dev1 (the run): station 2 for 12 min');
  });

  it('waters only the dry zones, combining zones of the same device into one command', async () => {
    const t = setup(
      config([
        zone({ deviceId: 'dev1', station: 1, sensorIds: ['a'] }),
        zone({ deviceId: 'dev1', station: 2, sensorIds: ['b'] }),
        zone({ deviceId: 'dev1', station: 3, sensorIds: ['c'] }),
        zone({ deviceId: 'dev2', station: 1, sensorIds: ['d'] }),
      ]),
    );
    t.setReadings(reading('a', 10), reading('b', 60), reading('c', 20), reading('d', 5));

    await t.monitor.runCycle();

    expect(t.bhyve.getDevices).toHaveBeenCalledOnce();
    expect(t.bhyve.startWatering.mock.calls).toEqual([
      [
        'dev1',
        [
          { station: 1, runTime: 10 },
          { station: 3, runTime: 10 },
        ],
      ],
      ['dev2', [{ station: 1, runTime: 10 }]],
    ]);
    expect(t.history.runs.map((r) => r.zoneKey).sort()).toEqual(['dev1:1', 'dev1:3', 'dev2:1']);
  });

  it('does not water again during the cooldown, then does once it has passed', async () => {
    const t = setup(config([zone({ cooldownMinutes: 240, maxMinutesPerDay: 100 })]));
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle();
    t.advance(15);
    const second = await t.monitor.runCycle();
    t.advance(240 - 15);
    await t.monitor.runCycle();

    expect(second.decisions[0]?.reason).toBe('cooldown');
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
  });

  it('stops at the daily limit even if the soil stays dry', async () => {
    const t = setup(config([zone({ cooldownMinutes: 60, runMinutes: 10, maxMinutesPerDay: 25 })]));
    t.setReadings(reading('s1', 10));

    for (let i = 0; i < 6; i++) {
      await t.monitor.runCycle();
      t.advance(60);
    }

    const runTimes = t.bhyve.startWatering.mock.calls.map(([, runs]) => runs[0]?.runTime);
    expect(runTimes).toEqual([10, 10, 5]);
  });

  it('remembers the cooldown across a restart via the database file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'conductor-monitor-'));
    try {
      const cfg = config([zone()]);
      const before = sqlite(join(dir, 'conductor.db'));
      const first = setup(cfg, { history: new WateringHistory((await before.load()).history), store: before.store });
      first.setReadings(reading('s1', 10));
      await first.monitor.runCycle();
      await before.db.close(); // the process ends

      const after = sqlite(join(dir, 'conductor.db'));
      const restarted = setup(cfg, { history: new WateringHistory((await after.load()).history), store: after.store });
      restarted.setReadings(reading('s1', 10));
      const result = await restarted.monitor.runCycle();
      await after.db.close();

      expect(first.bhyve.startWatering).toHaveBeenCalledOnce();
      expect(restarted.bhyve.startWatering).not.toHaveBeenCalled();
      expect(result.decisions[0]?.reason).toBe('cooldown');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('respects the device state reported by B-hyve', async () => {
    const t = setup(config([zone()]));
    t.setReadings(reading('s1', 10));
    t.setDevices(bhyveDevice('dev1', { status: { run_mode: 'auto', rain_delay: 48 } }));

    const result = await t.monitor.runCycle();

    expect(result.decisions[0]).toMatchObject({ action: 'skip', reason: 'rain-delay' });
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
    expect(t.history.runs).toEqual([]);
  });

  it('in dry-run mode, reports what it would do but sends and records nothing', async () => {
    const { store, operationalRows } = sqlite();
    const t = setup(config([zone()], { dryRun: true }), { store });
    t.setReadings(reading('s1', 10));

    const result = await t.monitor.runCycle();

    expect(result.sent).toEqual([expect.objectContaining({ deviceId: 'dev1', waves: [[{ station: 1, runTime: 10 }]] })]);
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
    expect(t.history.runs).toEqual([]);
    expect(await operationalRows()).toBe(0);
    expect(info).toHaveBeenCalledWith('[dry run] would water device dev1: station 1 for 10 min');
  });

  it('keeps going when one device rejects the command, and does not record the failed run', async () => {
    const t = setup(config([zone({ deviceId: 'dev1', sensorIds: ['a'] }), zone({ deviceId: 'dev2', sensorIds: ['b'] })]));
    t.setReadings(reading('a', 10), reading('b', 10));
    const boom = new Error('socket down');
    t.bhyve.startWatering.mockRejectedValueOnce(boom);

    const result = await t.monitor.runCycle();

    expect(result.failed).toEqual([{ command: expect.objectContaining({ deviceId: 'dev1' }), error: expect.any(Error) }]);
    expect(result.sent.map((c) => c.deviceId)).toEqual(['dev2']);
    expect(t.history.runs.map((r) => r.zoneKey)).toEqual(['dev2:1']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dev1'), boom);
  });

  it("leaves a failed start to the sequencer's retries instead of planning it again next poll", async () => {
    const t = setup(config([zone({ cooldownMinutes: 0 })]));
    t.setReadings(reading('s1', 10));
    t.bhyve.startWatering.mockRejectedValueOnce(new Error('socket down'));

    const first = await t.monitor.runCycle();
    t.advance(15);
    const second = await t.monitor.runCycle();

    expect(first.failed).toHaveLength(1);
    expect(second.decisions[0]).toMatchObject({ action: 'skip', reason: 'soaking' });
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1); // the retry is on a back-off timer (see sequencer tests)
    expect(t.history.runs).toEqual([]);
  });

  it('fails the cycle without watering when B-hyve devices cannot be read', async () => {
    const t = setup(config([zone()]));
    t.setReadings(reading('s1', 10));
    t.bhyve.getDevices.mockRejectedValueOnce(new Error('HTTP 500'));

    await expect(t.monitor.runCycle()).rejects.toThrow('HTTP 500');
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
  });

  it('fails the cycle when the sensors cannot be read', async () => {
    const t = setup(config([zone()]));
    t.source.read.mockRejectedValueOnce(new Error('tuya down'));

    await expect(t.monitor.runCycle()).rejects.toThrow('tuya down');
  });

  it('still waters, and reports it once, when the database cannot be written', async () => {
    const { store, db } = sqlite();
    const audit = new MemoryAuditLog(() => NOW);
    const t = setup(config([zone()]), { store, audit });
    db.sqlite.exec('PRAGMA query_only = ON'); // like a full or read-only disk
    t.setReadings(reading('s1', 10));

    const result = await t.monitor.runCycle();

    expect(result.sent).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not save recordReadings; will retry'), expect.any(Error));
    expect(audit.ofType('state.save_failed')).toEqual([expect.objectContaining({ step: 'recordReadings' })]);
  });

  it('keeps only the runs cooldowns and the daily cap can need in memory', async () => {
    const history = new WateringHistory([{ zoneKey: 'dev1:1', at: minutesAgo(3 * 24 * 60), minutes: 10 }]);
    const t = setup(config([zone()]), { history, store: sqlite().store });
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle();

    expect(history.runs).toEqual([{ zoneKey: 'dev1:1', at: NOW, minutes: 10 }]);
  });

  it('logs zones that cannot be evaluated as warnings and normal outcomes as info', async () => {
    const t = setup(
      config([
        zone({ name: 'Front', station: 1, sensorIds: ['a'] }),
        zone({ name: 'Back', station: 2, sensorIds: ['missing'] }),
      ]),
    );
    t.setReadings(reading('a', 50));

    await t.monitor.runCycle();

    expect(info).toHaveBeenCalledWith('Front [dev1:1]: moist: Sensor a at 50% (threshold 30%)');
    expect(warn).toHaveBeenCalledWith('Back [dev1:2]: no-data: no usable readings (missing: no reading)');
  });
});

describe('Monitor polling loop', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const INTERVAL_MS = 15 * 60_000;

  it('polls immediately and then every interval', async () => {
    const t = setup(config([zone()]));
    t.setReadings(reading('s1', 50));

    t.monitor.start();
    await flush();
    expect(t.source.read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL_MS - 1);
    await flush();
    expect(t.source.read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await flush();
    expect(t.source.read).toHaveBeenCalledTimes(2);

    await t.monitor.stop();
  });

  it('ignores a second start()', async () => {
    const t = setup(config([zone()]));

    t.monitor.start();
    t.monitor.start();
    await flush();

    expect(t.source.read).toHaveBeenCalledTimes(1);
    await t.monitor.stop();
  });

  it('keeps polling after a failed cycle', async () => {
    const t = setup(config([zone()]));
    t.source.read.mockRejectedValueOnce(new Error('tuya down'));

    t.monitor.start();
    await flush();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('cycle failed'), expect.any(Error));

    vi.advanceTimersByTime(INTERVAL_MS);
    await flush();
    expect(t.source.read).toHaveBeenCalledTimes(2);

    await t.monitor.stop();
  });

  it('waits for a slow cycle to finish before scheduling the next one', async () => {
    const t = setup(config([zone()]));
    let finish!: () => void;
    t.source.read.mockImplementationOnce(
      () =>
        new Promise<MoistureReading[]>((resolve) => {
          finish = () => resolve([]);
        }),
    );

    t.monitor.start();
    await flush();
    vi.advanceTimersByTime(3 * INTERVAL_MS);
    await flush();
    expect(t.source.read).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    vi.advanceTimersByTime(INTERVAL_MS);
    await flush();
    expect(t.source.read).toHaveBeenCalledTimes(2);

    await t.monitor.stop();
  });

  it('stop() waits for the running cycle and prevents further polls', async () => {
    const t = setup(config([zone()]));
    let finish!: () => void;
    t.source.read.mockImplementationOnce(
      () =>
        new Promise<MoistureReading[]>((resolve) => {
          finish = () => resolve([]);
        }),
    );
    t.monitor.start();
    await flush();

    let stopped = false;
    const stopping = t.monitor.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    finish();
    await stopping;
    vi.advanceTimersByTime(10 * INTERVAL_MS);
    await flush();

    expect(t.source.read).toHaveBeenCalledTimes(1);
  });

  it('can be stopped before it ever started', async () => {
    const t = setup(config([zone()]));

    await expect(t.monitor.stop()).resolves.toBeUndefined();
  });
});

describe('Monitor cycle-and-soak sequences', () => {
  const MINUTE_MS = 60_000;
  let info: MockInstance<typeof log.info>;
  let warn: MockInstance<typeof log.warn>;
  let error: MockInstance<typeof log.error>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    info = vi.spyOn(log, 'info').mockImplementation(() => {});
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    error = vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 35 min of watering split into 11.7 + 11.7 + 11.6, 30 min of soaking in between.
  const cyclingZone = () => zone({ runMinutes: 35, maxCycleMinutes: 15, soakMinutes: 30, maxMinutesPerDay: 60 });
  const waveGap = (waveMinutes: number) => (waveMinutes + 30) * MINUTE_MS;

  it('sends the first cycle at once and the rest after run time plus soak', async () => {
    const t = setup(config([cyclingZone()]));
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle();
    expect(t.bhyve.startWatering.mock.calls).toEqual([['dev1', [{ station: 1, runTime: 11.7 }]]]);

    vi.advanceTimersByTime(waveGap(11.7) - 1);
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
    expect(t.bhyve.startWatering).toHaveBeenLastCalledWith('dev1', [{ station: 1, runTime: 11.7 }]);

    vi.advanceTimersByTime(waveGap(11.7));
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(3);
    expect(t.bhyve.startWatering).toHaveBeenLastCalledWith('dev1', [{ station: 1, runTime: 11.6 }]);
    expect(info).toHaveBeenCalledWith('Watering device dev1 (cycle 3/3): station 1 for 11.6 min');

    // no further cycles
    vi.advanceTimersByTime(10 * waveGap(11.7));
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(3);
  });

  it('records each cycle in the history as it is sent, adding up to the planned total', async () => {
    const { store, load } = sqlite();
    const t = setup(config([cyclingZone()]), { store });
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle();
    t.advance(waveGap(11.7) / MINUTE_MS);
    vi.advanceTimersByTime(waveGap(11.7));
    await flush();

    expect(t.history.runs).toEqual([
      { zoneKey: 'dev1:1', at: NOW, minutes: 11.7 },
      { zoneKey: 'dev1:1', at: new Date(NOW.getTime() + waveGap(11.7)), minutes: 11.7 },
    ]);
    expect(t.history.minutesInLastDay('dev1:1', t.now())).toBeCloseTo(23.4);
    // the pending sequence is saved along with the history, ready to resume after a restart
    const saved = await load(t.now());
    expect(saved.sequences).toEqual([expect.objectContaining({ deviceId: 'dev1', nextWave: 2, attempts: 0 })]);
    expect(saved.history).toEqual(t.history.runs);
  });

  it('does not start a new run for a device that is still soaking', async () => {
    // cooldown off, so the soaking guard is what's being exercised
    const t = setup(config([{ ...cyclingZone(), cooldownMinutes: 0 }]));
    t.setReadings(reading('s1', 10));
    await t.monitor.runCycle();

    t.advance(15); // mid-soak; the device itself reports idle
    const second = await t.monitor.runCycle();

    expect(second.decisions[0]).toMatchObject({ action: 'skip', reason: 'soaking' });
    expect(second.decisions[0]?.detail).toContain('a watering sequence is still in progress (cycle 2/3)');
    expect(t.bhyve.getDevices).toHaveBeenCalledTimes(1); // the soaking skip needs no device fetch
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
  });

  it('waters zones of one device in waves, and other devices independently', async () => {
    const t = setup(
      config([
        cyclingZone(),
        zone({ station: 2, sensorIds: ['s2'], runMinutes: 20, maxCycleMinutes: 10, soakMinutes: 45, maxMinutesPerDay: 60 }),
        zone({ deviceId: 'dev2', sensorIds: ['s3'], runMinutes: 5, maxCycleMinutes: 15 }),
      ]),
    );
    t.setReadings(reading('s1', 10), reading('s2', 10), reading('s3', 10));

    await t.monitor.runCycle();

    expect(t.bhyve.startWatering.mock.calls).toEqual([
      [
        'dev1',
        [
          { station: 1, runTime: 11.7 },
          { station: 2, runTime: 10 },
        ],
      ],
      ['dev2', [{ station: 1, runTime: 5 }]],
    ]);

    // next dev1 wave after the 21.7 min wave plus the longest soak of its zones (45 min)
    vi.advanceTimersByTime((11.7 + 10 + 45) * MINUTE_MS - 1);
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(3);
    expect(t.bhyve.startWatering).toHaveBeenLastCalledWith('dev1', [
      { station: 1, runTime: 11.7 },
      { station: 2, runTime: 10 },
    ]);
  });

  it('retries a cycle that fails to send, then carries on with the sequence', async () => {
    const t = setup(config([cyclingZone()]));
    t.setReadings(reading('s1', 10));
    await t.monitor.runCycle();
    t.bhyve.startWatering.mockRejectedValueOnce(new Error('socket down'));

    vi.advanceTimersByTime(waveGap(11.7));
    await flush();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cycle 2/3'), expect.any(Error));
    expect(t.history.runs).toHaveLength(1);

    vi.advanceTimersByTime(60_000); // first retry after 1 min
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(3); // wave 1, failed wave 2, retried wave 2
    expect(t.history.runs).toHaveLength(2);

    vi.advanceTimersByTime(waveGap(11.7));
    await flush();
    expect(t.history.runs.map((r) => r.minutes)).toEqual([11.7, 11.7, 11.6]);
    await expect(t.monitor.drain()).resolves.toBeUndefined(); // sequence is over
  });

  it('stop() pauses pending cycles, keeping them saved to resume on restart', async () => {
    const { store, load } = sqlite();
    const t = setup(config([cyclingZone()]), { store });
    t.setReadings(reading('s1', 10));
    await t.monitor.runCycle();

    await t.monitor.stop();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 unfinished watering sequence(s) (dev1); they resume on restart'));
    expect((await load(t.now())).sequences).toEqual([expect.objectContaining({ nextWave: 1 })]);
    vi.advanceTimersByTime(10 * waveGap(11.7));
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
  });

  it('drain() resolves once the last cycle of every device has been sent', async () => {
    const t = setup(config([cyclingZone()]));
    t.setReadings(reading('s1', 10));
    await t.monitor.runCycle();

    let drained = false;
    void t.monitor.drain().then(() => {
      drained = true;
    });

    vi.advanceTimersByTime(waveGap(11.7));
    await flush();
    expect(drained).toBe(false);

    vi.advanceTimersByTime(waveGap(11.7));
    await flush();
    expect(drained).toBe(true);
  });

  it('drain() resolves immediately when nothing is pending', async () => {
    const t = setup(config([zone()]));

    await expect(t.monitor.drain()).resolves.toBeUndefined();
  });

  it('leaves runs within maxCycleMinutes as a single command', async () => {
    const t = setup(config([zone({ runMinutes: 12, maxCycleMinutes: 20 })]));
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle();

    expect(t.bhyve.startWatering.mock.calls).toEqual([['dev1', [{ station: 1, runTime: 12 }]]]);
    vi.advanceTimersByTime(100 * MINUTE_MS);
    await flush();
    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Watering device dev1 (the run): station 1 for 12 min');
  });

  it('describes the cycles in dry-run mode', async () => {
    const t = setup(config([cyclingZone()], { dryRun: true }));
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle();

    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      '[dry run] would water device dev1 (30 min soak between cycles): ' +
        'cycle 1: station 1 for 11.7 min; cycle 2: station 1 for 11.7 min; cycle 3: station 1 for 11.6 min',
    );
    vi.advanceTimersByTime(100 * MINUTE_MS);
    await flush();
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
  });
});

describe('Monitor with a weather forecast', () => {
  let info: MockInstance<typeof log.info>;
  let warn: MockInstance<typeof log.warn>;

  beforeEach(() => {
    info = vi.spyOn(log, 'info').mockImplementation(() => {});
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  const HOUR_MS = 3_600_000;
  /**
   * A forecast relative to each request: 0.01in/h of crop use, plus `rainInches` falling in the hour
   * ending `rainInHours` after the request (so "rain in 2 hours" can keep slipping, like a bad forecast).
   */
  const fakeWeather = (opts: { rainInHours?: number; rainInches?: number } = {}) => ({
    getForecast: vi.fn(async (from: Date, hours: number): Promise<Forecast> => ({
      location: { latitude: 30, longitude: -97 },
      timeZone: 'America/Chicago',
      fetchedAt: from,
      hours: Array.from({ length: hours }, (_, i): ForecastHour => ({
        end: new Date(from.getTime() + (i + 1) * HOUR_MS),
        et0Mm: 0.254,
        precipMm: opts.rainInHours === i + 1 ? (opts.rainInches ?? 0) * 25.4 : 0,
      })),
    })),
  });
  // 10in root zone, crop coefficient 1, 1in/h sprinklers → 1% = 0.1in = 6 min. See water-budget.test.ts.
  const forecastZone = (overrides: Partial<ZoneConfig> = {}) =>
    zone({
      rootDepthIn: 10,
      cropCoefficient: 1,
      rainEfficiency: 1,
      precipRateInPerHour: 1,
      maxMinutesPerDay: 240,
      cooldownMinutes: 0,
      ...overrides,
    });

  it('does not fetch the forecast or programs when no zone needs water', async () => {
    const weather = fakeWeather();
    const t = setup(config([forecastZone()]), { weather });
    t.setReadings(reading('s1', 45));

    await t.monitor.runCycle();

    expect(weather.getForecast).not.toHaveBeenCalled();
    expect(t.bhyve.getPrograms).not.toHaveBeenCalled();
  });

  it('waters the forecast-based amount instead of the fixed run length', async () => {
    const weather = fakeWeather();
    const t = setup(config([forecastZone()], { forecastHours: 48 }), { weather });
    t.setReadings(reading('s1', 25));

    const result = await t.monitor.runCycle();

    expect(weather.getForecast).toHaveBeenCalledWith(NOW, 48);
    // 25% → 40% target = 1.5in at 1in/h
    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 1, runTime: 90 }]);
    expect(t.history.runs).toEqual([{ zoneKey: 'dev1:1', at: NOW, minutes: 90 }]);
    expect(result.decisions[0]?.detail).toContain('apply 1.5in (90 min), refills to target');
  });

  it('still respects the daily limit', async () => {
    const t = setup(config([forecastZone({ maxMinutesPerDay: 30 })]), { weather: fakeWeather() });
    t.setReadings(reading('s1', 25));

    await t.monitor.runCycle();

    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 1, runTime: 30 }]);
  });

  it('subtracts water the B-hyve schedule will apply', async () => {
    const t = setup(config([forecastZone()]), { weather: fakeWeather() });
    t.setReadings(reading('s1', 25));
    // Thursdays at 01:00 Chicago (06:00Z, 18h after NOW), 30 min = 0.5in on station 1.
    t.bhyve.getPrograms.mockResolvedValueOnce([
      {
        id: 'p',
        device_id: 'dev1',
        name: 'Night',
        enabled: true,
        frequency: { type: 'days', days: [4] },
        start_times: ['01:00'],
        run_times: [{ station: 1, run_time: 30 }],
      },
    ]);

    await t.monitor.runCycle();

    // Peak without watering: 2.5 − 0.18 + 0.5 = 2.82 → refill 1.18in = 71 min (instead of 90).
    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 1, runTime: 71 }]);
  });

  it('does not water when rain will restore the soil soon', async () => {
    const t = setup(config([forecastZone()]), { weather: fakeWeather({ rainInHours: 2, rainInches: 0.5 }) });
    t.setReadings(reading('s1', 29));

    const result = await t.monitor.runCycle();

    expect(result.decisions[0]).toMatchObject({ action: 'none', reason: 'forecast-covered' });
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
    expect(t.history.runs).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('forecast-covered'));
  });

  it('stops waiting for rain that keeps not arriving, within maxWaitHours in total', async () => {
    // The forecast always says "rain in 2 hours"; the soil stays dry.
    const t = setup(config([forecastZone({ maxWaitHours: 6 })]), { weather: fakeWeather({ rainInHours: 2, rainInches: 0.5 }) });
    t.setReadings(reading('s1', 29));

    const reasons: string[] = [];
    for (let hour = 0; hour <= 5; hour++) {
      const r = await t.monitor.runCycle();
      reasons.push(r.decisions[0]?.reason ?? '');
      t.advance(60);
    }

    // At 4h waited, rain in 2h still fits the 6h budget; at 5h it would not, so it waters.
    expect(reasons).toEqual(['forecast-covered', 'forecast-covered', 'forecast-covered', 'forecast-covered', 'forecast-covered', 'dry']);
    expect(t.bhyve.startWatering).toHaveBeenCalledOnce();
  });

  it('starts the wait over after the soil recovers', async () => {
    const t = setup(config([forecastZone({ maxWaitHours: 6 })]), { weather: fakeWeather({ rainInHours: 2, rainInches: 0.5 }) });
    t.setReadings(reading('s1', 29));
    await t.monitor.runCycle();
    t.advance(5 * 60);
    t.setReadings(reading('s1', 35, { at: t.now() })); // it rained
    await t.monitor.runCycle();

    t.advance(60);
    t.setReadings(reading('s1', 29, { at: t.now() })); // dry again: a fresh 6h wait
    const r = await t.monitor.runCycle();

    expect(r.decisions[0]?.reason).toBe('forecast-covered');
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
  });

  it('keeps counting the wait through cycles without sensor data', async () => {
    const t = setup(config([forecastZone({ maxWaitHours: 6 })]), { weather: fakeWeather({ rainInHours: 2, rainInches: 0.5 }) });
    t.setReadings(reading('s1', 29));
    await t.monitor.runCycle();

    t.advance(6 * 60);
    t.setReadings(); // sensor silent for a while
    await t.monitor.runCycle();
    t.setReadings(reading('s1', 29, { at: t.now() }));
    const r = await t.monitor.runCycle();

    expect(r.decisions[0]?.reason).toBe('dry');
  });

  it('falls back to the fixed run length when the forecast is unavailable', async () => {
    const weather = fakeWeather();
    weather.getForecast.mockRejectedValueOnce(new Error('HTTP 503'));
    const t = setup(config([forecastZone({ runMinutes: 12 })]), { weather });
    t.setReadings(reading('s1', 25));

    await t.monitor.runCycle();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using fixed run lengths'), expect.any(Error));
    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 1, runTime: 12 }]);
  });

  it('falls back to the fixed run length when the B-hyve programs cannot be read', async () => {
    const t = setup(config([forecastZone({ runMinutes: 12 })]), { weather: fakeWeather() });
    t.setReadings(reading('s1', 25));
    t.bhyve.getPrograms.mockRejectedValueOnce(new Error('HTTP 500'));

    await t.monitor.runCycle();

    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 1, runTime: 12 }]);
  });

  it('logs programs it could not interpret', async () => {
    const t = setup(config([forecastZone()]), { weather: fakeWeather() });
    t.setReadings(reading('s1', 25));
    t.bhyve.getPrograms.mockResolvedValueOnce([
      { id: 'p', device_id: 'dev1', name: 'Odd one', frequency: { type: 'lunar' }, start_times: ['06:00'], run_times: [] },
    ]);

    await t.monitor.runCycle();

    expect(warn).toHaveBeenCalledWith('Skipping Odd one on Timer dev1: unsupported frequency type "lunar"');
  });

  it('still applies device checks after the forecast', async () => {
    const t = setup(config([forecastZone()]), { weather: fakeWeather() });
    t.setReadings(reading('s1', 25));
    t.setDevices(bhyveDevice('dev1', { status: { run_mode: 'auto', rain_delay: 24 } }));

    const r = await t.monitor.runCycle();

    expect(r.decisions[0]).toMatchObject({ action: 'skip', reason: 'rain-delay' });
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
  });
  it('saves why it watered, including the forecast-based budget', async () => {
    const { store, db } = sqlite();
    const t = setup(config([forecastZone()], { forecastHours: 48 }), { weather: fakeWeather(), store });
    t.setReadings(reading('s1', 25));

    await t.monitor.runCycle();

    const [why] = await db.prisma.sequenceZone.findMany();
    expect(why).toMatchObject({ zoneKey: 'dev1:1', moisturePct: 25, thresholdPct: 30, targetPct: 40, requestedMinutes: 90, budgetInches: 1.5 });
    expect(why?.budget).toMatchObject({ inches: 1.5, minutes: 90, summary: expect.stringContaining('refills to target') });
    expect(why?.detail).toContain('apply 1.5in (90 min)');
  });

  describe('the wait for rain across a restart', () => {
    const rainSoon = () => fakeWeather({ rainInHours: 2, rainInches: 0.5 });
    /** Polls hourly for 4 hours (each time "rain in 2 hours"), then the conductor restarts `gapMinutes` later. */
    const waitThenRestart = async (gapMinutes: number, restore: boolean) => {
      const { store, load } = sqlite();
      const cfg = config([forecastZone({ maxWaitHours: 6 })]);
      const first = setup(cfg, { weather: rainSoon(), store });
      first.setReadings(reading('s1', 29));
      for (let hour = 0; hour <= 4; hour++) {
        expect((await first.monitor.runCycle()).decisions[0]?.reason).toBe('forecast-covered');
        if (hour < 4) first.advance(60);
      }
      const restartAt = new Date(first.now().getTime() + gapMinutes * 60_000);
      const second = setup(cfg, { weather: rainSoon(), store, start: restartAt, ...(restore ? { zoneSpells: (await load(restartAt)).zoneSpells } : {}) });
      second.setReadings(reading('s1', 29, { at: restartAt }));
      return (await second.monitor.runCycle()).decisions[0]?.reason;
    };

    it('counts the time waited before a quick restart against maxWaitHours', async () => {
      // 4h10m waited + rain in 2h > 6h: water now, as an uninterrupted conductor would.
      expect(await waitThenRestart(10, true)).toBe('dry');
      // Without the saved spell it would start a fresh 6-hour wait.
      expect(await waitThenRestart(10, false)).toBe('forecast-covered');
    });

    it('starts afresh after a longer gap, when the saved spell says nothing about now', async () => {
      expect(await waitThenRestart(45, true)).toBe('forecast-covered'); // saved 45 min ago > 2 polls of 15 min
    });
  });
});

describe('Monitor: connection failures and recovery', () => {
  let audit: MemoryAuditLog;

  beforeEach(() => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  const auditFor = (clock: () => Date) => (audit = new MemoryAuditLog(clock));

  it('keeps polling when a request hangs forever (watchdog)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let t!: ReturnType<typeof setup>;
      t = setup(config([zone()]), { audit: auditFor(() => t.now()) });
      t.source.read.mockImplementationOnce(() => new Promise<never>(() => {})); // half-open connection

      t.monitor.start();
      await flush();
      vi.advanceTimersByTime(POLL_DEADLINE_MS);
      await flush();
      expect(audit.ofType('poll.failed')[0]?.error).toContain('poll did not finish within 10 min');

      vi.advanceTimersByTime(15 * 60_000); // the next poll still happens
      await flush();
      expect(t.source.read).toHaveBeenCalledTimes(2);
      await t.monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('audits a sensor blackout once, with the cause, and its end with the duration', async () => {
    let t!: ReturnType<typeof setup>;
    t = setup(config([zone({ name: 'Front' })]), { audit: auditFor(() => t.now()) });
    const lastErrors = [{ sensorId: 's1', error: 'Tuya GET /v1.0/devices/s1 timed out after 20s' }];
    Object.defineProperty(t.source, 'lastErrors', { get: () => lastErrors });

    t.setReadings(); // Tuya down: no readings at all
    const first = await t.monitor.runCycle();
    t.advance(15);
    await t.monitor.runCycle();
    t.advance(15);
    lastErrors.length = 0;
    t.setReadings(reading('s1', 45, { at: t.now() }));
    await t.monitor.runCycle();

    expect(first.decisions[0]?.reason).toBe('no-data'); // no data → no watering
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
    expect(nonDecisionTypes(audit)).toEqual(['connection.lost', 'zone.no_data', 'connection.restored', 'zone.data_restored']);
    expect(audit.ofType('connection.lost')[0]).toMatchObject({
      service: 'tuya',
      error: 'no sensor could be read (s1: Tuya GET /v1.0/devices/s1 timed out after 20s)',
    });
    expect(audit.ofType('connection.restored')[0]).toMatchObject({ service: 'tuya', outageMinutes: 30, failures: 2 });
    expect(audit.ofType('zone.data_restored')[0]).toMatchObject({ zone: 'dev1:1', name: 'Front', outageMinutes: 30 });
  });

  it('audits a zone whose sensor went stale even though Tuya answers', async () => {
    let t!: ReturnType<typeof setup>;
    t = setup(config([zone()]), { audit: auditFor(() => t.now()) });
    t.setReadings(reading('s1', 10, { at: minutesAgo(600) }));

    await t.monitor.runCycle();

    expect(nonDecisionTypes(audit)).toEqual(['zone.no_data']);
    expect(audit.ofType('zone.no_data')[0]?.detail).toContain('stale (600 min old)');
  });

  it('attributes failures to the right service', async () => {
    let t!: ReturnType<typeof setup>;
    const weather = { getForecast: vi.fn(async () => Promise.reject(new Error('Open-Meteo /v1/forecast timed out after 20s'))) };
    t = setup(config([zone({ precipRateInPerHour: 1, cooldownMinutes: 0, maxMinutesPerDay: 240 })]), {
      audit: auditFor(() => t.now()),
      weather,
    });
    t.setReadings(reading('s1', 10));

    await t.monitor.runCycle(); // weather down: fixed run length instead
    t.bhyve.getDevices.mockRejectedValueOnce(new Error('B-hyve GET /devices failed: HTTP 502'));
    await expect(t.monitor.runCycle()).rejects.toThrow('HTTP 502');
    t.source.read.mockRejectedValueOnce(new Error('Tuya token request failed'));
    await expect(t.monitor.runCycle()).rejects.toThrow('Tuya token request failed');

    expect(audit.ofType('connection.lost').map((e) => e.service)).toEqual(['weather', 'bhyve', 'tuya']);
    expect(t.bhyve.startWatering).toHaveBeenCalledOnce(); // the weather outage didn't stop watering
  });

  it('records a failed poll in the audit trail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let t!: ReturnType<typeof setup>;
      t = setup(config([zone()]), { audit: auditFor(() => t.now()) });
      t.source.read.mockRejectedValueOnce(new Error('Tuya GET /v1.0/token timed out after 20s'));

      t.monitor.start();
      await flush();

      expect(audit.ofType('poll.failed')[0]).toMatchObject({ error: 'Tuya GET /v1.0/token timed out after 20s' });
      await t.monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('resuming after a restart', () => {
    const pending = (): PendingSequence => ({
      id: 'p1',
      deviceId: 'dev1',
      waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]],
      soakMinutes: 30,
      createdAt: minutesAgo(30),
      nextWave: 1,
      dueAt: minutesAgo(1),
      attempts: 0,
    });

    it('resumes saved sequences before the first poll, and does not re-plan those zones', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let t!: ReturnType<typeof setup>;
        t = setup(config([zone({ cooldownMinutes: 0 })]), { audit: auditFor(() => t.now()), pendingSequences: [pending()] });
        t.setReadings(reading('s1', 10));

        t.monitor.start();
        await flush();
        vi.advanceTimersByTime(0); // the overdue cycle is scheduled immediately
        await flush();
        await flush();

        expect(audit.ofType('sequence.resumed')[0]).toMatchObject({ sequence: 'p1', nextCycle: 2 });
        expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 1, runTime: 10 }]); // the resumed cycle only
        await t.monitor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumes only once, and not at all in dry-run mode', async () => {
      let t!: ReturnType<typeof setup>;
      t = setup(config([zone()], { dryRun: true }), { audit: auditFor(() => t.now()), pendingSequences: [pending()] });

      await t.monitor.resumePending();
      await t.monitor.resumePending();

      expect(audit.ofType('sequence.resumed')).toEqual([]);

      const live = setup(config([zone()]), { audit: auditFor(() => live.now()), pendingSequences: [pending()] });
      await live.monitor.resumePending();
      await live.monitor.resumePending();
      expect(audit.ofType('sequence.resumed')).toHaveLength(1);
      await live.monitor.stop();
    });
  });
});

describe('Monitor: health and safety alerts', () => {
  beforeEach(() => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  it('checks the controllers periodically even when nothing needs water', async () => {
    let t!: ReturnType<typeof setup>;
    const audit = new MemoryAuditLog(() => t.now());
    t = setup(config([zone()], { alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 } }), { audit });
    t.setReadings(reading('s1', 45));
    t.setDevices(bhyveDevice('dev1', { is_connected: false, battery: { percent: 12 } }));

    await t.monitor.runCycle(); // checks
    t.advance(15);
    await t.monitor.runCycle(); // too soon: no check
    t.advance(45);
    t.setDevices(bhyveDevice('dev1', { battery: { percent: 12 } }));
    await t.monitor.runCycle(); // an hour later: checks again

    expect(t.bhyve.getDevices).toHaveBeenCalledTimes(2);
    expect(nonDecisionTypes(audit)).toEqual(['device.offline', 'battery.low', 'device.online']);
  });

  it('a failed periodic check does not fail the poll', async () => {
    let t!: ReturnType<typeof setup>;
    const audit = new MemoryAuditLog(() => t.now());
    t = setup(config([zone()], { alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 } }), { audit });
    t.setReadings(reading('s1', 45));
    t.bhyve.getDevices.mockRejectedValueOnce(new Error('HTTP 503'));

    await expect(t.monitor.runCycle()).resolves.toMatchObject({ decisions: [expect.objectContaining({ reason: 'moist' })] });
    expect(audit.ofType('connection.lost')).toEqual([expect.objectContaining({ service: 'bhyve' })]);
  });

  it('reuses the periodic check for watering (one B-hyve call)', async () => {
    const t = setup(config([zone()], { alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 } }));
    t.setReadings(reading('s1', 25));

    await t.monitor.runCycle();

    expect(t.bhyve.getDevices).toHaveBeenCalledTimes(1);
    expect(t.bhyve.startWatering).toHaveBeenCalledOnce();
  });

  it('raises moisture, battery and "still dry" alerts from the poll and saves them', async () => {
    let t!: ReturnType<typeof setup>;
    const audit = new MemoryAuditLog(() => t.now());
    const { store, load } = sqlite();
    t = setup(config([zone({ name: 'Front', cooldownMinutes: 0 })]), { audit, store });
    t.setReadings(reading('s1', 12, { batteryPct: 8 }));

    await t.monitor.runCycle(); // waters 10 of 30 min
    t.advance(60);
    await t.monitor.runCycle();
    t.advance(60);
    await t.monitor.runCycle(); // 30 of 30 min used
    t.advance(60);
    await t.monitor.runCycle(); // still dry: daily limit

    expect(nonDecisionTypes(audit).filter((x) => !x.startsWith('wave.') && !x.startsWith('sequence.'))).toEqual([
      'battery.low',
      'moisture.critical_low',
      'zone.daily_limit_reached',
    ]);
    expect((await load(t.now())).alerts).toEqual({
      'battery:sensor:s1': { state: 'low', since: NOW.toISOString() },
      'daily-limit:dev1:1': { state: 'reached', since: new Date(NOW.getTime() + 180 * 60_000).toISOString() },
      'moisture:dev1:1:s1': { state: 'low', since: NOW.toISOString() },
    });
  });

  it('does not repeat alerts that were open before a restart', async () => {
    const audit = new MemoryAuditLog(() => NOW);
    const restarted = new Monitor({
      config: config([zone()]),
      source: { id: 'x', read: async () => [reading('s1', 45, { batteryPct: 5 })] },
      bhyve: fakeBhyve([bhyveDevice('dev1')]).control,
      history: new WateringHistory(),
      alertState: { 'battery:sensor:s1': { state: 'low', since: NOW.toISOString() } },
      audit,
      now: () => NOW,
    });

    await restarted.runCycle();

    expect(audit.ofType('battery.low')).toEqual([]);
  });

  it('a dry run records alerts but never writes them to the database', async () => {
    const { store, operationalRows } = sqlite();
    const audit = new MemoryAuditLog(() => NOW);
    const t = setup(config([zone()], { dryRun: true }), { store, audit });
    t.setReadings(reading('s1', 5, { batteryPct: 3 }));

    await t.monitor.runCycle();

    expect(audit.ofType('battery.low')).toHaveLength(1);
    expect(await operationalRows()).toBe(0);
  });
});

describe('Monitor: decision audit', () => {
  beforeEach(() => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  it('records each zone decision when it changes, not on every poll', async () => {
    let t!: ReturnType<typeof setup>;
    const audit = new MemoryAuditLog(() => t.now());
    t = setup(config([zone({ name: 'Front' }), zone({ station: 2, name: 'Back', sensorIds: ['s2'] })]), { audit });

    t.setReadings(reading('s1', 45), reading('s2', 50));
    await t.monitor.runCycle();
    await t.monitor.runCycle();
    t.advance(15);
    t.setReadings(reading('s1', 25, { at: t.now() }), reading('s2', 50, { at: t.now() }));
    await t.monitor.runCycle(); // Front: dry → waters
    t.advance(15);
    await t.monitor.runCycle(); // Front: cooldown

    const decisions = audit.ofType('zone.decision').map((e) => [e.name, e.reason]);
    expect(decisions).toEqual([
      ['Front', 'moist'],
      ['Back', 'moist'],
      ['Front', 'dry'],
      ['Front', 'cooldown'],
    ]);
    expect(audit.ofType('zone.decision')[2]).toMatchObject({ action: 'water', moisturePct: 25, minutes: 10, detail: expect.stringContaining('below 30%') });
  });
});

describe('Monitor: what is saved', () => {
  beforeEach(() => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  it('saves each sensor reading once, however often it is polled', async () => {
    const { store, db } = sqlite();
    const t = setup(config([zone()]), { store });
    t.setReadings(reading('s1', 45, { batteryPct: 80, temperatureC: 21.5, at: minutesAgo(5) }));

    await t.monitor.runCycle();
    t.advance(15);
    t.setReadings(reading('s1', 45, { batteryPct: 80, temperatureC: 21.5, at: minutesAgo(5) })); // the sensor hasn't reported again
    await t.monitor.runCycle();
    t.advance(15);
    t.setReadings(reading('s1', 44, { at: t.now() }));
    await t.monitor.runCycle();

    expect(
      await db.prisma.sensorReading.findMany({
        orderBy: { measuredAt: 'asc' },
        select: { measuredAt: true, polledAt: true, moisturePct: true, batteryPct: true },
      }),
    ).toEqual([
      { measuredAt: minutesAgo(5), polledAt: NOW, moisturePct: 45, batteryPct: 80 },
      { measuredAt: t.now(), polledAt: t.now(), moisturePct: 44, batteryPct: null },
    ]);
  });

  it('saves every zone\'s dry spell and sensor blackout after each poll', async () => {
    const { store, load } = sqlite();
    const t = setup(config([zone({ sensorIds: ['s1'] }), zone({ station: 2, sensorIds: ['s2'] })]), { store });
    t.setReadings(reading('s1', 10)); // zone 1 dry, zone 2 no data

    await t.monitor.runCycle();
    expect((await load()).zoneSpells).toEqual([
      { zoneKey: 'dev1:1', drySince: NOW, evaluatedAt: NOW },
      { zoneKey: 'dev1:2', noDataSince: NOW, evaluatedAt: NOW },
    ]);

    t.advance(15);
    t.setReadings(reading('s1', 45, { at: t.now() }), reading('s2', 45, { at: t.now() }));
    await t.monitor.runCycle();
    expect((await load(t.now())).zoneSpells).toEqual([
      { zoneKey: 'dev1:1', evaluatedAt: t.now() },
      { zoneKey: 'dev1:2', evaluatedAt: t.now() },
    ]);
  });

  it('does not report a sensor blackout again after a quick restart, and times it from its start', async () => {
    const { store, load } = sqlite();
    const audit = new MemoryAuditLog(() => NOW);
    const cfg = config([zone({ name: 'Front' })]);
    const first = setup(cfg, { store, audit });
    first.setReadings();
    await first.monitor.runCycle(); // zone.no_data at NOW

    const second = setup(cfg, { store, audit, zoneSpells: (await load(NOW)).zoneSpells, start: minutesAgo(-20) });
    second.setReadings();
    await second.monitor.runCycle(); // still nothing: no second zone.no_data
    second.advance(10);
    second.setReadings(reading('s1', 45, { at: second.now() }));
    await second.monitor.runCycle();

    expect(audit.ofType('zone.no_data')).toHaveLength(1);
    expect(audit.ofType('zone.data_restored')).toEqual([expect.objectContaining({ zone: 'dev1:1', outageMinutes: 30 })]);
  });

  it('ignores saved spells of zones that are no longer configured', async () => {
    const audit = new MemoryAuditLog(() => NOW);
    const t = setup(config([zone()]), {
      audit,
      zoneSpells: [{ zoneKey: 'gone:9', noDataSince: minutesAgo(5), evaluatedAt: minutesAgo(5) }],
    });
    t.setReadings(reading('s1', 45));

    await t.monitor.runCycle();

    expect(audit.ofType('zone.data_restored')).toEqual([]);
  });

  it('records a heartbeat after every poll, successful or not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const heartbeat = vi.fn();
      const t = setup(config([zone()]), { heartbeat });
      t.source.read.mockRejectedValueOnce(new Error('tuya down'));
      t.setReadings(reading('s1', 45));

      t.monitor.start();
      await flush();
      expect(heartbeat).toHaveBeenCalledTimes(1); // after the failed poll
      vi.advanceTimersByTime(15 * 60_000);
      await flush();
      expect(heartbeat).toHaveBeenCalledTimes(2);

      heartbeat.mockImplementation(() => {
        throw new Error('database is locked');
      });
      vi.advanceTimersByTime(15 * 60_000);
      await flush();
      expect(t.source.read).toHaveBeenCalledTimes(3); // a failing heartbeat doesn't stop polling
      vi.advanceTimersByTime(15 * 60_000);
      await flush();
      expect(t.source.read).toHaveBeenCalledTimes(4);
      await t.monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a sequence the database kept, and finishes it there', async () => {
    const { store, load } = sqlite();
    const cfg = config([zone({ runMinutes: 20, maxCycleMinutes: 10, soakMinutes: 30 })]);
    const first = setup(cfg, { store });
    first.setReadings(reading('s1', 10));
    await first.monitor.runCycle(); // cycle 1 of 2 sent; the process then dies

    const second = setup(cfg, { store, pendingSequences: (await load(NOW)).sequences, start: minutesAgo(-40) });
    second.setReadings(reading('s1', 29, { at: second.now() }));
    await second.monitor.resumePending();
    await vi.waitFor(() => expect(second.bhyve.startWatering).toHaveBeenCalledOnce());
    await second.monitor.drain();

    expect(await store.sequenceResults()).toEqual([expect.objectContaining({ status: 'completed', cyclesDelivered: 2 })]);
    expect((await load(second.now())).history.map((r) => r.minutes)).toEqual([10, 10]);
  });
});
