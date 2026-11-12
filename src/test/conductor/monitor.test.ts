import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BhyveDevice, StationRun } from '../../bhyve/types.ts';
import type { ConductorConfig, ZoneConfig } from '../../conductor/config.ts';
import { FileHistoryStore, WateringHistory } from '../../conductor/history.ts';
import { Monitor, type BhyveControl, type HistoryStore } from '../../conductor/monitor.ts';
import { log } from '../../log.ts';
import type { MoistureReading } from '../../sensors/types.ts';
import { flush } from '../utils/fetch.ts';
import { bhyveDevice, minutesAgo, NOW, reading, zone } from '../utils/conductor.ts';

const config = (zones: ZoneConfig[], overrides: Partial<ConductorConfig> = {}): ConductorConfig => ({
  pollIntervalMinutes: 15,
  dryRun: false,
  zones,
  ...overrides,
});

/** Test double for the sensors + B-hyve, with a controllable clock. */
const setup = (cfg: ConductorConfig, opts: { history?: WateringHistory; store?: HistoryStore } = {}) => {
  let readings: MoistureReading[] = [];
  let devices: BhyveDevice[] = [bhyveDevice('dev1'), bhyveDevice('dev2')];
  let now = NOW;

  const source = { id: 'fake', read: vi.fn(async () => readings) };
  const bhyve = {
    getDevices: vi.fn(async () => devices),
    startWatering: vi.fn(async (_deviceId: string, _runs: StationRun[]) => {}),
  };
  const history = opts.history ?? new WateringHistory();
  const monitor = new Monitor({
    config: cfg,
    source,
    bhyve: bhyve as BhyveControl,
    history,
    ...(opts.store ? { store: opts.store } : {}),
    now: () => now,
  });

  return {
    monitor,
    source,
    bhyve,
    history,
    setReadings: (...rs: MoistureReading[]) => {
      readings = rs;
    },
    setDevices: (...ds: BhyveDevice[]) => {
      devices = ds;
    },
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
    expect(store.save).toHaveBeenCalledExactlyOnceWith(t.history);
    expect(info).toHaveBeenCalledWith('Started watering on device dev1: station 2 for 12 min');
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
      const store = new FileHistoryStore(join(dir, 'state.json'));
      const cfg = config([zone()]);

      const first = setup(cfg, { history: await store.load(), store });
      first.setReadings(reading('s1', 10));
      await first.monitor.runCycle();

      const restarted = setup(cfg, { history: await store.load(), store });
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

    expect(result.sent).toEqual([expect.objectContaining({ deviceId: 'dev1', runs: [{ station: 1, runTime: 10 }] })]);
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

    expect(result.failed).toEqual([{ command: expect.objectContaining({ deviceId: 'dev1' }), error: boom }]);
    expect(result.sent.map((c) => c.deviceId)).toEqual(['dev2']);
    expect(t.history.runs.map((r) => r.zoneKey)).toEqual(['dev2:1']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dev1'), boom);
  });

  it('retries a zone whose command failed on the next cycle (no cooldown applied)', async () => {
    const t = setup(config([zone()]));
    t.setReadings(reading('s1', 10));
    t.bhyve.startWatering.mockRejectedValueOnce(new Error('socket down'));

    await t.monitor.runCycle();
    t.advance(15);
    await t.monitor.runCycle();

    expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
    expect(t.history.runs).toHaveLength(1);
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
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not save watering history'), expect.any(Error));
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
