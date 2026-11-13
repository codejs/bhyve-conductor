import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BhyveDevice } from '../../bhyve/types.ts';
import type { ConductorConfig, ZoneConfig } from '../../conductor/config.ts';
import { WateringHistory } from '../../conductor/history.ts';
import { Monitor, POLL_DEADLINE_MS, type StateStore } from '../../conductor/monitor.ts';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { PendingSequence } from '../../conductor/state.ts';
import { FileStateStore } from '../../conductor/state.ts';
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
    store?: StateStore;
    weather?: WeatherProvider;
    audit?: MemoryAuditLog;
    pendingSequences?: PendingSequence[];
  } = {},
) => {
  let readings: MoistureReading[] = [];
  let now = NOW;

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
    const store = { save: vi.fn(async () => {}) };
    const t = setup(config([zone({ station: 2, runMinutes: 12 })]), { store });
    t.setReadings(reading('s1', 18));

    const result = await t.monitor.runCycle();

    expect(t.bhyve.startWatering).toHaveBeenCalledExactlyOnceWith('dev1', [{ station: 2, runTime: 12 }]);
    expect(result.sent).toHaveLength(1);
    expect(t.history.runs).toEqual([{ zoneKey: 'dev1:2', at: NOW, minutes: 12 }]);
    // (the in-flight save before sending is checked with snapshots in sequencer.test.ts)
    expect(store.save).toHaveBeenLastCalledWith({ history: t.history, sequences: [], alerts: expect.any(Object) });
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

  it('remembers the cooldown across a restart via the history file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'conductor-monitor-'));
    try {
      const store = new FileStateStore(join(dir, 'state.json'));
      const cfg = config([zone()]);

      const first = setup(cfg, { history: (await store.load()).history, store });
      first.setReadings(reading('s1', 10));
      await first.monitor.runCycle();

      const restarted = setup(cfg, { history: (await store.load()).history, store });
      restarted.setReadings(reading('s1', 10));
      const result = await restarted.monitor.runCycle();

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
    const store = { save: vi.fn(async () => {}) };
    const t = setup(config([zone()], { dryRun: true }), { store });
    t.setReadings(reading('s1', 10));

    const result = await t.monitor.runCycle();

    expect(result.sent).toEqual([expect.objectContaining({ deviceId: 'dev1', waves: [[{ station: 1, runTime: 10 }]] })]);
    expect(t.bhyve.startWatering).not.toHaveBeenCalled();
    expect(t.history.runs).toEqual([]);
    expect(store.save).not.toHaveBeenCalled();
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

  it('still reports success when saving the history fails', async () => {
    const store = { save: vi.fn(async () => Promise.reject(new Error('disk full'))) };
    const t = setup(config([zone()]), { store });
    t.setReadings(reading('s1', 10));

    const result = await t.monitor.runCycle();

    expect(result.sent).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not save state'), expect.any(Error));
  });

  it('prunes old runs before saving', async () => {
    const history = new WateringHistory([{ zoneKey: 'dev1:1', at: minutesAgo(3 * 24 * 60), minutes: 10 }]);
    const t = setup(config([zone()]), { history, store: { save: async () => {} } });
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
    const store = { save: vi.fn(async () => {}) };
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
    expect(store.save).toHaveBeenLastCalledWith({
      history: t.history,
      sequences: [expect.objectContaining({ deviceId: 'dev1', nextWave: 2, attempts: 0 })],
      alerts: expect.any(Object),
    });
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
    const store = { save: vi.fn(async () => {}) };
    const t = setup(config([cyclingZone()]), { store });
    t.setReadings(reading('s1', 10));
    await t.monitor.runCycle();

    await t.monitor.stop();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 unfinished watering sequence(s) (dev1); they resume on restart'));
    expect(store.save).toHaveBeenLastCalledWith({
      history: t.history,
      sequences: [expect.objectContaining({ nextWave: 1 })],
      alerts: expect.any(Object),
    });
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
    const store = { save: vi.fn(async () => {}) };
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
    expect(store.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        alerts: expect.objectContaining({ 'battery:sensor:s1': expect.anything(), 'moisture:dev1:1:s1': expect.anything(), 'daily-limit:dev1:1': expect.anything() }),
      }),
    );
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

  it('a dry run records alerts but never writes the state file', async () => {
    const store = { save: vi.fn(async () => {}) };
    const audit = new MemoryAuditLog(() => NOW);
    const t = setup(config([zone()], { dryRun: true }), { store, audit });
    t.setReadings(reading('s1', 5, { batteryPct: 3 }));

    await t.monitor.runCycle();

    expect(audit.ofType('battery.low')).toHaveLength(1);
    expect(store.save).not.toHaveBeenCalled();
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
