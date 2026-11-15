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
import type { ConductorConfig, ZoneConfig } from './config.ts';
import type { WateringHistory } from './history.ts';
import { applyDeviceState, applyForecast, evaluateZone, readingProblem, type DeviceCommand, type ZoneDecision } from './plan.ts';
import { Sequencer, type HeldSequence, type RunningWave } from './sequencer.ts';
import type { ConductorState, PauseInfo, PendingSequence } from './state.ts';
import type { ServiceName } from '../audit/health.ts';

/** The parts of BhyveClient the monitor needs (lets tests pass a fake). */
export type BhyveControl = Pick<BhyveClient, 'getDevices' | 'getDevice' | 'getPrograms' | 'startWatering' | 'stopWatering' | 'onEvent'>;

export interface StateStore {
  save(state: ConductorState): Promise<void>;
}

export interface MonitorDeps {
  config: ConductorConfig;
  source: MoistureSource;
  bhyve: BhyveControl;
  history: WateringHistory;
  /** Sequences saved by a previous run, resumed by start() / resumePending(). */
  pendingSequences?: PendingSequence[];
  /** Alert conditions saved by a previous run (so they aren't reported again). */
  alertState?: AlertState;
  /** Set if the conductor was paused when it last stopped: it stays paused. */
  paused?: PauseInfo;
  /** Where to persist history and pending sequences. Omit to keep them in memory only. */
  store?: StateStore;
  /** Enables forecast-based amounts. Without it, dry zones get their fixed `runMinutes`. */
  weather?: WeatherProvider;
  /** Audit trail for connectivity and watering events. */
  audit?: AuditSink;
  /** Time and timers (default: the system's). `now` overrides just the time. */
  clock?: Clock;
  now?: () => Date;
  /** How long after stopping the water to ask B-hyve whether it is really off (its status can lag). */
  stopCheckDelayMs?: number;
}

export interface CycleResult {
  at: Date;
  decisions: ZoneDecision[];
  /** Commands whose first wave was delivered (or, in dry-run mode, would have been). */
  sent: DeviceCommand[];
  /** Commands whose first wave couldn't be delivered now (they may still be retrying). */
  failed: { command: DeviceCommand; error: unknown }[];
}

/** A read-only snapshot of what the conductor is doing, for status reports (e.g. the Telegram /status command). */
export interface ConductorStatus {
  /** When the snapshot was taken. */
  at: Date;
  /** Polling (start() called and not stopped). */
  running: boolean;
  dryRun: boolean;
  pollIntervalMinutes: number;
  /** When start() was called. */
  startedAt?: Date;
  /** A poll is in progress right now. */
  polling: boolean;
  lastPoll?: { startedAt: Date; finishedAt: Date; ok: boolean; error?: string };
  nextPollAt?: Date;
  /** Every configured zone, with the decision from the last poll that got that far (if any). */
  zones: {
    key: string;
    name: string;
    decision?: { at: Date; action: ZoneDecision['action']; reason: string; detail: string; moisturePct?: number; runMinutes?: number };
  }[];
  /** Set while paused: no supplemental watering (sensors are still read and alerts still sent). */
  paused?: PauseInfo;
  /** Watering sequences in progress (including ones waiting out a soak or a retry, or held by a pause). */
  sequences: SequenceStatus[];
  /** Cycles the conductor started whose run time hasn't elapsed: water is on. A pause doesn't turn it off. */
  wateringNow: RunningWave[];
  /** Remote services currently unreachable. */
  outages: { service: ServiceName; since: Date; failures: number; lastError: string }[];
  /** Open alert conditions (low battery, critical moisture, controller offline...). */
  alerts: { key: string; state: string; since: Date }[];
  /** Polls since start(): finished, failed, and given up on by the watchdog (hung). */
  polls: { ok: number; failed: number; hung: number };
}

/** Everything about one zone (for /zone): settings, sensors, watering, limits, alerts. No network calls. */
export interface ZoneDetail {
  at: Date;
  zone: Pick<
    ZoneConfig,
    | 'key'
    | 'name'
    | 'deviceId'
    | 'station'
    | 'thresholdPct'
    | 'targetPct'
    | 'runMinutes'
    | 'maxMinutesPerDay'
    | 'cooldownMinutes'
    | 'maxCycleMinutes'
    | 'soakMinutes'
    | 'sensorAggregation'
    | 'maxReadingAgeMinutes'
    | 'criticalLowPct'
    | 'criticalHighPct'
  >;
  decision?: ConductorStatus['zones'][number]['decision'];
  /** Each of the zone's sensors, as last read: `problem` says why a reading isn't used (offline, stale...). */
  sensors: { id: string; name?: string; moisturePct?: number; temperatureC?: number; batteryPct?: number; at?: Date; problem?: string }[];
  /** Supplemental watering in the last 24 hours, against the daily cap. */
  usedLastDayMinutes: number;
  lastRun?: { at: Date; minutes: number };
  /** Set while the cooldown after the last run is on. */
  cooldownUntil?: Date;
  /** The conductor's watering on this zone's controller: in progress or held, and water on now. */
  sequence?: SequenceStatus;
  wateringNow?: RunningWave;
  /** Open alerts about this zone, its sensors or its controller. */
  alerts: { key: string; state: string; since: Date }[];
  paused?: PauseInfo;
}

/** What /stop did on one controller. */
export interface StopResult {
  deviceId: string;
  zoneNames: string[];
  /** The stop command was sent (B-hyve's command connection took it). */
  sent: boolean;
  error?: string;
  /** The conductor's watering on it that was cancelled (in progress or held). */
  cancelled?: SequenceStatus;
  /** A cycle was being sent as it stopped: the stop was sent again once that was over. */
  resent?: boolean;
  /** What B-hyve said a moment later. */
  check: 'off' | 'watering' | 'unknown';
}

export interface SequenceStatus {
  id: string;
  deviceId: string;
  zoneNames: string[];
  nextCycle: number;
  cycles: number;
  dueAt: Date;
  attempts: number;
  /** Its next cycle is so overdue that continuing it (after a pause) would abandon it instead. */
  stale: boolean;
}

export interface PauseResult {
  /** False if it was already paused. */
  changed: boolean;
  /** It was already paused, and its end time was changed. */
  updated?: boolean;
  paused: PauseInfo;
  /** Sequences now on hold. */
  held: SequenceStatus[];
  /** Water still on from cycles already started (a pause doesn't stop them). */
  wateringNow: RunningWave[];
  /** A cycle was being sent at the moment of the pause; it may still start. */
  sendInProgress: boolean;
}

export interface ResumeResult {
  /** False if it wasn't paused. */
  changed: boolean;
  pausedMinutes: number;
  continued: SequenceStatus[];
  /** Held sequences cancelled (by request, or because they were too old to continue), with why. */
  discarded: { sequence: SequenceStatus; reason: string }[];
}

/** What to do with held sequences on resume. */
export type HeldSequenceAction = 'continue' | 'discard';

/** While paused with no end, remind this often (and not before it has lasted this long). */
export const PAUSE_REMINDER_MS = 24 * 3_600_000;
/** After a stop during a send, wait at most this long for that send to be over before stopping again. */
const STOP_RESEND_WAIT_MS = 60_000;

/** The watchdog gave up on a poll. */
class PollDeadlineError extends Error {}

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
const EXPECTED_SKIPS = new Set(['cooldown', 'daily-limit', 'rain-delay', 'already-watering', 'soaking', 'paused']);

const noAudit: AuditSink = { record: () => {} };

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
  #saveQueue: Promise<void> = Promise.resolve();
  /** When each zone was first seen below its threshold in the current dry spell. */
  readonly #drySince = new Map<string, Date>();
  /** Zones currently without any usable sensor reading, and since when. */
  readonly #noDataSince = new Map<string, Date>();
  /** Last decision reason per zone, to audit changes only. */
  readonly #lastReason = new Map<string, string>();
  /** For status(): the last decision per zone and the poll timeline. */
  readonly #lastDecision = new Map<string, { at: Date; decision: ZoneDecision }>();
  #startedAt: Date | undefined;
  #pollStartedAt: Date | undefined;
  #lastPoll: ConductorStatus['lastPoll'];
  #nextPollAt: Date | undefined;
  #paused: PauseInfo | undefined;
  /** Ends a pause that has an end time. */
  #pauseTimer: TimerHandle | undefined;
  #lastPauseReminder: Date | undefined;
  /** The last reading of each sensor, and why the others couldn't be read, from the last poll that read them. */
  #lastReadings = new Map<string, MoistureReading>();
  #lastSensorErrors = new Map<string, string>();
  readonly #polls = { ok: 0, failed: 0, hung: 0 };

  constructor(deps: MonitorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#now = deps.now ?? (() => this.#clock.now());
    this.#audit = deps.audit ?? noAudit;
    this.#health = new ConnectionHealth(this.#audit, this.#now);
    this.#sequencer = new Sequencer({
      bhyve: deps.bhyve,
      history: deps.history,
      audit: this.#audit,
      health: this.#health,
      save: () => this.#persist(),
      options: deps.config.recovery,
      now: this.#now,
      clock: this.#clock,
    });
    this.#alerts = new AlertTracker(this.#audit, deps.config.alerts, this.#now, deps.alertState);
    if (deps.paused) {
      this.#paused = {
        since: new Date(deps.paused.since),
        by: deps.paused.by,
        ...(deps.paused.until ? { until: new Date(deps.paused.until) } : {}),
      };
      this.#sequencer.pause();
      // A restart already says it's still paused; the next reminder comes a day later.
      this.#lastPauseReminder = this.#now();
    }
  }

  /** Set while paused. */
  get paused(): PauseInfo | undefined {
    return this.#paused ? copyPause(this.#paused) : undefined;
  }

  get health(): ConnectionHealth {
    return this.#health;
  }

  /** Resumes sequences saved by a previous run (once; start() calls it too). */
  async resumePending(): Promise<void> {
    if (this.#resumed) return;
    this.#resumed = true;
    const pending = this.#deps.pendingSequences ?? [];
    if (pending.length === 0 || this.#deps.config.dryRun) return;
    // Paused: keep them on hold, to be continued or discarded on resume.
    if (this.#paused) this.#sequencer.hold(pending);
    else await this.#sequencer.resume(pending);
  }

  /** Runs one poll → decide → water cycle. Throws if the sensors or B-hyve can't be read. */
  async runCycle(): Promise<CycleResult> {
    const { config, bhyve, history } = this.#deps;
    const now = this.#now();

    const readings = await this.#readSensors();
    let alertsChanged = this.#alerts.checkReadings(config.zones, readings);
    let devices = await this.#periodicDeviceCheck(now);

    let decisions = config.zones.map((zone) => evaluateZone(zone, readings, history, now));
    this.#trackDrySpells(decisions, now);
    this.#trackSensorData(decisions, now);
    alertsChanged = this.#alerts.checkDecisions(decisions) || alertsChanged;
    let commands: DeviceCommand[] = [];

    // Paused: keep reading the sensors (alerts matter most now), but start nothing.
    const paused = this.#paused;
    if (paused) {
      decisions = decisions.map((d) =>
        d.action === 'water' ? { ...d, action: 'skip', reason: 'paused', detail: `${d.detail}, but the conductor is paused (by ${paused.by})` } : d,
      );
    }
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
          if (alertsChanged) await this.#persist();
          throw err;
        }
        alertsChanged = this.#alerts.checkDevices(devices) || alertsChanged;
      }
      decisions = await this.#withForecast(decisions, devices, now);
      ({ decisions, commands } = applyDeviceState(decisions, devices));
    }
    decisions.forEach(logDecision);
    for (const d of decisions) this.#lastDecision.set(d.zone.key, { at: now, decision: d });
    this.#auditDecisionChanges(decisions);
    if (alertsChanged) await this.#persist();

    const sent: DeviceCommand[] = [];
    const failed: CycleResult['failed'] = [];
    for (const command of commands) {
      // Paused while this poll was under way (e.g. waiting for B-hyve): don't start anything.
      if (this.#paused) {
        log.info(`Not watering device ${command.deviceId}: the conductor was paused during this poll`);
        failed.push({ command, error: new Error(`watering on device ${command.deviceId} not started: the conductor is paused`) });
        continue;
      }
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
      const result = await this.#sequencer.start(command, { zones });
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
    this.#lastReadings = new Map(list.map((r) => [r.sensorId, r]));
    this.#lastSensorErrors = new Map((source.lastErrors ?? []).map((e) => [e.sensorId, e.error]));
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
      if (this.#alerts.checkDevices(devices)) await this.#persist();
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

  /** Saves history + pending sequences. Saves are queued so concurrent sequences can't interleave writes. */
  #persist(): Promise<void> {
    const { config, history, store } = this.#deps;
    // A dry run must leave no trace in the state file (it would hide alerts from the real service).
    if (config.dryRun) return this.#saveQueue;
    this.#saveQueue = this.#saveQueue.then(async () => {
      const now = this.#now();
      const longestCooldown = Math.max(0, ...config.zones.map((z) => z.cooldownMinutes));
      history.prune(now, longestCooldown * MINUTE_MS);
      try {
        await store?.save({
          history,
          sequences: this.#sequencer.pending(),
          alerts: this.#alerts.state,
          ...(this.#paused ? { paused: this.#paused } : {}),
        });
      } catch (err) {
        // Watering carries on, but a restart now could water a zone again too soon or lose a sequence.
        log.error('Could not save state; cooldowns and pending cycles will not survive a restart', err);
        this.#audit.record('state.save_failed', { error: errorMessage(err) });
      }
    });
    return this.#saveQueue;
  }

  /** A snapshot of the conductor's state. Never touches the network, so it's cheap and can't fail. */
  status(): ConductorStatus {
    const { config } = this.#deps;
    const at = this.#now();
    const running = this.#running;
    return {
      at,
      running,
      dryRun: config.dryRun,
      pollIntervalMinutes: config.pollIntervalMinutes,
      ...(this.#startedAt ? { startedAt: this.#startedAt } : {}),
      polling: this.#pollStartedAt !== undefined,
      ...(this.#lastPoll ? { lastPoll: { ...this.#lastPoll } } : {}),
      ...(running && this.#nextPollAt ? { nextPollAt: this.#nextPollAt } : {}),
      zones: config.zones.map((zone) => {
        const last = this.#lastDecision.get(zone.key);
        if (!last) return { key: zone.key, name: zone.name };
        const d = last.decision;
        return {
          key: zone.key,
          name: zone.name,
          decision: {
            at: last.at,
            action: d.action,
            reason: d.reason,
            detail: d.detail,
            ...(d.reading ? { moisturePct: Math.round(d.reading.moisturePct * 10) / 10 } : {}),
            ...(d.action === 'water' && d.runMinutes !== undefined ? { runMinutes: d.runMinutes } : {}),
          },
        };
      }),
      ...(this.#paused ? { paused: copyPause(this.#paused) } : {}),
      sequences: this.#sequencer.held().map(sequenceStatus),
      wateringNow: this.#sequencer.wateringNow(),
      outages: this.#health.outages(),
      alerts: this.#openAlerts(),
      polls: { ...this.#polls },
    };
  }

  #openAlerts(): { key: string; state: string; since: Date }[] {
    return Object.entries(this.#alerts.state).map(([key, v]) => ({ key, state: v.state, since: new Date(v.since) }));
  }

  /** Everything about one zone, or undefined if there's no such zone. No network calls. */
  zoneStatus(key: string): ZoneDetail | undefined {
    const zone = this.#deps.config.zones.find((z) => z.key === key);
    if (!zone) return undefined;
    const at = this.#now();
    const history = this.#deps.history;
    const last = history.lastRun(zone.key);
    const cooldownUntil = last ? new Date(last.at.getTime() + zone.cooldownMinutes * MINUTE_MS) : undefined;
    const decision = this.status().zones.find((z) => z.key === key)?.decision;
    const sequence = this.#sequencer.held().find((h) => h.seq.deviceId === zone.deviceId);
    const wateringNow = this.#sequencer.wateringNow().find((w) => w.deviceId === zone.deviceId);
    const sensorKeys = new Set(zone.sensorIds.map((id) => `battery:sensor:${id}`));
    const alerts = this.#openAlerts().filter(
      (a) =>
        a.key.startsWith(`moisture:${zone.key}:`) ||
        a.key === `daily-limit:${zone.key}` ||
        a.key === `device:${zone.deviceId}` ||
        a.key === `battery:device:${zone.deviceId}` ||
        sensorKeys.has(a.key),
    );
    return {
      at,
      zone: {
        key: zone.key,
        name: zone.name,
        deviceId: zone.deviceId,
        station: zone.station,
        thresholdPct: zone.thresholdPct,
        targetPct: zone.targetPct,
        runMinutes: zone.runMinutes,
        maxMinutesPerDay: zone.maxMinutesPerDay,
        cooldownMinutes: zone.cooldownMinutes,
        maxCycleMinutes: zone.maxCycleMinutes,
        soakMinutes: zone.soakMinutes,
        sensorAggregation: zone.sensorAggregation,
        maxReadingAgeMinutes: zone.maxReadingAgeMinutes,
        criticalLowPct: zone.criticalLowPct,
        criticalHighPct: zone.criticalHighPct,
      },
      ...(decision ? { decision } : {}),
      sensors: zone.sensorIds.map((id) => {
        const r = this.#lastReadings.get(id);
        if (!r) return { id, problem: this.#lastSensorErrors.get(id) ?? 'no reading yet' };
        const problem = readingProblem(r, at, zone.maxReadingAgeMinutes);
        return {
          id,
          name: r.sensorName,
          moisturePct: r.moisturePct,
          ...(r.temperatureC !== undefined ? { temperatureC: r.temperatureC } : {}),
          ...(r.batteryPct !== undefined ? { batteryPct: r.batteryPct } : {}),
          at: new Date(r.at),
          ...(problem ? { problem } : {}),
        };
      }),
      usedLastDayMinutes: Math.round(history.minutesInLastDay(zone.key, at) * 10) / 10,
      ...(last ? { lastRun: { at: new Date(last.at), minutes: last.minutes } } : {}),
      ...(cooldownUntil && cooldownUntil.getTime() > at.getTime() ? { cooldownUntil } : {}),
      ...(sequence ? { sequence: sequenceStatus(sequence) } : {}),
      ...(wateringNow ? { wateringNow } : {}),
      alerts,
      ...(this.#paused ? { paused: copyPause(this.#paused) } : {}),
    };
  }

  /**
   * Turns the water off on these controllers now, and cancels the conductor's watering on them (in
   * progress or held). It returns them to their normal B-hyve schedule: nothing is switched off, and
   * automatic watering carries on (pause it to stop it from starting again). A cycle being sent at that
   * very moment can't be recalled, so the stop is sent again once that send is over. A moment later,
   * B-hyve is asked whether the water is really off.
   */
  async stopWatering(deviceIds: readonly string[], by: string): Promise<StopResult[]> {
    const reason = `stopped by ${by}`;
    const results: StopResult[] = [];
    for (const deviceId of [...new Set(deviceIds)]) {
      const before = this.#sequencer.held().find((h) => h.seq.deviceId === deviceId);
      const { sending } = this.#sequencer.cancel(deviceId, reason);
      const result: StopResult = {
        deviceId,
        zoneNames: this.#deps.config.zones.filter((z) => z.deviceId === deviceId).map((z) => z.name),
        sent: false,
        ...(before ? { cancelled: sequenceStatus(before) } : {}),
        check: 'unknown',
      };
      await this.#sendStop(result);
      if (sending) {
        // The cycle might start after our stop: once its send is over, cancel and stop again.
        let timer: TimerHandle | undefined;
        await Promise.race([sending, new Promise<void>((resolve) => (timer = this.#clock.setTimeout(resolve, STOP_RESEND_WAIT_MS)))]);
        this.#clock.clearTimeout(timer);
        this.#sequencer.cancel(deviceId, reason);
        result.resent = true;
        await this.#sendStop(result);
      }
      results.push(result);
    }
    await this.#persist();
    await new Promise<void>((resolve) => this.#clock.setTimeout(resolve, this.#deps.stopCheckDelayMs ?? 5_000));
    for (const result of results) {
      try {
        const device = await this.#deps.bhyve.getDevice(result.deviceId);
        this.#health.ok('bhyve');
        result.check = device.status?.watering_status ? 'watering' : 'off';
      } catch (err) {
        this.#health.failed('bhyve', err);
      }
    }
    log.warn(`Watering stopped by ${by} on ${results.map((r) => `${r.deviceId} (${r.sent ? r.check : `not sent: ${r.error ?? '?'}`})`).join(', ')}`);
    this.#audit.record('watering.stopped', {
      by,
      devices: results.map((r) => ({
        device: r.deviceId,
        zoneNames: r.zoneNames,
        sent: r.sent,
        check: r.check,
        ...(r.error ? { error: r.error } : {}),
        ...(r.cancelled ? { cancelled: r.cancelled.id } : {}),
        ...(r.resent ? { resent: true } : {}),
      })),
    });
    return results;
  }

  async #sendStop(result: StopResult): Promise<void> {
    try {
      await this.#deps.bhyve.stopWatering(result.deviceId);
      this.#health.ok('bhyve-commands');
      result.sent = true;
      delete result.error;
    } catch (err) {
      this.#health.failed('bhyve-commands', err);
      result.error = errorMessage(err);
    }
  }

  /**
   * Stops supplemental watering until resume(): nothing new starts, and held sequences send no further
   * cycles. Sensors are still polled and alerts still sent. Water already running is not turned off.
   * The pause is saved, so it survives a restart.
   */
  async pause(by: string, opts: { until?: Date } = {}): Promise<PauseResult> {
    const until = opts.until;
    if (this.#paused) {
      const unchanged = { changed: false, held: this.#sequencer.held().map(sequenceStatus), wateringNow: this.#sequencer.wateringNow(), sendInProgress: false };
      if (!until) return { ...unchanged, paused: copyPause(this.#paused) };
      // Already paused: give it a (new) end.
      const previous = this.#paused.until;
      this.#paused = { ...this.#paused, until: new Date(until) };
      this.#armPauseEnd();
      log.info(`Pause now ends at ${until.toISOString()} (changed by ${by})`);
      this.#audit.record('conductor.pause_changed', { by, until: until.toISOString(), ...(previous ? { previousUntil: previous.toISOString() } : {}) });
      await this.#persist();
      return { ...unchanged, updated: true, paused: copyPause(this.#paused) };
    }
    this.#paused = { since: this.#now(), by, ...(until ? { until: new Date(until) } : {}) };
    this.#lastPauseReminder = this.#now();
    this.#armPauseEnd();
    const sendInProgress = this.#sequencer.pause();
    const held = this.#sequencer.held().map(sequenceStatus);
    const wateringNow = this.#sequencer.wateringNow();
    log.warn(`Conductor paused by ${by}: no supplemental watering until ${until ? until.toISOString() : 'resumed'}`);
    this.#audit.record('conductor.paused', {
      by,
      ...(until ? { until: until.toISOString() } : {}),
      held: held.map((h) => ({ sequence: h.id, device: h.deviceId, zoneNames: h.zoneNames, nextCycle: h.nextCycle, of: h.cycles })),
      ...(wateringNow.length > 0 ? { wateringNow: wateringNow.map((w) => ({ device: w.deviceId, zoneNames: w.zoneNames, until: w.until.toISOString() })) } : {}),
      ...(sendInProgress ? { sendInProgress } : {}),
    });
    await this.#persist();
    return { changed: true, paused: copyPause(this.#paused), held, wateringNow, sendInProgress };
  }

  /** Arms (or disarms) the timer that ends a pause with an end time. */
  #armPauseEnd(): void {
    this.#clock.clearTimeout(this.#pauseTimer);
    this.#pauseTimer = undefined;
    const until = this.#paused?.until;
    if (!until) return;
    this.#pauseTimer = this.#clock.setTimeout(
      () => {
        this.#pauseTimer = undefined;
        const paused = this.#paused;
        if (!paused?.until || this.#now().getTime() < paused.until.getTime()) return;
        // Nobody is asked: held watering is an old plan, so it's discarded; the zones are re-checked anyway.
        this.resume('the end of the pause', 'discard', { auto: true }).catch((err: unknown) => log.error('Could not end the pause', err));
      },
      Math.max(0, until.getTime() - this.#now().getTime()),
    );
  }

  /** While paused with no end, a reminder once a day (a forgotten pause means no supplemental watering). */
  #remindIfStillPaused(now: Date): void {
    const paused = this.#paused;
    if (!paused || paused.until) return;
    const last = this.#lastPauseReminder ?? paused.since;
    if (now.getTime() - last.getTime() < PAUSE_REMINDER_MS || now.getTime() - paused.since.getTime() < PAUSE_REMINDER_MS) return;
    this.#lastPauseReminder = now;
    this.#audit.record('conductor.pause_reminder', {
      since: paused.since.toISOString(),
      by: paused.by,
      pausedHours: Math.round((now.getTime() - paused.since.getTime()) / 3_600_000),
    });
  }

  /**
   * Ends a pause. Held sequences are continued (each only if it's not too old, as after a restart) or
   * discarded; either way the zones are re-checked straight away.
   */
  async resume(by: string, held: HeldSequenceAction, opts: { auto?: boolean } = {}): Promise<ResumeResult> {
    const paused = this.#paused;
    if (!paused) return { changed: false, pausedMinutes: 0, continued: [], discarded: [] };
    this.#clock.clearTimeout(this.#pauseTimer);
    this.#pauseTimer = undefined;
    const before = new Map(this.#sequencer.held().map((h) => [h.seq.id, sequenceStatus(h)]));
    const status = (seq: PendingSequence): SequenceStatus => before.get(seq.id) ?? sequenceStatus({ seq, dueAt: seq.dueAt, stale: false });
    let continued: SequenceStatus[] = [];
    let discarded: ResumeResult['discarded'] = [];
    if (held === 'continue') {
      const result = await this.#sequencer.continueHeld();
      continued = result.continued.map(status);
      discarded = result.abandoned.map((a) => ({ sequence: status(a.seq), reason: a.reason }));
    } else {
      const reason = `discarded by ${by} when resuming`;
      discarded = (await this.#sequencer.discardHeld(reason)).map((seq) => ({ sequence: status(seq), reason }));
    }
    this.#paused = undefined;
    const pausedMinutes = Math.round(((this.#now().getTime() - paused.since.getTime()) / MINUTE_MS) * 10) / 10;
    log.info(`Conductor resumed by ${by} after ${pausedMinutes} min`);
    this.#audit.record('conductor.resumed', {
      by,
      ...(opts.auto ? { auto: true } : {}),
      pausedBy: paused.by,
      pausedMinutes,
      held,
      continued: continued.map((c) => c.id),
      discarded: discarded.map((d) => d.sequence.id),
    });
    await this.#persist();
    // Re-check the zones now rather than at the next scheduled poll.
    if (this.#running && !this.#inFlight) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = this.#clock.setTimeout(() => this.#tick(), 0);
      this.#nextPollAt = this.#now();
    }
    return { changed: true, pausedMinutes, continued, discarded };
  }

  /** Polls now and then every `pollIntervalMinutes` (measured from the end of each cycle, so cycles never overlap). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = this.#now();
    this.#armPauseEnd();
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
        () => reject(new PollDeadlineError(`poll did not finish within ${POLL_DEADLINE_MS / MINUTE_MS} min (something is hanging); moving on`)),
        POLL_DEADLINE_MS,
      );
    });
    const pollStartedAt = this.#now();
    this.#remindIfStillPaused(pollStartedAt);
    this.#pollStartedAt = pollStartedAt;
    this.#nextPollAt = undefined;
    this.#inFlight = Promise.race([this.runCycle(), deadline])
      .then(() => {
        this.#polls.ok++;
        this.#lastPoll = { startedAt: pollStartedAt, finishedAt: this.#now(), ok: true };
      })
      .catch((err: unknown) => {
        if (err instanceof PollDeadlineError) this.#polls.hung++;
        else this.#polls.failed++;
        log.error('Monitoring cycle failed; will retry next poll', err);
        this.#audit.record('poll.failed', { error: errorMessage(err) });
        this.#lastPoll = { startedAt: pollStartedAt, finishedAt: this.#now(), ok: false, error: errorMessage(err) };
      })
      .finally(() => {
        this.#clock.clearTimeout(watchdog);
        this.#inFlight = undefined;
        this.#pollStartedAt = undefined;
        if (this.#running) {
          const delayMs = this.#deps.config.pollIntervalMinutes * MINUTE_MS;
          this.#nextPollAt = new Date(this.#now().getTime() + delayMs);
          this.#timer = this.#clock.setTimeout(() => this.#tick(), delayMs);
        }
      });
  }

  /** Stops polling and waits for an in-progress poll. Unfinished sequences stay saved and resume on restart. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#nextPollAt = undefined;
    this.#clock.clearTimeout(this.#pauseTimer);
    this.#pauseTimer = undefined;
    this.#sequencer.stop();
    await this.#inFlight;
    await this.#saveQueue;
  }
}

const copyPause = (p: PauseInfo): PauseInfo => ({ since: new Date(p.since), by: p.by, ...(p.until ? { until: new Date(p.until) } : {}) });

const sequenceStatus = ({ seq, dueAt, stale }: HeldSequence): SequenceStatus => ({
  id: seq.id,
  deviceId: seq.deviceId,
  zoneNames: [...(seq.zoneNames ?? [])],
  nextCycle: seq.nextWave + 1,
  cycles: seq.waves.length,
  dueAt: new Date(dueAt),
  attempts: seq.attempts,
  stale,
});

const waveSummary = (wave: readonly { station: number; runTime: number }[]): string =>
  wave.map((r) => `station ${r.station} for ${r.runTime} min`).join(', ');

const logDecision = (d: ZoneDecision): void => {
  const line = `${d.zone.name} [${d.zone.key}]: ${d.reason}: ${d.detail}`;
  if (d.action === 'skip' && !EXPECTED_SKIPS.has(d.reason)) log.warn(line);
  else log.info(line);
};
