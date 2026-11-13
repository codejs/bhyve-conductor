import type { AuditSink } from '../audit/audit.ts';
import type { BhyveDevice } from '../bhyve/types.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { AlertOptions, ZoneConfig } from './config.ts';
import { readingProblem, type ZoneDecision } from './plan.ts';

/**
 * Health and safety checks beyond watering: batteries, critical moisture, controllers offline, and zones
 * that stay dry despite the full daily allowance. Each condition is audited when it starts and when it
 * ends, never on every poll, and a little hysteresis keeps values hovering at a limit from flapping.
 * The open conditions are saved with the state file, so a restart doesn't report them all again.
 */

/** Open conditions by key ("battery:sensor:abc", "moisture:dev1:1:abc", ...). */
export type AlertState = Record<string, { state: string; since: string }>;

/** A battery must recover this far above the low level before "low" can trigger again. */
export const BATTERY_HYSTERESIS_PCT = 10;
/** Moisture must come this far back inside the limits before a critical alert clears. */
export const MOISTURE_HYSTERESIS_PCT = 2;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export class AlertTracker {
  readonly #audit: AuditSink;
  readonly #options: AlertOptions;
  readonly #now: () => Date;
  readonly #open: Map<string, { state: string; since: Date }>;

  constructor(audit: AuditSink, options: AlertOptions, now: () => Date, initial: AlertState = {}) {
    this.#audit = audit;
    this.#options = options;
    this.#now = now;
    this.#open = new Map(Object.entries(initial).map(([k, v]) => [k, { state: v.state, since: new Date(v.since) }]));
  }

  /** Open conditions, to persist. */
  get state(): AlertState {
    return Object.fromEntries([...this.#open].map(([k, v]) => [k, { state: v.state, since: v.since.toISOString() }]));
  }

  /** Battery and critical moisture from sensor readings. Returns true if anything changed. */
  checkReadings(zones: readonly ZoneConfig[], readings: ReadonlyMap<string, MoistureReading>): boolean {
    let changed = false;
    for (const r of readings.values()) {
      if (r.batteryPct !== undefined) {
        changed = this.#battery(`battery:sensor:${r.sensorId}`, { kind: 'sensor', id: r.sensorId, name: r.sensorName }, r.batteryPct) || changed;
      }
    }
    const now = this.#now();
    for (const zone of zones) {
      for (const id of zone.sensorIds) {
        const r = readings.get(id);
        // Only trust fresh, valid readings; stale/offline sensors are reported as zone.no_data instead.
        if (!r || readingProblem(r, now, zone.maxReadingAgeMinutes)) continue;
        changed = this.#moisture(zone, r) || changed;
      }
    }
    return changed;
  }

  /** Controller connectivity and battery (hose timers). Returns true if anything changed. */
  checkDevices(devices: readonly BhyveDevice[]): boolean {
    let changed = false;
    for (const d of devices) {
      const key = `device:${d.id}`;
      const open = this.#open.get(key);
      if (d.is_connected === false && !open) {
        this.#set(key, 'offline');
        this.#audit.record('device.offline', { device: d.id, name: d.name });
        changed = true;
      } else if (d.is_connected !== false && open) {
        this.#open.delete(key);
        this.#audit.record('device.online', { device: d.id, name: d.name, offlineMinutes: this.#minutesSince(open.since) });
        changed = true;
      }
      const pct = d.battery?.percent;
      if (typeof pct === 'number') {
        changed = this.#battery(`battery:device:${d.id}`, { kind: 'timer', id: d.id, name: d.name }, pct) || changed;
      }
    }
    return changed;
  }

  /**
   * A zone that used its full daily allowance and is still below the threshold points at a broken valve,
   * a clogged nozzle, a misplaced sensor or an allowance set too low. Returns true if anything changed.
   */
  checkDecisions(decisions: readonly ZoneDecision[]): boolean {
    let changed = false;
    for (const d of decisions) {
      const key = `daily-limit:${d.zone.key}`;
      const open = this.#open.has(key);
      if (d.reason === 'daily-limit' && !open) {
        this.#set(key, 'reached');
        this.#audit.record('zone.daily_limit_reached', {
          zone: d.zone.key,
          name: d.zone.name,
          moisturePct: d.reading ? round1(d.reading.moisturePct) : undefined,
          thresholdPct: d.zone.thresholdPct,
          maxMinutesPerDay: d.zone.maxMinutesPerDay,
        });
        changed = true;
      } else if (d.reason !== 'daily-limit' && d.reason !== 'no-data' && open) {
        this.#open.delete(key); // over: it recovered or a new day's allowance started; no message needed
        changed = true;
      }
    }
    return changed;
  }

  #battery(key: string, who: { kind: 'sensor' | 'timer'; id: string; name: string }, pct: number): boolean {
    const low = this.#options.lowBatteryPct;
    const open = this.#open.get(key);
    if (!open && pct <= low) {
      this.#set(key, 'low');
      this.#audit.record('battery.low', { ...who, batteryPct: round1(pct), thresholdPct: low });
      return true;
    }
    if (open && pct >= low + BATTERY_HYSTERESIS_PCT) {
      this.#open.delete(key);
      this.#audit.record('battery.ok', { ...who, batteryPct: round1(pct) });
      return true;
    }
    return false;
  }

  #moisture(zone: ZoneConfig, r: MoistureReading): boolean {
    const key = `moisture:${zone.key}:${r.sensorId}`;
    const open = this.#open.get(key);
    const pct = r.moisturePct;
    const base = { zone: zone.key, name: zone.name, sensor: r.sensorId, sensorName: r.sensorName, moisturePct: round1(pct) };

    if (open?.state !== 'low' && pct < zone.criticalLowPct) {
      this.#set(key, 'low');
      this.#audit.record('moisture.critical_low', { ...base, limitPct: zone.criticalLowPct });
      return true;
    }
    if (open?.state !== 'high' && pct > zone.criticalHighPct) {
      this.#set(key, 'high');
      this.#audit.record('moisture.critical_high', { ...base, limitPct: zone.criticalHighPct });
      return true;
    }
    const recovered =
      (open?.state === 'low' && pct >= zone.criticalLowPct + MOISTURE_HYSTERESIS_PCT) ||
      (open?.state === 'high' && pct <= zone.criticalHighPct - MOISTURE_HYSTERESIS_PCT);
    if (open && recovered) {
      this.#open.delete(key);
      this.#audit.record('moisture.normal', { ...base, was: open.state, minutes: this.#minutesSince(open.since) });
      return true;
    }
    return false;
  }

  #set(key: string, state: string): void {
    this.#open.set(key, { state, since: this.#now() });
  }

  #minutesSince(since: Date): number {
    return round1((this.#now().getTime() - since.getTime()) / 60_000);
  }
}
