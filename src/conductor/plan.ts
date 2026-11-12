import type { BhyveDevice, StationRun } from '../bhyve/types.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { ZoneConfig } from './config.ts';
import type { WateringHistoryView } from './history.ts';

/**
 * Pure decision logic: readings + config + history (+ device state) in, decisions out.
 * No I/O here, so every rule is unit-testable.
 */

const MINUTE_MS = 60_000;
/** Don't bother starting runs shorter than this when the daily cap is nearly used up. */
export const MIN_RUN_MINUTES = 1;

export type DecisionReason =
  /** Driest fresh reading is at or above the threshold. */
  | 'moist'
  /** Below threshold and cleared every check: water it. */
  | 'dry'
  /** No online, fresh, valid reading from any of the zone's sensors. */
  | 'no-data'
  | 'cooldown'
  | 'daily-limit'
  | 'device-not-found'
  | 'device-offline'
  | 'device-off'
  | 'rain-delay'
  | 'already-watering'
  | 'unknown-station';

export interface ZoneDecision {
  zone: ZoneConfig;
  /** `water`: start a run. `none`: nothing needed. `skip`: needs water but something prevents it. */
  action: 'water' | 'none' | 'skip';
  reason: DecisionReason;
  /** The lowest fresh reading among the zone's sensors, which drives the decision. */
  driest?: MoistureReading;
  /** Set when action is `water`. */
  runMinutes?: number;
  /** Human-readable explanation for logs. */
  detail: string;
}

export interface DeviceCommand {
  deviceId: string;
  /** All stations of the device to water, sent as one command: a second manual run would replace the first. */
  runs: StationRun[];
  zones: ZoneConfig[];
}

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

  const driest = usable.reduce<MoistureReading | undefined>(
    (min, r) => (min === undefined || r.moisturePct < min.moisturePct ? r : min),
    undefined,
  );
  if (!driest) {
    return { zone, action: 'skip', reason: 'no-data', detail: `no usable readings (${problems.join('; ')})` };
  }

  const reading = `${driest.sensorName} at ${fmt(driest.moisturePct)}%`;
  if (driest.moisturePct >= zone.thresholdPct) {
    return { zone, action: 'none', reason: 'moist', driest, detail: `${reading} (threshold ${fmt(zone.thresholdPct)}%)` };
  }

  const last = history.lastRun(zone.key);
  if (last) {
    const readyAt = new Date(last.at.getTime() + zone.cooldownMinutes * MINUTE_MS);
    if (now < readyAt) {
      return {
        zone,
        action: 'skip',
        reason: 'cooldown',
        driest,
        detail: `${reading} but last watered ${last.at.toISOString()}; cooling down until ${readyAt.toISOString()}`,
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
      driest,
      detail: `${reading} but already watered ${fmt(used)} of ${fmt(zone.maxMinutesPerDay)} min in the last 24h`,
    };
  }

  return {
    zone,
    action: 'water',
    reason: 'dry',
    driest,
    runMinutes: allowed,
    detail: `${reading} is below ${fmt(zone.thresholdPct)}%; watering ${fmt(allowed)} min`,
  };
};

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

    const cmd = commands.get(d.zone.deviceId) ?? { deviceId: d.zone.deviceId, runs: [], zones: [] };
    cmd.runs.push({ station: d.zone.station, runTime: d.runMinutes });
    cmd.zones.push(d.zone);
    commands.set(d.zone.deviceId, cmd);
    return d;
  });

  for (const cmd of commands.values()) cmd.runs.sort((a, b) => a.station - b.station);
  return { decisions: out, commands: [...commands.values()] };
};
