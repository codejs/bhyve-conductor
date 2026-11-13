import type { ForecastHour } from '../weather/types.ts';

/**
 * How much supplemental water a dry zone needs, given the next few days of weather and the B-hyve
 * schedule. Hour-by-hour soil water balance (the "checkbook" method used for irrigation scheduling):
 *
 *   soil water (in) = moisture % × root depth
 *   each hour:  − crop water use   (ET₀ × crop coefficient)
 *               + effective rain   (forecast precip × chance of rain × rain efficiency)
 *               + scheduled runs   (B-hyve run minutes × sprinkler precipitation rate)
 *   anything above the target (≈ field capacity) drains below the roots and is wasted.
 *
 * Decision, for a zone that is below its threshold:
 *  1. Wait: if forecast rain or a scheduled run brings the soil back to the threshold within
 *     `maxWaitHours`, don't water now.
 *  2. Otherwise refill toward the target (deep, infrequent watering is better for turf than frequent sips),
 *     minus whatever rain and scheduled runs will add in the window, so none of it drains away
 *     (no overwatering)...
 *  3. ...but never less than it takes to stay at or above the threshold for the whole window
 *     (no underwatering). If that needs more than the root zone holds, fill it; the monitor tops up later.
 */

export interface SoilSettings {
  thresholdPct: number;
  /** Refill level, roughly field capacity. Water beyond it drains away. */
  targetPct: number;
  /** Depth of the root zone the sensor represents, in inches. */
  rootDepthIn: number;
  /** Turf water use relative to ET₀: ~0.8 for cool-season grass, ~0.6 for warm-season. */
  cropCoefficient: number;
  /** Share of rainfall that actually soaks into the root zone (0–1). */
  rainEfficiency: number;
  /** How many inches per hour this zone's sprinklers apply (measure with a catch-cup test). */
  precipRateInPerHour: number;
  /** How long a dry zone may wait for forecast rain or a scheduled run before we water it ourselves. */
  maxWaitHours: number;
}

export interface WaterBudgetInput {
  now: Date;
  moisturePct: number;
  soil: SoilSettings;
  /** Forecast hours covering the window (see sliceForecast). */
  forecast: readonly ForecastHour[];
  /** This zone's upcoming B-hyve runs within the window. */
  scheduled: readonly { start: Date; minutes: number }[];
  /** How long the zone has already been below the threshold; counts against `maxWaitHours`. */
  waitedHours: number;
}

export interface WaterBudget {
  /** Supplemental water to apply now, in inches (0 = none needed). */
  inches: number;
  /** Run time for `inches` at the zone's precipitation rate, rounded up to whole minutes. */
  minutes: number;
  startIn: number;
  thresholdIn: number;
  targetIn: number;
  /** Totals over the window. */
  cropUseIn: number;
  rainIn: number;
  scheduledIn: number;
  windowHours: number;
  waitHours: number;
  /** True if the root zone can't hold enough to last the whole window. */
  limitedByCapacity: boolean;
  summary: string;
}

const MM_PER_IN = 25.4;
const HOUR_MS = 3_600_000;
/** Water amounts below this are noise (≈ 0.025 mm). */
const EPSILON_IN = 0.001;

interface WaterEvent {
  at: number;
  deltaIn: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const computeWaterBudget = (input: WaterBudgetInput): WaterBudget => {
  const { now, moisturePct, soil, forecast, scheduled, waitedHours } = input;
  const depth = soil.rootDepthIn;
  const startIn = (moisturePct / 100) * depth;
  const thresholdIn = (soil.thresholdPct / 100) * depth;
  const targetIn = (soil.targetPct / 100) * depth;
  const t0 = now.getTime();

  let cropUseIn = 0;
  let rainIn = 0;
  let scheduledIn = 0;
  const events: WaterEvent[] = [];

  for (const h of forecast) {
    const use = (h.et0Mm * soil.cropCoefficient) / MM_PER_IN;
    const chance = h.precipProbabilityPct === undefined ? 1 : h.precipProbabilityPct / 100;
    const rain = (h.precipMm * chance * soil.rainEfficiency) / MM_PER_IN;
    cropUseIn += use;
    rainIn += rain;
    events.push({ at: h.end.getTime(), deltaIn: rain - use });
  }
  for (const run of scheduled) {
    const water = (run.minutes / 60) * soil.precipRateInPerHour;
    scheduledIn += water;
    events.push({ at: run.start.getTime(), deltaIn: water });
  }
  events.sort((a, b) => a.at - b.at);

  const windowEnd = Math.max(t0, ...events.map((e) => e.at));
  const windowHours = Math.floor((windowEnd - t0) / HOUR_MS);
  const waitHours = Math.max(0, soil.maxWaitHours - waitedHours);
  const waitEnd = t0 + waitHours * HOUR_MS;

  /** Soil water after each event if we apply `extra` inches now (index 0 = right now). */
  const trajectory = (extra: number): { at: number; level: number }[] => {
    let level = Math.min(startIn + extra, Math.max(targetIn, startIn));
    const out = [{ at: t0, level }];
    for (const e of events) {
      level = Math.min(targetIn, level + e.deltaIn);
      out.push({ at: e.at, level });
    }
    return out;
  };
  const natural = trajectory(0);

  const pct = (inchesValue: number) => `${round2((inchesValue / depth) * 100)}%`;
  const head =
    `soil ${round2(startIn)}in (${pct(startIn)}), threshold ${round2(thresholdIn)}in, target ${round2(targetIn)}in; ` +
    `next ${windowHours}h: crop use −${round2(cropUseIn)}in, rain +${round2(rainIn)}in, scheduled +${round2(scheduledIn)}in`;
  const result = (inches: number, limitedByCapacity: boolean, decision: string): WaterBudget => {
    const amount = inches < EPSILON_IN ? 0 : inches;
    // Round up so the amount is actually delivered; the tolerance keeps float noise (10.0000001) from adding a minute.
    const minutes = amount === 0 ? 0 : Math.ceil((amount / soil.precipRateInPerHour) * 60 - 0.01);
    return {
      inches: amount,
      minutes,
      startIn,
      thresholdIn,
      targetIn,
      cropUseIn,
      rainIn,
      scheduledIn,
      windowHours,
      waitHours,
      limitedByCapacity,
      summary: `${head} → ${amount === 0 ? decision : `apply ${round2(amount)}in (${minutes} min)${decision}`}`,
    };
  };

  // 1. Will rain or a scheduled run bring it back to the threshold soon enough on its own?
  const relief = natural.find((p) => p.at > t0 && p.at <= waitEnd && p.level >= thresholdIn - EPSILON_IN);
  if (relief) {
    const inHours = round2((relief.at - t0) / HOUR_MS);
    return result(0, false, `no water now: rain/scheduled watering restores the threshold within ${inHours}h`);
  }

  // 2. Refill toward the target without pushing any later point past it (that water would drain away).
  const capacity = Math.max(0, targetIn - startIn);
  const fill = Math.max(0, Math.min(capacity, ...natural.map((p) => targetIn - p.level)));

  // 3. The least that keeps the soil at or above the threshold throughout. Water applied now only helps
  //    until the soil next fills up (after that it has drained away), so at each point we require the
  //    threshold or the most any amount applied now could achieve there, whichever is lower. Levels
  //    never decrease as the amount grows, so bisect.
  const best = trajectory(capacity);
  const required = best.map((p) => Math.min(thresholdIn, p.level) - EPSILON_IN / 10);
  const enough = (extra: number) => trajectory(extra).every((p, i) => p.level >= (required[i] ?? 0));
  // A dip below the threshold that no amount applied now can prevent: the monitor will water again then.
  const limitedByCapacity = best.some((p) => p.level < thresholdIn - EPSILON_IN);

  let minimum = 0;
  if (!enough(0)) {
    let lo = 0;
    let hi = capacity;
    while (hi - lo > EPSILON_IN / 10) {
      const mid = (lo + hi) / 2;
      if (enough(mid)) hi = mid;
      else lo = mid;
    }
    minimum = hi;
  }

  const later = limitedByCapacity ? '; more will be needed before the window ends' : '';
  if (fill >= minimum) {
    const what = fill >= capacity - EPSILON_IN ? ', refills to target' : ', refills to target less expected rain/scheduled water';
    return result(fill, limitedByCapacity, what + later);
  }
  return result(minimum, limitedByCapacity, ', the least that stays above the threshold until rain/scheduled water refills it' + later);
};
