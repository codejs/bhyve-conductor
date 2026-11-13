import { describe, expect, it, vi } from 'vitest';
import { WateringHistory } from '../../conductor/history.ts';
import type { ScheduledRun } from '../../bhyve/schedule.ts';
import {
  aggregateReadings,
  applyDeviceState,
  applyForecast,
  evaluateZone,
  readingProblem,
  splitRun,
  type ForecastContext,
  type ZoneDecision,
} from '../../conductor/plan.ts';
import type { ForecastHour } from '../../weather/types.ts';
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

describe('splitRun', () => {
  it.each([
    ['a run that fits stays whole', 20, 20, [20]],
    ['short runs stay whole', 1, 20, [1]],
    ['splits into equal cycles when possible', 30, 15, [15, 15]],
    ['splits into near-equal cycles, never above the maximum', 35, 15, [11.7, 11.7, 11.6]],
    ['spreads rounding across cycles, preserving the total', 25, 10, [8.3, 8.4, 8.3]],
    ['handles fractional totals', 12.5, 10, [6.3, 6.2]],
    ['handles a total exactly on a cycle boundary', 45, 15, [15, 15, 15]],
  ])('%s: %s min with max %s → %j', (_, total, max, expected) => {
    const cycles = splitRun(total, max);

    expect(cycles).toEqual(expected);
    expect(cycles.reduce((a, b) => a + b, 0)).toBeCloseTo(total, 6);
    for (const c of cycles) expect(c).toBeLessThanOrEqual(max);
  });
});

describe('aggregateReadings', () => {
  const rs = (...pcts: number[]) => pcts.map((p, i) => reading(`s${i + 1}`, p));

  it('returns nothing for no readings', () => {
    expect(aggregateReadings([], 'driest')).toBeUndefined();
  });

  it('driest picks the lowest sensor', () => {
    expect(aggregateReadings(rs(40, 22, 31), 'driest')).toMatchObject({ sensorId: 's2', moisturePct: 22 });
  });

  it('average combines all sensors and lists them by name', () => {
    const combined = aggregateReadings(rs(20, 40, 33), 'average');

    expect(combined).toMatchObject({ moisturePct: 31, sensorId: 's1+s3+s2' });
    expect(combined?.sensorName).toBe('average of 3 sensors (Sensor s1 20%, Sensor s3 33%, Sensor s2 40%)');
  });

  it('median takes the middle sensor, or the midpoint of the middle two', () => {
    expect(aggregateReadings(rs(10, 39, 40), 'median')?.moisturePct).toBe(39);
    expect(aggregateReadings(rs(10, 30, 40, 42), 'median')?.moisturePct).toBe(35);
  });

  it('uses the single reading as is when there is only one', () => {
    for (const how of ['driest', 'average', 'median'] as const) {
      expect(aggregateReadings(rs(25), how)).toEqual(reading('s1', 25));
    }
  });

  it('keeps the oldest timestamp so aggregation cannot hide staleness', () => {
    const readings = [reading('s1', 20, { at: minutesAgo(170) }), reading('s2', 40, { at: minutesAgo(10) })];

    expect(aggregateReadings(readings, 'average')?.at).toEqual(minutesAgo(170));
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

      expect(d).toMatchObject({ action: 'water', reading: { sensorId: 'b', moisturePct: 22 } });
    });

    it('does not water when every sensor is above the threshold', () => {
      const z = zone({ sensorIds: ['a', 'b'] });
      const d = evaluateZone(z, readingsMap(reading('a', 31), reading('b', 60)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'none', reading: { sensorId: 'a' } });
    });

    it('uses the per-zone threshold', () => {
      const readings = readingsMap(reading('s1', 35));

      expect(evaluateZone(zone({ thresholdPct: 30 }), readings, noHistory, NOW).action).toBe('none');
      expect(evaluateZone(zone({ thresholdPct: 40 }), readings, noHistory, NOW).action).toBe('water');
    });

    it('one dry sensor does not trigger watering when the zone averages its sensors', () => {
      // e.g. a sensor at the bottom of a slope reading far drier than the rest of the lawn
      const z = zone({ sensorIds: ['slope', 'b', 'c'], sensorAggregation: 'average' });
      const readings = readingsMap(reading('slope', 9), reading('b', 40), reading('c', 44));

      expect(evaluateZone(z, readings, noHistory, NOW)).toMatchObject({
        action: 'none',
        reason: 'moist',
        reading: { moisturePct: 31 },
      });
      // the same zone with the default "driest" aggregation would water
      expect(evaluateZone({ ...z, sensorAggregation: 'driest' }, readings, noHistory, NOW).action).toBe('water');
    });

    it('waters by the combined value when the average is below the threshold', () => {
      const z = zone({ sensorIds: ['a', 'b'], sensorAggregation: 'average' });
      const d = evaluateZone(z, readingsMap(reading('a', 18), reading('b', 38)), noHistory, NOW);

      expect(d).toMatchObject({ action: 'water', reading: { moisturePct: 28 } });
      expect(d.detail).toContain('average of 2 sensors (Sensor a 18%, Sensor b 38%) at 28% is below 30%');
    });

    it('aggregates only the usable readings', () => {
      const z = zone({ sensorIds: ['a', 'stale', 'b'], sensorAggregation: 'median' });
      const readings = readingsMap(reading('a', 20), reading('stale', 2, { at: minutesAgo(999) }), reading('b', 40));

      expect(evaluateZone(z, readings, noHistory, NOW)).toMatchObject({ action: 'none', reading: { moisturePct: 30 } });
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

      expect(evaluateZone(z, readings, noHistory, NOW)).toMatchObject({ action: 'none', reading: { sensorId: 'good' } });
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

    it('reports the remaining allowance for forecast-based amounts', () => {
      expect(evaluateZone(z, dry, runs([60, 12]), NOW).allowanceMinutes).toBe(18);
    });

    it('caps the allowance at the longest run B-hyve accepts', () => {
      const big = zone({ maxMinutesPerDay: 600, cooldownMinutes: 0 });
      expect(evaluateZone(big, dry, noHistory, NOW).allowanceMinutes).toBe(240);
    });
  });
});

describe('applyForecast', () => {
  /** 72 dry hours using 0.01in/h (0.254mm) of water. */
  const dryHours: ForecastHour[] = Array.from({ length: 72 }, (_, i) => ({
    end: new Date(NOW.getTime() + (i + 1) * 3_600_000),
    et0Mm: 0.254,
    precipMm: 0,
  }));
  const ctx = (overrides: Partial<ForecastContext> = {}): ForecastContext => ({
    now: NOW,
    forecast: dryHours,
    schedule: [],
    waitedHours: () => 0,
    ...overrides,
  });
  // 10in root zone, crop coefficient 1, 1in/h sprinklers: see water-budget.test.ts for the arithmetic.
  const soil = { rootDepthIn: 10, cropCoefficient: 1, rainEfficiency: 1, precipRateInPerHour: 1, thresholdPct: 30, targetPct: 40 };
  const dryDecision = (overrides: Parameters<typeof zone>[0] = {}, moisture = 25, allowance = 240): ZoneDecision => ({
    zone: zone({ ...soil, ...overrides }),
    action: 'water',
    reason: 'dry',
    reading: reading('s1', moisture),
    runMinutes: 10,
    allowanceMinutes: allowance,
    detail: 'fixed',
  });
  const scheduled = (overrides: Partial<ScheduledRun> = {}): ScheduledRun => ({
    deviceId: 'dev1',
    station: 1,
    start: new Date(NOW.getTime() + 2 * 3_600_000),
    minutes: 30,
    program: 'A',
    ...overrides,
  });

  it('replaces the fixed run length with the forecast-based amount', () => {
    const [d] = applyForecast([dryDecision()], ctx());

    // Refill 25% → 40% of 10in = 1.5in at 1in/h
    expect(d).toMatchObject({ action: 'water', reason: 'dry', runMinutes: 90 });
    expect(d?.budget?.inches).toBeCloseTo(1.5, 2);
    expect(d?.detail).toBe(`Sensor s1 at 25%: ${d?.budget?.summary}`);
  });

  it('does not water when a scheduled run of this zone will restore the threshold soon', () => {
    const [d] = applyForecast([dryDecision({}, 29)], ctx({ schedule: [scheduled()] }));

    expect(d).toMatchObject({ action: 'none', reason: 'forecast-covered' });
    expect(d?.runMinutes).toBeUndefined();
    expect(d?.allowanceMinutes).toBeUndefined();
    expect(d?.detail).toContain('restores the threshold within 2h');
  });

  it("ignores other zones' and other devices' scheduled runs", () => {
    const others = [scheduled({ station: 2 }), scheduled({ deviceId: 'dev2' })];

    const [d] = applyForecast([dryDecision({}, 29)], ctx({ schedule: others }));

    expect(d).toMatchObject({ action: 'water', reason: 'dry' });
    expect(d?.budget?.scheduledIn).toBe(0);
  });

  it('caps the amount at the remaining daily allowance and says so', () => {
    const [d] = applyForecast([dryDecision({}, 25, 30)], ctx());

    expect(d?.runMinutes).toBe(30);
    expect(d?.budget?.minutes).toBe(90);
    expect(d?.detail).toContain('capped at 30 min by the daily limit');
  });

  it('passes how long the zone has waited to the budget', () => {
    const rainSoon = dryHours.map((h, i) => (i === 1 ? { ...h, precipMm: 25.4 } : h));
    const waited = vi.fn((_key: string) => 6);

    const [d] = applyForecast([dryDecision({}, 29)], ctx({ forecast: rainSoon, waitedHours: waited }));

    expect(waited).toHaveBeenCalledWith('dev1:1');
    expect(d?.action).toBe('water'); // would have waited for the rain, but already waited maxWaitHours
  });

  it('keeps the fixed run length for zones without a sprinkler rate', () => {
    const d = dryDecision();
    const { precipRateInPerHour: _, ...withoutRate } = d.zone;
    const noRate = { ...d, zone: withoutRate };

    expect(applyForecast([noRate], ctx())).toEqual([noRate]);
  });

  it('leaves decisions that are not "water" alone', () => {
    const moist: ZoneDecision = { zone: zone(soil), action: 'none', reason: 'moist', detail: 'ok' };
    const cooling: ZoneDecision = { zone: zone(soil), action: 'skip', reason: 'cooldown', reading: reading('s1', 10), detail: 'wait' };

    expect(applyForecast([moist, cooling], ctx())).toEqual([moist, cooling]);
  });
});

describe('applyDeviceState', () => {
  const water = (overrides: Parameters<typeof zone>[0] = {}, runMinutes = 10): ZoneDecision => {
    const z = zone(overrides);
    return { zone: z, action: 'water', reason: 'dry', runMinutes, reading: reading('s1', 10), detail: 'dry' };
  };

  it('passes decisions that are not "water" through untouched without commands', () => {
    const moist: ZoneDecision = { zone: zone(), action: 'none', reason: 'moist', detail: 'ok' };
    const noData: ZoneDecision = { zone: zone({ station: 2 }), action: 'skip', reason: 'no-data', detail: 'none' };

    const result = applyDeviceState([moist, noData], []);

    expect(result.decisions).toEqual([moist, noData]);
    expect(result.commands).toEqual([]);
  });

  it('builds a single-wave command for an idle, connected device', () => {
    const d = water({ station: 2 }, 7);

    const { decisions, commands } = applyDeviceState([d], [bhyveDevice('dev1')]);

    expect(decisions).toEqual([d]);
    expect(commands).toEqual([
      { deviceId: 'dev1', waves: [[{ station: 2, runTime: 7 }]], soakMinutes: 30, zones: [d.zone] },
    ]);
  });

  it('sends one command per device, with stations in order', () => {
    const decisions = [
      water({ deviceId: 'dev1', station: 3 }, 5),
      water({ deviceId: 'dev2', station: 1 }, 8),
      water({ deviceId: 'dev1', station: 1 }, 10),
    ];

    const { commands } = applyDeviceState(decisions, [bhyveDevice('dev1'), bhyveDevice('dev2')]);

    expect(commands.map((c) => [c.deviceId, c.waves])).toEqual([
      [
        'dev1',
        [
          [
            { station: 1, runTime: 10 },
            { station: 3, runTime: 5 },
          ],
        ],
      ],
      ['dev2', [[{ station: 1, runTime: 8 }]]],
    ]);
  });

  describe('cycle and soak', () => {
    it('splits a long run into waves no longer than maxCycleMinutes', () => {
      const d = water({ maxCycleMinutes: 15, soakMinutes: 45 }, 35);

      const { commands } = applyDeviceState([d], [bhyveDevice('dev1')]);

      expect(commands).toEqual([
        {
          deviceId: 'dev1',
          soakMinutes: 45,
          waves: [[{ station: 1, runTime: 11.7 }], [{ station: 1, runTime: 11.7 }], [{ station: 1, runTime: 11.6 }]],
          zones: [d.zone],
        },
      ]);
    });

    it('waters zones of one device wave by wave, so each zone soaks while the others run', () => {
      const decisions = [
        water({ station: 1, maxCycleMinutes: 15, soakMinutes: 30 }, 30), // 2 cycles
        water({ station: 2, maxCycleMinutes: 10, soakMinutes: 45 }, 25), // 3 cycles
        water({ station: 3, maxCycleMinutes: 20, soakMinutes: 20 }, 8), // 1 cycle
      ];

      const { commands } = applyDeviceState(decisions, [bhyveDevice('dev1')]);

      expect(commands[0]?.waves).toEqual([
        [
          { station: 1, runTime: 15 },
          { station: 2, runTime: 8.3 },
          { station: 3, runTime: 8 },
        ],
        [
          { station: 1, runTime: 15 },
          { station: 2, runTime: 8.4 },
        ],
        [{ station: 2, runTime: 8.3 }],
      ]);
      expect(commands[0]?.soakMinutes).toBe(45); // the longest soak of the zones involved
    });

    it('does not split runs that fit in one cycle', () => {
      const { commands } = applyDeviceState([water({ maxCycleMinutes: 20 }, 20)], [bhyveDevice('dev1')]);

      expect(commands[0]?.waves).toEqual([[{ station: 1, runTime: 20 }]]);
    });
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
    expect(decisions[0]?.reading?.moisturePct).toBe(10);
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
    expect(result.commands).toEqual([expect.objectContaining({ waves: [[{ station: 2, runTime: 10 }]] })]);
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
