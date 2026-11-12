import type { BhyveClient } from '../bhyve/client.ts';
import { log } from '../log.ts';
import type { MoistureReading, MoistureSource } from '../sensors/types.ts';
import { zoneKey, type ConductorConfig } from './config.ts';
import type { WateringHistory } from './history.ts';
import { applyDeviceState, evaluateZone, type DeviceCommand, type ZoneDecision } from './plan.ts';

/** The parts of BhyveClient the monitor needs (lets tests pass a fake). */
export type BhyveControl = Pick<BhyveClient, 'getDevices' | 'startWatering'>;

export interface HistoryStore {
  save(history: WateringHistory): Promise<void>;
}

export interface MonitorDeps {
  config: ConductorConfig;
  source: MoistureSource;
  bhyve: BhyveControl;
  history: WateringHistory;
  /** Where to persist history after watering. Omit to keep it in memory only. */
  store?: HistoryStore;
  now?: () => Date;
}

export interface CycleResult {
  at: Date;
  decisions: ZoneDecision[];
  /** Commands sent to B-hyve (or that would have been, in dry-run mode). */
  sent: DeviceCommand[];
  failed: { command: DeviceCommand; error: unknown }[];
}

const MINUTE_MS = 60_000;
/** Skip reasons that are normal operation rather than something to look into. */
const EXPECTED_SKIPS = new Set(['cooldown', 'daily-limit', 'rain-delay', 'already-watering']);

/**
 * Polls the soil sensors and starts a supplemental B-hyve run for each zone whose soil is
 * below its threshold. The regular B-hyve schedule is left as is, and these runs are added on top.
 */
export class Monitor {
  readonly #deps: MonitorDeps;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #inFlight: Promise<unknown> | undefined;

  constructor(deps: MonitorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Runs one poll → decide → water cycle. Throws if the sensors or B-hyve can't be read. */
  async runCycle(): Promise<CycleResult> {
    const { config, source, bhyve, history } = this.#deps;
    const now = this.#now();

    const readings = new Map<string, MoistureReading>();
    for (const r of await source.read()) readings.set(r.sensorId, r);

    let decisions = config.zones.map((zone) => evaluateZone(zone, readings, history, now));
    let commands: DeviceCommand[] = [];

    // Only talk to B-hyve when something actually needs water.
    if (decisions.some((d) => d.action === 'water')) {
      ({ decisions, commands } = applyDeviceState(decisions, await bhyve.getDevices()));
    }
    decisions.forEach(logDecision);

    const sent: DeviceCommand[] = [];
    const failed: CycleResult['failed'] = [];
    for (const command of commands) {
      const summary = command.runs.map((r) => `station ${r.station} for ${r.runTime} min`).join(', ');
      if (config.dryRun) {
        log.info(`[dry run] would water device ${command.deviceId}: ${summary}`);
        sent.push(command);
        continue;
      }
      try {
        await bhyve.startWatering(command.deviceId, command.runs);
      } catch (error) {
        log.error(`Failed to start watering on device ${command.deviceId}`, error);
        failed.push({ command, error });
        continue;
      }
      log.info(`Started watering on device ${command.deviceId}: ${summary}`);
      sent.push(command);
      for (const run of command.runs) {
        history.record({ zoneKey: zoneKey({ deviceId: command.deviceId, station: run.station }), at: now, minutes: run.runTime });
      }
    }

    if (!config.dryRun && sent.length > 0) await this.#persist(now);
    return { at: now, decisions, sent, failed };
  }

  async #persist(now: Date): Promise<void> {
    const { config, history, store } = this.#deps;
    const longestCooldown = Math.max(0, ...config.zones.map((z) => z.cooldownMinutes));
    history.prune(now, longestCooldown * MINUTE_MS);
    try {
      await store?.save(history);
    } catch (err) {
      // The run already started; keep going, but a restart now could water this zone again too soon.
      log.error('Could not save watering history; cooldowns will not survive a restart', err);
    }
  }

  /** Polls now and then every `pollIntervalMinutes` (measured from the end of each cycle, so cycles never overlap). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    log.info(
      `Monitoring ${this.#deps.config.zones.length} zone(s) every ${this.#deps.config.pollIntervalMinutes} min` +
        (this.#deps.config.dryRun ? ' (dry run: no commands will be sent)' : ''),
    );
    this.#tick();
  }

  #tick(): void {
    this.#inFlight = this.runCycle()
      .catch((err: unknown) => log.error('Monitoring cycle failed; will retry next poll', err))
      .finally(() => {
        this.#inFlight = undefined;
        if (this.#running) {
          this.#timer = setTimeout(() => this.#tick(), this.#deps.config.pollIntervalMinutes * MINUTE_MS);
        }
      });
  }

  /** Stops polling and waits for an in-progress cycle to finish. */
  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }
}

const logDecision = (d: ZoneDecision): void => {
  const line = `${d.zone.name} [${d.zone.key}]: ${d.reason}: ${d.detail}`;
  if (d.action === 'skip' && !EXPECTED_SKIPS.has(d.reason)) log.warn(line);
  else log.info(line);
};
