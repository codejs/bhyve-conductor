import type { ScheduledRun } from '../bhyve/schedule.ts';
import type { BhyveDevice, StationRun } from '../bhyve/types.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { ForecastHour } from '../weather/types.ts';
import type { ZoneConfig } from './config.ts';
import type { WateringHistoryView } from './history.ts';
import { computeWaterBudget, type WaterBudget } from './water-budget.ts';

/**
 * Pure decision logic: readings + config + history (+ device state) in, decisions out.
 * No I/O here, so every rule is unit-testable.
 */

const MINUTE_MS = 60_000;
/** Don't bother starting runs shorter than this when the daily cap is nearly used up. */
export const MIN_RUN_MINUTES = 1;
/** Longest manual run B-hyve accepts. */
export const MAX_RUN_MINUTES = 240;

export type DecisionReason =
  /** Driest fresh reading is at or above the threshold. */
  | 'moist'
  /** Below threshold and cleared every check: water it. */
  | 'dry'
  /** Below threshold, but forecast rain and/or scheduled B-hyve runs will cover it. */
  | 'forecast-covered'
  /** No online, fresh, valid reading from any of the zone's sensors. */
  | 'no-data'
  | 'cooldown'
  | 'daily-limit'
  | 'device-not-found'
  | 'device-offline'
  | 'device-off'
  | 'rain-delay'
  | 'already-watering'
  /** The device is mid cycle-and-soak; new runs would cut that sequence short. */
  | 'soaking'
  | 'unknown-station';

export interface ZoneDecision {
  zone: ZoneConfig;
  /** `water`: start a run. `none`: nothing needed. `skip`: needs water but something prevents it. */
  action: 'water' | 'none' | 'skip';
  reason: DecisionReason;
  /**
   * The moisture value that drove the decision: the driest sensor, or a synthetic average/median
   * reading, depending on the zone's `sensorAggregation`.
   */
  reading?: MoistureReading;
  /** Set when action is `water`. */
  runMinutes?: number;
  /** Most this zone may run now under the daily cap (set when action is `water`). */
  allowanceMinutes?: number;
  /** The forecast-based calculation, when one was made. */
  budget?: WaterBudget;
  /** Human-readable explanation for logs. */
  detail: string;
}

export interface DeviceCommand {
  deviceId: string;
  /**
   * Cycle-and-soak: the stations to water, split into waves. Each wave is sent as one command (B-hyve
   * runs its stations back to back; a second command would replace the first), and the next wave is sent
   * after the wave has finished plus `soakMinutes`, giving the water time to soak in instead of running off.
   */
  waves: StationRun[][];
  /** Pause between waves (the largest soakMinutes of the zones involved). */
  soakMinutes: number;
  zones: ZoneConfig[];
}

/** Splits a run into the fewest near-equal cycles of at most `maxMinutes` (tenth-of-a-minute steps). */
export const splitRun = (totalMinutes: number, maxMinutes: number): number[] => {
  const count = Math.max(1, Math.ceil(totalMinutes / maxMinutes - 1e-9));
  const cycles: number[] = [];
  let remaining = totalMinutes;
  for (let i = count; i >= 1; i--) {
    const part = Math.round((remaining / i) * 10) / 10;
    cycles.push(part);
    remaining = Math.round((remaining - part) * 10) / 10;
  }
  return cycles;
};

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/** Why a reading can't be trusted, or undefined if it's usable. */
export const readingProblem = (r: MoistureReading, now: Date, maxAgeMinutes: number): string | undefined => {
  if (!r.online) return 'offline';
  if (!Number.isFinite(r.moisturePct) || r.moisturePct < 0 || r.moisturePct > 100) {
    return `invalid moisture ${r.moisturePct}`;
  }
  const ageMin = (now.getTime() - r.at.getTime()) / MINUTE_MS;
  if (!Number.isFinite(ageMin)) return 'invalid timestamp';
  if (ageMin > maxAgeMinutes) return `stale (${Math.round(ageMin)} min old)`;
  return undefined;
};

/** Combines the usable readings of a zone into the one value decisions are made from. */
export const aggregateReadings = (
  usable: readonly MoistureReading[],
  how: 'driest' | 'average' | 'median',
): MoistureReading | undefined => {
  if (usable.length === 0) return undefined;
  if (how === 'driest' || usable.length === 1) {
    return usable.reduce((min, r) => (r.moisturePct < min.moisturePct ? r : min));
  }
  const sorted = [...usable].sort((a, b) => a.moisturePct - b.moisturePct);
  const mid = sorted.length / 2;
  const moisturePct =
    how === 'average'
      ? sorted.reduce((sum, r) => sum + r.moisturePct, 0) / sorted.length
      : sorted.length % 2
        ? (sorted[Math.floor(mid)] as MoistureReading).moisturePct
        : ((sorted[mid - 1] as MoistureReading).moisturePct + (sorted[mid] as MoistureReading).moisturePct) / 2;
  const each = sorted.map((r) => `${r.sensorName} ${fmt(r.moisturePct)}%`).join(', ');
  return {
    sensorId: sorted.map((r) => r.sensorId).join('+'),
    sensorName: `${how} of ${sorted.length} sensors (${each})`,
    moisturePct,
    online: true,
    // The oldest reading involved, so staleness can never be hidden by the aggregation.
    at: new Date(Math.min(...sorted.map((r) => r.at.getTime()))),
  };
};

/** Step 1: decide from sensor readings and watering history alone. */
export const evaluateZone = (
  zone: ZoneConfig,
  readings: ReadonlyMap<string, MoistureReading>,
  history: WateringHistoryView,
  now: Date,
): ZoneDecision => {
  const usable: MoistureReading[] = [];
  const problems: string[] = [];
  for (const id of zone.sensorIds) {
    const r = readings.get(id);
    const problem = r ? readingProblem(r, now, zone.maxReadingAgeMinutes) : 'no reading';
    if (r && !problem) usable.push(r);
    else problems.push(`${id}: ${problem}`);
  }

  const reading = aggregateReadings(usable, zone.sensorAggregation);
  if (!reading) {
    return { zone, action: 'skip', reason: 'no-data', detail: `no usable readings (${problems.join('; ')})` };
  }

  const level = `${reading.sensorName} at ${fmt(reading.moisturePct)}%`;
  if (reading.moisturePct >= zone.thresholdPct) {
    return { zone, action: 'none', reason: 'moist', reading, detail: `${level} (threshold ${fmt(zone.thresholdPct)}%)` };
  }

  const last = history.lastRun(zone.key);
  if (last) {
    const readyAt = new Date(last.at.getTime() + zone.cooldownMinutes * MINUTE_MS);
    if (now < readyAt) {
      return {
        zone,
        action: 'skip',
        reason: 'cooldown',
        reading,
        detail: `${level} but last watered ${last.at.toISOString()}; cooling down until ${readyAt.toISOString()}`,
      };
    }
  }

  const used = history.minutesInLastDay(zone.key, now);
  const allowed = Math.min(zone.runMinutes, zone.maxMinutesPerDay - used);
  if (allowed < MIN_RUN_MINUTES) {
    return {
      zone,
      action: 'skip',
      reason: 'daily-limit',
      reading,
      detail: `${level} but already watered ${fmt(used)} of ${fmt(zone.maxMinutesPerDay)} min in the last 24h`,
    };
  }

  return {
    zone,
    action: 'water',
    reason: 'dry',
    reading,
    runMinutes: allowed,
    allowanceMinutes: Math.min(MAX_RUN_MINUTES, zone.maxMinutesPerDay - used),
    detail: `${level} is below ${fmt(zone.thresholdPct)}%; watering ${fmt(allowed)} min`,
  };
};

export interface ForecastContext {
  now: Date;
  /** Forecast hours covering the look-ahead window. */
  forecast: readonly ForecastHour[];
  /** Upcoming B-hyve runs within the window, all devices. */
  schedule: readonly ScheduledRun[];
  /** How long each zone (by key) has been below its threshold, in hours. */
  waitedHours: (zoneKey: string) => number;
}

/**
 * Step 1½: replace the fixed run length of each zone that needs water with a forecast-based amount:
 * less (or nothing) when rain or a scheduled run is coming, more on hot dry days, never more than the
 * soil holds or the daily cap allows. Zones without a sprinkler rate keep the fixed run length.
 */
export const applyForecast = (decisions: readonly ZoneDecision[], ctx: ForecastContext): ZoneDecision[] =>
  decisions.map((d): ZoneDecision => {
    const { zone, reading, allowanceMinutes } = d;
    if (d.action !== 'water' || !reading || allowanceMinutes === undefined || zone.precipRateInPerHour === undefined) {
      return d;
    }

    const budget = computeWaterBudget({
      now: ctx.now,
      moisturePct: reading.moisturePct,
      soil: { ...zone, precipRateInPerHour: zone.precipRateInPerHour },
      forecast: ctx.forecast,
      scheduled: ctx.schedule.filter((r) => r.deviceId === zone.deviceId && r.station === zone.station),
      waitedHours: ctx.waitedHours(zone.key),
    });
    const level = `${reading.sensorName} at ${fmt(reading.moisturePct)}%`;

    if (budget.minutes < MIN_RUN_MINUTES) {
      const { runMinutes: _r, allowanceMinutes: _a, ...rest } = d;
      return { ...rest, action: 'none', reason: 'forecast-covered', budget, detail: `${level}: ${budget.summary}` };
    }
    const runMinutes = Math.min(budget.minutes, allowanceMinutes);
    const capped = runMinutes < budget.minutes ? `; capped at ${fmt(runMinutes)} min by the daily limit` : '';
    return { ...d, runMinutes, budget, detail: `${level}: ${budget.summary}${capped}` };
  });

/** Why a device can't take a manual run right now, or undefined if it can. */
const deviceProblem = (device: BhyveDevice | undefined): { reason: DecisionReason; detail: string } | undefined => {
  if (!device) return { reason: 'device-not-found', detail: 'B-hyve device not found on this account' };
  if (device.is_connected === false) return { reason: 'device-offline', detail: `${device.name} is not connected` };
  const status = device.status;
  if (status?.run_mode === 'off') return { reason: 'device-off', detail: `${device.name} is switched off` };
  if (typeof status?.rain_delay === 'number' && status.rain_delay > 0) {
    return { reason: 'rain-delay', detail: `${device.name} has a ${status.rain_delay}h rain delay` };
  }
  if (status?.watering_status) return { reason: 'already-watering', detail: `${device.name} is already watering` };
  return undefined;
};

/**
 * Step 2: check the zones that need water against live B-hyve device state and group them into
 * one command per device. Decisions that aren't `water` pass through unchanged.
 */
export const applyDeviceState = (
  decisions: readonly ZoneDecision[],
  devices: readonly BhyveDevice[],
): { decisions: ZoneDecision[]; commands: DeviceCommand[] } => {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const commands = new Map<string, DeviceCommand>();

  const out = decisions.map((d): ZoneDecision => {
    if (d.action !== 'water' || d.runMinutes === undefined) return d;
    const device = byId.get(d.zone.deviceId);

    const problem = deviceProblem(device);
    if (problem) return { ...d, action: 'skip', reason: problem.reason, detail: `${d.detail}, but ${problem.detail}` };

    const stations = device?.zones?.map((z) => z.station) ?? [];
    if (stations.length > 0 && !stations.includes(d.zone.station)) {
      return {
        ...d,
        action: 'skip',
        reason: 'unknown-station',
        detail: `${d.detail}, but ${device?.name} has no station ${d.zone.station} (has ${stations.join(', ')})`,
      };
    }

    const cmd = commands.get(d.zone.deviceId) ?? { deviceId: d.zone.deviceId, waves: [], soakMinutes: 0, zones: [] };
    splitRun(d.runMinutes, d.zone.maxCycleMinutes).forEach((minutes, i) => {
      (cmd.waves[i] ??= []).push({ station: d.zone.station, runTime: minutes });
    });
    cmd.soakMinutes = Math.max(cmd.soakMinutes, d.zone.soakMinutes);
    cmd.zones.push(d.zone);
    commands.set(d.zone.deviceId, cmd);
    return d;
  });

  for (const cmd of commands.values()) {
    for (const wave of cmd.waves) wave.sort((a, b) => a.station - b.station);
  }
  return { decisions: out, commands: [...commands.values()] };
};
