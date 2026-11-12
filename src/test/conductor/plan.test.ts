import { describe, expect, it } from 'vitest';
import { WateringHistory } from '../../conductor/history.ts';
import { applyDeviceState, evaluateZone, readingProblem, type ZoneDecision } from '../../conductor/plan.ts';
import { bhyveDevice, minutesAgo, NOW, reading, readingsMap, zone } from '../utils/conductor.ts';

const noHistory = new WateringHistory();

describe('readingProblem', () => {
  it('accepts an online, recent, in-range reading', () => {
    expect(readingProblem(reading('s1', 25), NOW, 180)).toBeUndefined();
  });

  it.each([
    ['offline', reading('s1', 25, { online: false }), 'offline'],
    ['NaN moisture', reading('s1', Number.NaN), 'invalid moisture NaN'],
    ['negative moisture', reading('s1', -1), 'invalid moisture -1'],
    ['moisture above 100', reading('s1', 100.5), 'invalid moisture 100.5'],
    ['an invalid date', reading('s1', 25, { at: new Date(Number.NaN) }), 'invalid timestamp'],
    ['an old reading', reading('s1', 25, { at: minutesAgo(181) }), 'stale (181 min old)'],
  ])('rejects %s', (_, r, problem) => {
    expect(readingProblem(r, NOW, 180)).toBe(problem);
  });

  it('treats a reading exactly at the max age as fresh', () => {
    expect(readingProblem(reading('s1', 25, { at: minutesAgo(180) }), NOW, 180)).toBeUndefined();
  });

  it('accepts the 0 and 100 boundaries', () => {
    expect(readingProblem(reading('s1', 0), NOW, 180)).toBeUndefined();
    expect(readingProblem(reading('s1', 100), NOW, 180)).toBeUndefined();
  });

  it('accepts a slightly future timestamp (sensor clock skew)', () => {
    expect(readingProblem(reading('s1', 25, { at: minutesAgo(-2) }), NOW, 180)).toBeUndefined();
  });
});

describe('evaluateZone', () => {
  describe('moisture vs threshold', () => {
    it('does nothing when the soil is above the threshold', () => {
      const d = evaluateZone(zone(), readingsMap(reading('s1', 45)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'none', reason: 'moist' });
      expect(d.runMinutes).toBeUndefined();
    });

    it('does nothing when the soil is exactly at the threshold', () => {
      const d = evaluateZone(zone({ thresholdPct: 30 }), readingsMap(reading('s1', 30)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'none', reason: 'moist' });
    });

    it('waters for runMinutes when the soil is below the threshold', () => {
      const d = evaluateZone(zone({ runMinutes: 12 }), readingsMap(reading('s1', 29.9)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'water', reason: 'dry', runMinutes: 12 });
      expect(d.detail).toBe('Sensor s1 at 29.9% is below 30%; watering 12 min');
    });

    it('waters when any one of several sensors is below the threshold, and reports the driest', () => {
      const z = zone({ sensorIds: ['a', 'b', 'c'] });
      const d = evaluateZone(z, readingsMap(reading('a', 50), reading('b', 22), reading('c', 28)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'water', driest: { sensorId: 'b', moisturePct: 22 } });
    });

    it('does not water when every sensor is above the threshold', () => {
      const z = zone({ sensorIds: ['a', 'b'] });
      const d = evaluateZone(z, readingsMap(reading('a', 31), reading('b', 60)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'none', driest: { sensorId: 'a' } });
    });

    it('uses the per-zone threshold', () => {
      const readings = readingsMap(reading('s1', 35));

      expect(evaluateZone(zone({ thresholdPct: 30 }), readings, noHistory, NOW).action).toBe('none');
      expect(evaluateZone(zone({ thresholdPct: 40 }), readings, noHistory, NOW).action).toBe('water');
    });

    it('only looks at its own sensors', () => {
      const d = evaluateZone(zone({ sensorIds: ['mine'] }), readingsMap(reading('mine', 50), reading('other', 5)), noHistory, NOW);

      expect(d.action).toBe('none');
    });
  });

  describe('untrustworthy readings', () => {
    it('never waters on a stale reading, even a very dry one', () => {
      const d = evaluateZone(zone(), readingsMap(reading('s1', 5, { at: minutesAgo(600) })), noHistory, NOW);

      expect(d).toMatchObject({ action: 'skip', reason: 'no-data' });
      expect(d.detail).toContain('s1: stale (600 min old)');
    });

    it('ignores an offline sensor', () => {
      const d = evaluateZone(zone(), readingsMap(reading('s1', 5, { online: false })), noHistory, NOW);

      expect(d).toMatchObject({ action: 'skip', reason: 'no-data' });
    });

    it('reports sensors that returned no reading at all', () => {
      const d = evaluateZone(zone({ sensorIds: ['s1', 's2'] }), readingsMap(), noHistory, NOW);

      expect(d).toMatchObject({ action: 'skip', reason: 'no-data' });
      expect(d.detail).toBe('no usable readings (s1: no reading; s2: no reading)');
    });

    it('decides from the usable sensors when some are unusable', () => {
      const z = zone({ sensorIds: ['stale', 'offline', 'bad', 'good'] });
      const readings = readingsMap(
        reading('stale', 1, { at: minutesAgo(999) }),
        reading('offline', 1, { online: false }),
        reading('bad', Number.NaN),
        reading('good', 55),
      );

      expect(evaluateZone(z, readings, noHistory, NOW)).toMatchObject({ action: 'none', driest: { sensorId: 'good' } });
    });

    it('uses the per-zone max reading age', () => {
      const readings = readingsMap(reading('s1', 10, { at: minutesAgo(90) }));

      expect(evaluateZone(zone({ maxReadingAgeMinutes: 60 }), readings, noHistory, NOW).reason).toBe('no-data');
      expect(evaluateZone(zone({ maxReadingAgeMinutes: 120 }), readings, noHistory, NOW).reason).toBe('dry');
    });
  });

  describe('cooldown', () => {
    const z = zone({ cooldownMinutes: 240 });
    const dry = readingsMap(reading('s1', 10));

    it('skips a dry zone that was watered within the cooldown', () => {
      const history = new WateringHistory([{ zoneKey: z.key, at: minutesAgo(239), minutes: 10 }]);

      const d = evaluateZone(z, dry, history, NOW);

      expect(d).toMatchObject({ action: 'skip', reason: 'cooldown' });
      expect(d.detail).toContain('cooling down until 2026-07-01T12:01:00.000Z');
    });

    it('waters again once the cooldown has passed', () => {
      const history = new WateringHistory([{ zoneKey: z.key, at: minutesAgo(240), minutes: 10 }]);

      expect(evaluateZone(z, dry, history, NOW)).toMatchObject({ action: 'water', runMinutes: 10 });
    });

    it('uses the most recent run', () => {
      const history = new WateringHistory([
        { zoneKey: z.key, at: minutesAgo(30), minutes: 5 },
        { zoneKey: z.key, at: minutesAgo(600), minutes: 5 },
      ]);

      expect(evaluateZone(z, dry, history, NOW).reason).toBe('cooldown');
    });

    it('is tracked per zone', () => {
      const history = new WateringHistory([{ zoneKey: 'dev1:2', at: minutesAgo(5), minutes: 10 }]);

      expect(evaluateZone(z, dry, history, NOW).action).toBe('water');
    });

    it('can be disabled with cooldownMinutes 0', () => {
      const history = new WateringHistory([{ zoneKey: z.key, at: NOW, minutes: 10 }]);

      expect(evaluateZone(zone({ cooldownMinutes: 0 }), dry, history, NOW).action).toBe('water');
    });

    it('reports a moist zone as moist even while cooling down', () => {
      const history = new WateringHistory([{ zoneKey: z.key, at: minutesAgo(5), minutes: 10 }]);

      expect(evaluateZone(z, readingsMap(reading('s1', 50)), history, NOW).reason).toBe('moist');
    });
  });

  describe('daily limit', () => {
    const z = zone({ runMinutes: 10, maxMinutesPerDay: 30, cooldownMinutes: 0 });
    const dry = readingsMap(reading('s1', 10));
    const runs = (...ago: [minutesAgo: number, minutes: number][]) =>
      new WateringHistory(ago.map(([m, minutes]) => ({ zoneKey: z.key, at: minutesAgo(m), minutes })));

    it('skips once the 24h allowance is used up', () => {
      const d = evaluateZone(z, dry, runs([60, 10], [120, 10], [180, 10]), NOW);

      expect(d).toMatchObject({ action: 'skip', reason: 'daily-limit' });
      expect(d.detail).toContain('already watered 30 of 30 min');
    });

    it('shortens the run to what is left of the allowance', () => {
      expect(evaluateZone(z, dry, runs([60, 10], [120, 15]), NOW)).toMatchObject({ action: 'water', runMinutes: 5 });
    });

    it('skips rather than starting a run shorter than a minute', () => {
      expect(evaluateZone(z, dry, runs([60, 29.5]), NOW).reason).toBe('daily-limit');
    });

    it('stops counting runs after 24 hours', () => {
      expect(evaluateZone(z, dry, runs([24 * 60, 30]), NOW)).toMatchObject({ action: 'water', runMinutes: 10 });
    });
  });
});

describe('applyDeviceState', () => {
  const water = (overrides: Parameters<typeof zone>[0] = {}, runMinutes = 10): ZoneDecision => {
    const z = zone(overrides);
    return { zone: z, action: 'water', reason: 'dry', runMinutes, driest: reading('s1', 10), detail: 'dry' };
  };

  it('passes decisions that are not "water" through untouched without commands', () => {
    const moist: ZoneDecision = { zone: zone(), action: 'none', reason: 'moist', detail: 'ok' };
    const noData: ZoneDecision = { zone: zone({ station: 2 }), action: 'skip', reason: 'no-data', detail: 'none' };

    const result = applyDeviceState([moist, noData], []);

    expect(result.decisions).toEqual([moist, noData]);
    expect(result.commands).toEqual([]);
  });

  it('builds a command for an idle, connected device', () => {
    const d = water({ station: 2 }, 7);

    const { decisions, commands } = applyDeviceState([d], [bhyveDevice('dev1')]);

    expect(decisions).toEqual([d]);
    expect(commands).toEqual([{ deviceId: 'dev1', runs: [{ station: 2, runTime: 7 }], zones: [d.zone] }]);
  });

  it('sends one command per device, with stations in order', () => {
    const decisions = [
      water({ deviceId: 'dev1', station: 3 }, 5),
      water({ deviceId: 'dev2', station: 1 }, 8),
      water({ deviceId: 'dev1', station: 1 }, 10),
    ];

    const { commands } = applyDeviceState(decisions, [bhyveDevice('dev1'), bhyveDevice('dev2')]);

    expect(commands.map((c) => [c.deviceId, c.runs])).toEqual([
      [
        'dev1',
        [
          { station: 1, runTime: 10 },
          { station: 3, runTime: 5 },
        ],
      ],
      ['dev2', [{ station: 1, runTime: 8 }]],
    ]);
  });

  it.each([
    ['device-not-found', undefined, 'B-hyve device not found'],
    ['device-offline', bhyveDevice('dev1', { is_connected: false }), 'Timer dev1 is not connected'],
    ['device-off', bhyveDevice('dev1', { status: { run_mode: 'off' } }), 'Timer dev1 is switched off'],
    ['rain-delay', bhyveDevice('dev1', { status: { run_mode: 'auto', rain_delay: 24 } }), 'has a 24h rain delay'],
    [
      'already-watering',
      bhyveDevice('dev1', { status: { run_mode: 'auto', watering_status: { current_station: 2 } } }),
      'is already watering',
    ],
  ] as const)('skips with %s', (reason, device, detail) => {
    const { decisions, commands } = applyDeviceState([water()], device ? [device] : [bhyveDevice('other')]);

    expect(commands).toEqual([]);
    expect(decisions[0]).toMatchObject({ action: 'skip', reason });
    expect(decisions[0]?.detail).toContain(detail);
    // The reading that made it want water is kept for the logs.
    expect(decisions[0]?.driest?.moisturePct).toBe(10);
  });

  it('treats a missing connection flag and missing status as available', () => {
    const device = bhyveDevice('dev1');
    delete device.is_connected;
    delete device.status;

    expect(applyDeviceState([water()], [device]).commands).toHaveLength(1);
  });

  it('skips a station the device does not have, but still waters its other zones', () => {
    const decisions = [water({ station: 9 }), water({ station: 2 })];

    const result = applyDeviceState(decisions, [bhyveDevice('dev1')]);

    expect(result.decisions[0]).toMatchObject({ action: 'skip', reason: 'unknown-station' });
    expect(result.decisions[0]?.detail).toContain('has no station 9 (has 1, 2, 3, 4)');
    expect(result.commands).toEqual([expect.objectContaining({ runs: [{ station: 2, runTime: 10 }] })]);
  });

  it('does not validate stations when the device lists no zones', () => {
    const device = bhyveDevice('dev1');
    delete device.zones;

    expect(applyDeviceState([water({ station: 9 })], [device]).commands).toHaveLength(1);
  });

  it('only blocks the zones on the unavailable device', () => {
    const decisions = [water({ deviceId: 'dev1' }), water({ deviceId: 'dev2' })];

    const result = applyDeviceState(decisions, [bhyveDevice('dev1', { is_connected: false }), bhyveDevice('dev2')]);

    expect(result.decisions.map((d) => d.action)).toEqual(['skip', 'water']);
    expect(result.commands.map((c) => c.deviceId)).toEqual(['dev2']);
  });
});
