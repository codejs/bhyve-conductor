import { errorMessage, type AuditSink } from '../audit/audit.ts';
import { ConnectionHealth } from '../audit/health.ts';
import type { BhyveClient } from '../bhyve/client.ts';
import { systemClock, type Clock, type TimerHandle } from '../clock.ts';
import { upcomingRuns, type ScheduledRun } from '../bhyve/schedule.ts';
import type { BhyveDevice } from '../bhyve/types.ts';
import { log } from '../log.ts';
import type { MoistureReading, MoistureSource } from '../sensors/types.ts';
import type { ForecastHour, WeatherProvider } from '../weather/types.ts';
import { AlertTracker, type AlertState } from './alerts.ts';
import type { ConductorConfig } from './config.ts';
import type { WateringHistory } from './history.ts';
import { applyDeviceState, applyForecast, evaluateZone, type DeviceCommand, type ZoneDecision } from './plan.ts';
import { Sequencer } from './sequencer.ts';
import type { PendingSequence } from './state.ts';
import { guardStore, noStore, type ConductorStore, type SavedZoneSpell } from './store.ts';

/** The parts of BhyveClient the monitor needs (lets tests pass a fake). */
export type BhyveControl = Pick<BhyveClient, 'getDevices' | 'getDevice' | 'getPrograms' | 'startWatering' | 'onEvent'>;

export interface MonitorDeps {
  config: ConductorConfig;
  source: MoistureSource;
  bhyve: BhyveControl;
  history: WateringHistory;
  /** Sequences saved by a previous run, resumed by start() / resumePending(). */
  pendingSequences?: PendingSequence[];
  /** Alert conditions saved by a previous run (so they aren't reported again). */
  alertState?: AlertState;
  /** Zone dry spells and sensor blackouts saved by a previous run (see #restoreSpells). */
  zoneSpells?: readonly SavedZoneSpell[];
  /**
   * Where to persist every step (watering, alerts, readings, spells). Omit to keep them in memory only.
   * Ignored in dry runs, which must leave no trace that would change the real service's decisions.
   */
  store?: ConductorStore;
  /** Called after every poll, successful or not (the service run's heartbeat). */
  heartbeat?: () => void;
  /** Enables forecast-based amounts. Without it, dry zones get their fixed `runMinutes`. */
  weather?: WeatherProvider;
  /** Audit trail for connectivity and watering events. */
  audit?: AuditSink;
  /** Time and timers (default: the system's). `now` overrides just the time. */
  clock?: Clock;
  now?: () => Date;
}

export interface CycleResult {
  at: Date;
  decisions: ZoneDecision[];
  /** Commands whose first wave was delivered (or, in dry-run mode, would have been). */
  sent: DeviceCommand[];
  /** Commands whose first wave couldn't be delivered now (they may still be retrying). */
  failed: { command: DeviceCommand; error: unknown }[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/**
 * Watchdog for one poll. Every remote call has its own timeout, so this only fires on a hang nobody
 * anticipated; the loop then carries on instead of stopping for good.
 */
export const POLL_DEADLINE_MS = 10 * MINUTE_MS;
/** Decision reasons that mean the soil is below the threshold right now. */
const BELOW_THRESHOLD = new Set(['dry', 'cooldown', 'daily-limit', 'forecast-covered']);
/** Skip reasons that are normal operation rather than something to look into. */
const EXPECTED_SKIPS = new Set(['cooldown', 'daily-limit', 'rain-delay', 'already-watering', 'soaking']);

const noAudit: AuditSink = { record: () => {} };
/** Saved spells older than this many poll intervals are stale: the service was down in between. */
const SPELL_FRESH_POLLS = 2;

/**
 * Polls the soil sensors and starts a supplemental B-hyve run for each zone whose soil is
 * below its threshold. The regular B-hyve schedule is left as is, and these runs are added on top.
 * Watering itself (cycles, confirmation, retries, restarts) is handled by the Sequencer.
 */
export class Monitor {
  readonly #deps: MonitorDeps;
  readonly #now: () => Date;
  readonly #audit: AuditSink;
  readonly #health: ConnectionHealth;
  readonly #sequencer: Sequencer;
  readonly #alerts: AlertTracker;
  readonly #clock: Clock;
  #lastDeviceCheck: Date | undefined;
  #timer: TimerHandle | undefined;
  #running = false;
  #resumed = false;
  #inFlight: Promise<unknown> | undefined;
  readonly #store: ConductorStore;
  /** When each zone was first seen below its threshold in the current dry spell. */
  readonly #drySince = new Map<string, Date>();
  /** Zones currently without any usable sensor reading, and since when. */
  readonly #noDataSince = new Map<string, Date>();
  /** Last decision reason per zone, to audit changes only. */
  readonly #lastReason = new Map<string, string>();

  constructor(deps: MonitorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#now = deps.now ?? (() => this.#clock.now());
    this.#audit = deps.audit ?? noAudit;
    this.#store = deps.store && !deps.config.dryRun ? guardStore(deps.store, this.#audit, this.#now) : noStore;
    this.#health = new ConnectionHealth(this.#audit, this.#now);
    this.#sequencer = new Sequencer({
      bhyve: deps.bhyve,
      history: deps.history,
      audit: this.#audit,
      health: this.#health,
      store: this.#store,
      options: deps.config.recovery,
      now: this.#now,
      clock: this.#clock,
    });
    this.#alerts = new AlertTracker(this.#audit, deps.config.alerts, this.#now, deps.alertState);
    this.#restoreSpells(deps.zoneSpells ?? []);
  }

  /**
   * Carries on a dry spell (it counts against maxWaitHours) and a sensor blackout (so it isn't reported
   * again) across a quick restart. After a longer gap the saved spells say nothing about now: discarded.
   */
  #restoreSpells(spells: readonly SavedZoneSpell[]): void {
    const now = this.#now().getTime();
    const freshMs = SPELL_FRESH_POLLS * this.#deps.config.pollIntervalMinutes * MINUTE_MS;
    const zones = new Set(this.#deps.config.zones.map((z) => z.key));
    for (const s of spells) {
      if (!zones.has(s.zoneKey) || now - s.evaluatedAt.getTime() > freshMs) continue;
      if (s.drySince) this.#drySince.set(s.zoneKey, s.drySince);
      if (s.noDataSince) this.#noDataSince.set(s.zoneKey, s.noDataSince);
    }
  }

  get health(): ConnectionHealth {
    return this.#health;
  }

  /** Resumes sequences saved by a previous run (once; start() calls it too). */
  async resumePending(): Promise<void> {
    if (this.#resumed) return;
    this.#resumed = true;
    const pending = this.#deps.pendingSequences ?? [];
    if (pending.length > 0 && !this.#deps.config.dryRun) await this.#sequencer.resume(pending);
  }

  /** Runs one poll → decide → water cycle. Throws if the sensors or B-hyve can't be read. */
  async runCycle(): Promise<CycleResult> {
    const { config, bhyve, history } = this.#deps;
    const now = this.#now();

    const readings = await this.#readSensors();
    this.#store.recordReadings([...readings.values()], now);
    let alertsChanged = this.#alerts.checkReadings(config.zones, readings);
    let devices = await this.#periodicDeviceCheck(now);

    let decisions = config.zones.map((zone) => evaluateZone(zone, readings, history, now));
    this.#trackDrySpells(decisions, now);
    this.#trackSensorData(decisions, now);
    this.#store.saveZoneSpells(
      config.zones.map((z) => {
        const drySince = this.#drySince.get(z.key);
        const noDataSince = this.#noDataSince.get(z.key);
        return { zoneKey: z.key, ...(drySince ? { drySince } : {}), ...(noDataSince ? { noDataSince } : {}) };
      }),
      now,
    );
    alertsChanged = this.#alerts.checkDecisions(decisions) || alertsChanged;
    let commands: DeviceCommand[] = [];

    // A device mid-sequence (soaking, or retrying after a connection problem) may look idle; leave it alone.
    decisions = decisions.map((d) =>
      d.action === 'water' && this.#sequencer.isActive(d.zone.deviceId)
        ? {
            ...d,
            action: 'skip',
            reason: 'soaking',
            detail: `${d.detail}, but a watering sequence is still in progress (${this.#sequencer.progress(d.zone.deviceId)})`,
          }
        : d,
    );

    // Only talk to B-hyve and the weather service when something actually needs water.
    if (decisions.some((d) => d.action === 'water')) {
      if (!devices) {
        try {
          devices = await bhyve.getDevices();
          this.#health.ok('bhyve');
          this.#lastDeviceCheck = now;
        } catch (err) {
          this.#health.failed('bhyve', err);
          if (alertsChanged) this.#saveAlerts();
          throw err;
        }
        alertsChanged = this.#alerts.checkDevices(devices) || alertsChanged;
      }
      decisions = await this.#withForecast(decisions, devices, now);
      ({ decisions, commands } = applyDeviceState(decisions, devices));
    }
    decisions.forEach(logDecision);
    this.#auditDecisionChanges(decisions);
    if (alertsChanged) this.#saveAlerts();
    this.#pruneHistory(now);

    const sent: DeviceCommand[] = [];
    const failed: CycleResult['failed'] = [];
    for (const command of commands) {
      if (config.dryRun) {
        const single = command.waves.length === 1;
        const cycles = single
          ? waveSummary(command.waves[0] ?? [])
          : command.waves.map((w, i) => `cycle ${i + 1}: ${waveSummary(w)}`).join('; ');
        const soak = single ? '' : ` (${command.soakMinutes} min soak between cycles)`;
        log.info(`[dry run] would water device ${command.deviceId}${soak}: ${cycles}`);
        sent.push(command);
        continue;
      }
      const zones = decisions
        .filter((d) => d.action === 'water' && d.zone.deviceId === command.deviceId)
        .map((d) => ({ zone: d.zone.key, name: d.zone.name, moisturePct: d.reading?.moisturePct, minutes: d.runMinutes, why: d.detail }));
      const why = decisions.filter((d) => d.action === 'water' && d.zone.deviceId === command.deviceId);
      const result = await this.#sequencer.start(command, { zones }, why);
      if (result === 'delivered') sent.push(command);
      else failed.push({ command, error: new Error(`watering on device ${command.deviceId} did not start (${result})`) });
    }

    return { at: now, decisions, sent, failed };
  }

  async #readSensors(): Promise<Map<string, MoistureReading>> {
    const { source, config } = this.#deps;
    let list: MoistureReading[];
    try {
      list = await source.read();
    } catch (err) {
      this.#health.failed('tuya', err);
      throw err;
    }
    const sensorCount = new Set(config.zones.flatMap((z) => z.sensorIds)).size;
    if (sensorCount > 0 && list.length === 0) {
      const first = source.lastErrors?.[0];
      this.#health.failed('tuya', new Error(first ? `no sensor could be read (${first.sensorId}: ${first.error})` : 'no sensor returned a reading'));
    } else {
      this.#health.ok('tuya');
    }
    return new Map(list.map((r) => [r.sensorId, r]));
  }

  /**
   * Checks the controllers (connectivity, battery) every `deviceCheckMinutes`, even when nothing needs
   * water. A failure here is only recorded (connection health); it never fails the poll.
   */
  async #periodicDeviceCheck(now: Date): Promise<BhyveDevice[] | undefined> {
    const every = this.#deps.config.alerts.deviceCheckMinutes;
    if (every <= 0) return undefined;
    if (this.#lastDeviceCheck && now.getTime() - this.#lastDeviceCheck.getTime() < every * MINUTE_MS) return undefined;
    this.#lastDeviceCheck = now;
    try {
      const devices = await this.#deps.bhyve.getDevices();
      this.#health.ok('bhyve');
      if (this.#alerts.checkDevices(devices)) this.#saveAlerts();
      return devices;
    } catch (err) {
      this.#health.failed('bhyve', err);
      return undefined;
    }
  }

  /** Resolves when no watering sequence is running (--once uses it to let the last cycles finish). */
  drain(): Promise<void> {
    return this.#sequencer.drain();
  }

  /** Records each zone's decision when it changes, so "why did/didn't it water?" can be answered later. */
  #auditDecisionChanges(decisions: readonly ZoneDecision[]): void {
    for (const d of decisions) {
      if (this.#lastReason.get(d.zone.key) === d.reason) continue;
      this.#lastReason.set(d.zone.key, d.reason);
      this.#audit.record('zone.decision', {
        zone: d.zone.key,
        name: d.zone.name,
        reason: d.reason,
        action: d.action,
        ...(d.reading ? { moisturePct: Math.round(d.reading.moisturePct * 10) / 10 } : {}),
        ...(d.runMinutes !== undefined && d.action === 'water' ? { minutes: d.runMinutes } : {}),
        detail: d.detail,
      });
    }
  }

  #trackDrySpells(decisions: readonly ZoneDecision[], now: Date): void {
    for (const d of decisions) {
      if (BELOW_THRESHOLD.has(d.reason)) {
        if (!this.#drySince.has(d.zone.key)) this.#drySince.set(d.zone.key, now);
      } else if (d.reason === 'moist') {
        this.#drySince.delete(d.zone.key);
      }
      // 'no-data' leaves the spell as it was: we just don't know.
    }
  }

  /** Audits the start and end of each zone's sensor blackout (no usable readings → no watering). */
  #trackSensorData(decisions: readonly ZoneDecision[], now: Date): void {
    for (const d of decisions) {
      const since = this.#noDataSince.get(d.zone.key);
      if (d.reason === 'no-data') {
        if (!since) {
          this.#noDataSince.set(d.zone.key, now);
          this.#audit.record('zone.no_data', { zone: d.zone.key, name: d.zone.name, detail: d.detail });
        }
      } else if (since) {
        this.#noDataSince.delete(d.zone.key);
        this.#audit.record('zone.data_restored', {
          zone: d.zone.key,
          name: d.zone.name,
          outageMinutes: Math.round(((now.getTime() - since.getTime()) / MINUTE_MS) * 10) / 10,
        });
      }
    }
  }

  /** Applies forecast-based amounts; on any failure, keeps the fixed run lengths and says so. */
  async #withForecast(decisions: ZoneDecision[], devices: BhyveDevice[], now: Date): Promise<ZoneDecision[]> {
    const { weather, bhyve, config } = this.#deps;
    if (!weather) return decisions;

    let forecast: { hours: ForecastHour[]; timeZone: string };
    let schedule: ScheduledRun[];
    try {
      forecast = await weather.getForecast(now, config.forecastHours);
      this.#health.ok('weather');
    } catch (err) {
      this.#health.failed('weather', err);
      log.warn('Weather forecast unavailable; using fixed run lengths this cycle', err);
      return decisions;
    }
    try {
      const programs = await bhyve.getPrograms();
      this.#health.ok('bhyve');
      const until = new Date(now.getTime() + config.forecastHours * HOUR_MS);
      const result = upcomingRuns(programs, devices, now, until, forecast.timeZone);
      result.warnings.forEach((w) => log.warn(w));
      schedule = result.runs;
    } catch (err) {
      this.#health.failed('bhyve', err);
      log.warn('B-hyve schedule unavailable; using fixed run lengths this cycle', err);
      return decisions;
    }
    return applyForecast(decisions, {
      now,
      forecast: forecast.hours,
      schedule,
      waitedHours: (key) => {
        const since = this.#drySince.get(key);
        return since ? (now.getTime() - since.getTime()) / HOUR_MS : 0;
      },
    });
  }

  /** The open alert conditions (a dry run saves nothing: it would hide alerts from the real service). */
  #saveAlerts(): void {
    this.#store.saveAlerts(this.#alerts.state);
  }

  /** In memory, only what cooldowns and the 24 h cap can still need (the database keeps everything). */
  #pruneHistory(now: Date): void {
    const longestCooldown = Math.max(0, ...this.#deps.config.zones.map((z) => z.cooldownMinutes));
    this.#deps.history.prune(now, longestCooldown * MINUTE_MS);
  }

  /** Polls now and then every `pollIntervalMinutes` (measured from the end of each cycle, so cycles never overlap). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    log.info(
      `Monitoring ${this.#deps.config.zones.length} zone(s) every ${this.#deps.config.pollIntervalMinutes} min` +
        (this.#deps.config.dryRun ? ' (dry run: no commands will be sent)' : ''),
    );
    this.#inFlight = this.resumePending()
      .catch((err: unknown) => log.error('Could not resume saved watering sequences', err))
      .finally(() => this.#tick());
  }

  #tick(): void {
    if (!this.#running) return;
    let watchdog: TimerHandle | undefined;
    const deadline = new Promise<never>((_, reject) => {
      watchdog = this.#clock.setTimeout(
        () => reject(new Error(`poll did not finish within ${POLL_DEADLINE_MS / MINUTE_MS} min (something is hanging); moving on`)),
        POLL_DEADLINE_MS,
      );
    });
    this.#inFlight = Promise.race([this.runCycle(), deadline])
      .catch((err: unknown) => {
        log.error('Monitoring cycle failed; will retry next poll', err);
        this.#audit.record('poll.failed', { error: errorMessage(err) });
      })
      .finally(() => {
        this.#clock.clearTimeout(watchdog);
        this.#inFlight = undefined;
        try {
          this.#deps.heartbeat?.();
        } catch (err) {
          log.error('Could not record the heartbeat', err);
        }
        if (this.#running) {
          this.#timer = this.#clock.setTimeout(() => this.#tick(), this.#deps.config.pollIntervalMinutes * MINUTE_MS);
        }
      });
  }

  /** Stops polling and waits for an in-progress poll. Unfinished sequences stay saved and resume on restart. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#sequencer.stop();
    await this.#inFlight;
  }
}

const waveSummary = (wave: readonly { station: number; runTime: number }[]): string =>
  wave.map((r) => `station ${r.station} for ${r.runTime} min`).join(', ');

const logDecision = (d: ZoneDecision): void => {
  const line = `${d.zone.name} [${d.zone.key}]: ${d.reason}: ${d.detail}`;
  if (d.action === 'skip' && !EXPECTED_SKIPS.has(d.reason)) log.warn(line);
  else log.info(line);
};
