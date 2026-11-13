import { describe, expect, it } from 'vitest';
import { computeWaterBudget, type SoilSettings, type WaterBudgetInput } from '../../conductor/water-budget.ts';
import type { ForecastHour } from '../../weather/types.ts';
import { NOW } from '../utils/conductor.ts';

/*
 * Round numbers so expected values can be checked by hand:
 *   root depth 10in → 1% moisture = 0.1in; threshold 30% = 3.0in; target 40% = 4.0in
 *   crop coefficient 1, rain efficiency 1, sprinklers 1in/h → 1 min = 1/60 in
 *   ET₀ 0.254mm/h = 0.01in/h → 0.72in of crop use over 72h
 */
const HOUR_MS = 3_600_000;
const IN = 25.4; // mm

const SOIL: SoilSettings = {
  thresholdPct: 30,
  targetPct: 40,
  rootDepthIn: 10,
  cropCoefficient: 1,
  rainEfficiency: 1,
  precipRateInPerHour: 1,
  maxWaitHours: 6,
};

/** 72 forecast hours of 0.01in/h crop use; `rain` maps hour index → [inches, chance %]. */
const hours = (rain: Record<number, [inches: number, chancePct?: number]> = {}, et0InPerHour = 0.01, count = 72) =>
  Array.from({ length: count }, (_, i): ForecastHour => {
    const [inches = 0, chance] = rain[i] ?? [];
    return {
      end: new Date(NOW.getTime() + (i + 1) * HOUR_MS),
      et0Mm: et0InPerHour * IN,
      precipMm: inches * IN,
      ...(chance !== undefined ? { precipProbabilityPct: chance } : {}),
    };
  });

const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR_MS);

const budget = (overrides: Omit<Partial<WaterBudgetInput>, 'soil'> & { soil?: Partial<SoilSettings> } = {}) =>
  computeWaterBudget({
    now: NOW,
    moisturePct: 25,
    forecast: hours(),
    scheduled: [],
    waitedHours: 0,
    ...overrides,
    soil: { ...SOIL, ...overrides.soil },
  });

describe('computeWaterBudget', () => {
  describe('totals', () => {
    it('converts moisture % and the forecast into inches over the window', () => {
      const b = budget({ forecast: hours({ 10: [0.3] }), scheduled: [{ start: inHours(20), minutes: 30 }] });

      expect(b.startIn).toBeCloseTo(2.5);
      expect(b.thresholdIn).toBeCloseTo(3.0);
      expect(b.targetIn).toBeCloseTo(4.0);
      expect(b.cropUseIn).toBeCloseTo(0.72);
      expect(b.rainIn).toBeCloseTo(0.3);
      expect(b.scheduledIn).toBeCloseTo(0.5); // 30 min at 1in/h
      expect(b.windowHours).toBe(72);
    });

    it('scales crop use by the crop coefficient', () => {
      expect(budget({ soil: { cropCoefficient: 0.6 } }).cropUseIn).toBeCloseTo(0.432);
    });

    it('discounts rain by its chance and by rain efficiency', () => {
      expect(budget({ forecast: hours({ 10: [1, 50] }) }).rainIn).toBeCloseTo(0.5);
      expect(budget({ forecast: hours({ 10: [1, 50] }), soil: { rainEfficiency: 0.8 } }).rainIn).toBeCloseTo(0.4);
      expect(budget({ forecast: hours({ 10: [1] }) }).rainIn).toBeCloseTo(1); // no chance given → counted in full
    });

    it('converts scheduled minutes with the zone sprinkler rate', () => {
      const scheduled = [{ start: inHours(20), minutes: 30 }];
      expect(budget({ scheduled, soil: { precipRateInPerHour: 1.5 } }).scheduledIn).toBeCloseTo(0.75);
    });
  });

  describe('hot and dry: refill to target', () => {
    it('refills to the target when that also lasts the whole window', () => {
      // Needs at least 0.5 (to threshold) + 0.72 (crop use) = 1.22; refilling is 1.5.
      const b = budget();

      expect(b.inches).toBeCloseTo(1.5, 2);
      expect(b.minutes).toBe(90);
      expect(b.limitedByCapacity).toBe(false);
      expect(b.summary).toContain('refills to target');
    });

    it('fills the root zone and says so when even that will not last the window', () => {
      // 0.05in/h × 72h = 3.6in of crop use: far more than the 1.5in the root zone can take.
      const b = budget({ forecast: hours({}, 0.05) });

      expect(b.inches).toBeCloseTo(1.5, 2);
      expect(b.limitedByCapacity).toBe(true);
      expect(b.summary).toContain('more will be needed before the window ends');
    });

    it('scales with how dry the soil is', () => {
      expect(budget({ moisturePct: 29 }).inches).toBeCloseTo(1.1, 2);
      expect(budget({ moisturePct: 20 }).inches).toBeCloseTo(2.0, 2);
    });

    it('uses the zone target', () => {
      expect(budget({ soil: { targetPct: 35 } }).inches).toBeCloseTo(1.0, 2);
    });
  });

  describe('rain in the forecast', () => {
    it('waits when rain restores the threshold within maxWaitHours', () => {
      // 2.9in now; after hour 2 (ending at +3h): 2.9 − 0.03 + 0.5 = 3.37 ≥ 3.0.
      const b = budget({ moisturePct: 29, forecast: hours({ 2: [0.5] }) });

      expect(b.inches).toBe(0);
      expect(b.minutes).toBe(0);
      expect(b.summary).toContain('no water now: rain/scheduled watering restores the threshold within 3h');
    });

    it('does not wait for rain that is too small to restore the threshold', () => {
      // 2.5 − 0.03 + 0.2 = 2.67 < 3.0
      expect(budget({ forecast: hours({ 2: [0.2] }) }).inches).toBeGreaterThan(0);
    });

    it('does not wait for rain beyond maxWaitHours, but leaves room for it', () => {
      // Rain of 0.5in in the hour ending at +10h. Without watering, the soil peaks at
      // 2.9 − 0.10 + 0.5 = 3.3 then, so 0.7in fills to the target with no runoff.
      const b = budget({ moisturePct: 29, forecast: hours({ 9: [0.5] }) });

      expect(b.inches).toBeCloseTo(0.7, 2);
      expect(b.summary).toContain('refills to target less expected rain');
    });

    it('applies only enough to bridge to heavy rain that will fill the soil anyway', () => {
      // 2in of rain in the hour ending at +24h fills the soil regardless. Until it arrives we need
      // 0.1 (to threshold) + 0.23 (crop use of the 23 hours before it).
      const b = budget({ moisturePct: 29, forecast: hours({ 23: [2] }) });

      expect(b.inches).toBeCloseTo(0.33, 2);
      expect(b.summary).toContain('the least that stays above the threshold');
    });

    it('does not pre-fill for a later dip when rain will refill the soil in between', () => {
      // 1.5in of rain in the hour ending at +1h fills the soil to the target whatever we apply now (the
      // excess drains). Three dry days then take it just under the threshold at the end: 4.0 − 70 × 0.015
      // = 2.95. Water applied now can't help with that dip, so only bridge to the rain (0.1in) and leave
      // the dip for a later cycle, rather than filling the root zone (1.1in) just before a downpour.
      const forecast = hours({ 0: [1.5] }, 0.015);
      const b = budget({ moisturePct: 29, forecast, soil: { maxWaitHours: 0 } });

      expect(b.inches).toBeCloseTo(0.1, 2);
      expect(b.limitedByCapacity).toBe(true);
      expect(b.summary).toContain('more will be needed before the window ends');
    });

    it('gives unlikely rain little weight', () => {
      // 0.5in at 20%: 0.1in expected, not enough to wait for.
      const b = budget({ moisturePct: 29, forecast: hours({ 2: [0.5, 20] }) });

      expect(b.inches).toBeGreaterThan(0);
    });

    it('stops waiting once the zone has already waited maxWaitHours', () => {
      const b = budget({ moisturePct: 29, forecast: hours({ 2: [0.5] }), waitedHours: 6 });

      expect(b.waitHours).toBe(0);
      // Must be at the threshold now (0.1); after the rain the soil peaks at 3.37 + x, so x ≤ 0.63 avoids runoff.
      expect(b.inches).toBeCloseTo(0.63, 2);
    });

    it('only waits for what is left of maxWaitHours', () => {
      const rainAt4h = hours({ 3: [0.5] });

      expect(budget({ moisturePct: 29, forecast: rainAt4h, waitedHours: 1 }).inches).toBe(0); // 5h left
      expect(budget({ moisturePct: 29, forecast: rainAt4h, waitedHours: 3 }).inches).toBeGreaterThan(0); // 3h left
    });

    it('never waits when maxWaitHours is 0', () => {
      expect(budget({ moisturePct: 29, forecast: hours({ 0: [1] }), soil: { maxWaitHours: 0 } }).inches).toBeGreaterThan(0);
    });
  });

  describe('the existing B-hyve schedule', () => {
    it('waits for a scheduled run that restores the threshold soon', () => {
      const b = budget({ moisturePct: 29, scheduled: [{ start: inHours(2), minutes: 30 }] });

      expect(b.inches).toBe(0);
    });

    it('subtracts a later scheduled run from the refill so it does not overfill', () => {
      // Run of 0.5in at +18h. Without watering the soil peaks right after it: 2.5 − 0.18 + 0.5 = 2.82,
      // so 1.18in fills to the target with no runoff.
      const b = budget({ scheduled: [{ start: inHours(18), minutes: 30 }] });

      expect(b.inches).toBeCloseTo(1.18, 2);
      expect(b.minutes).toBe(71);
    });

    it('counts rain and scheduled runs together', () => {
      const b = budget({
        forecast: hours({ 9: [0.3] }),
        scheduled: [{ start: inHours(18), minutes: 30 }],
      });

      // Peak without watering: 2.5 − 0.18 + 0.3 + 0.5 = 3.12 → refill 0.88.
      expect(b.inches).toBeCloseTo(0.88, 2);
    });
  });

  describe('run time', () => {
    it('rounds run time up to whole minutes', () => {
      // At 1.5in/h the 30-min scheduled run applies 0.75in, so the soil peaks at 2.5 − 0.18 + 0.75 = 3.07.
      // Refill 0.93in at 1.5in/h = 37.2 min → 38.
      const b = budget({ scheduled: [{ start: inHours(18), minutes: 30 }], soil: { precipRateInPerHour: 1.5 } });

      expect(b.inches).toBeCloseTo(0.93, 2);
      expect(b.minutes).toBe(38);
    });

    it('does not add a minute for floating-point noise', () => {
      // Target 34% → fill 0.9in (computed as 0.9000000000000004), at 1.5in/h exactly 36 min.
      expect(budget({ soil: { targetPct: 34, precipRateInPerHour: 1.5 } }).minutes).toBe(36);
    });
  });

  it('handles a window with no forecast hours (refill to target)', () => {
    const b = budget({ forecast: [] });

    expect(b.inches).toBeCloseTo(1.5, 2);
    expect(b.windowHours).toBe(0);
  });
});
