import { randomUUID } from 'node:crypto';
import type { AuditSink } from '../audit/audit.ts';
import { errorMessage } from '../audit/audit.ts';
import type { ConnectionHealth } from '../audit/health.ts';
import { systemClock, type Clock, type TimerHandle } from '../clock.ts';
import type { BhyveClient } from '../bhyve/client.ts';
import type { BhyveEvent, StationRun } from '../bhyve/types.ts';
import { log } from '../log.ts';
import { zoneKey, type RecoveryOptions } from './config.ts';
import type { WateringHistory } from './history.ts';
import type { DeviceCommand, ZoneDecision } from './plan.ts';
import type { PendingSequence } from './state.ts';
import { noStore, type SequenceJournal, type SequenceZone, type WaveDelivery } from './store.ts';

/**
 * Runs watering sequences (one or more cycle-and-soak waves per device) so that they survive
 * connection problems and restarts without ever watering twice:
 *
 *  - Every wave is confirmed: by a B-hyve event from the device, or else by the device status.
 *  - A wave is re-sent only when it provably didn't start: the send itself failed (socket down), or
 *    B-hyve reported the device idle on two checks with no start event in between. If delivery can't be
 *    determined (e.g. REST is down too), it is assumed delivered and audited as `wave.unconfirmed`.
 *  - Before each later wave the device is checked: switched off or rain delay set → the rest is
 *    abandoned (the owner intervened); offline, busy or unreadable → retried.
 *  - Retries back off (1, 2, 5, 10 min...) until `retryWindowMinutes` after the wave was due; then the
 *    rest of the sequence is abandoned and the zone is re-evaluated by the normal monitoring.
 *  - Every step is saved as it happens (SequenceJournal), the in-flight marker before the command is
 *    sent. After a restart, sequences resume if their next wave was due within `resumeWindowMinutes`; a
 *    wave found mid-send is counted as delivered.
 */

export type SequencerBhyve = Pick<BhyveClient, 'startWatering' | 'getDevice' | 'onEvent'>;

/** Back-off between retries of a wave, in minutes (the last value repeats). */
export const RETRY_DELAYS_MINUTES = [1, 2, 5, 10];
/** Events (reverse-engineered names) showing the device accepted a manual run. */
const STARTED_EVENTS = new Set(['watering_in_progress_notification', 'change_mode']);
const MINUTE_MS = 60_000;
/** A wave shorter than the time it takes to confirm it (plus this margin) may legitimately be over already. */
const FINISHED_MARGIN_MS = 30_000;

export type StartResult = 'delivered' | 'retrying' | 'abandoned';

export interface SequencerDeps {
  bhyve: SequencerBhyve;
  history: WateringHistory;
  audit: AuditSink;
  health: ConnectionHealth;
  /** Where each step is saved (default: nowhere). Each step is awaited. Expected not to reject (see guardStore). */
  store?: SequenceJournal;
  options: RecoveryOptions;
  now: () => Date;
  /** Timers (default: the system's). */
  clock?: Clock;
}

type Precheck = { go: true } | { go: false; abandon: boolean; reason: string };
type Delivery = 'event' | 'status' | 'idle' | 'unknown';

const minutesOf = (wave: readonly StationRun[]): number => wave.reduce((sum, r) => sum + r.runTime, 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;

export class Sequencer {
  readonly #deps: SequencerDeps;
  readonly #store: SequenceJournal;
  readonly #active = new Map<string, { seq: PendingSequence; timer?: TimerHandle }>();
  readonly #clock: Clock;
  #drainWaiters: (() => void)[] = [];
  #stopped = false;
  /** "Water off" timers for sequences whose last cycle is still running. */
  readonly #finishTimers = new Set<TimerHandle>();

  constructor(deps: SequencerDeps) {
    this.#deps = deps;
    this.#store = deps.store ?? noStore;
    this.#clock = deps.clock ?? systemClock;
  }

  /** Sequences not yet finished (to persist). */
  pending(): PendingSequence[] {
    return [...this.#active.values()].map((a) => a.seq);
  }

  isActive(deviceId: string): boolean {
    return this.#active.has(deviceId);
  }

  /** "cycle 2/3" of the device's running sequence, for messages. */
  progress(deviceId: string): string {
    const seq = this.#active.get(deviceId)?.seq;
    return seq ? `cycle ${seq.nextWave + 1}/${seq.waves.length}` : '';
  }

  /**
   * Starts a sequence and makes the first attempt at its first wave (the caller has just checked the device).
   * `details` go into the `sequence.started` audit event; `decisions` are saved as the reason for each zone.
   */
  async start(command: DeviceCommand, details: Record<string, unknown> = {}, decisions: readonly ZoneDecision[] = []): Promise<StartResult> {
    if (this.#active.has(command.deviceId)) {
      // Only possible if a poll that was given up on by the watchdog wakes up late; never run two at once.
      log.warn(`Not starting a second watering sequence on device ${command.deviceId}: one is already running`);
      return 'abandoned';
    }
    const now = this.#deps.now();
    const seq: PendingSequence = {
      // A full UUID: ids are kept forever in the database (messages show the first 8 characters).
      id: randomUUID(),
      deviceId: command.deviceId,
      waves: command.waves,
      soakMinutes: command.soakMinutes,
      zoneNames: command.zones.map((z) => z.name),
      createdAt: now,
      nextWave: 0,
      dueAt: now,
      attempts: 0,
    };
    this.#active.set(seq.deviceId, { seq });
    this.#deps.audit.record('sequence.started', {
      sequence: seq.id,
      device: seq.deviceId,
      zoneNames: seq.zoneNames,
      waves: seq.waves,
      soakMinutes: seq.soakMinutes,
      plannedMinutes: round1(seq.waves.reduce((sum, w) => sum + minutesOf(w), 0)),
      ...details,
    });
    await this.#store.sequenceStarted(seq, zonesOf(command, decisions));
    return this.#attempt(seq, false);
  }

  /** Picks up sequences saved by a previous run (call once at startup). */
  async resume(saved: readonly PendingSequence[]): Promise<void> {
    const now = this.#deps.now();
    for (const original of saved) {
      const seq: PendingSequence = { ...original };
      if (this.#active.has(seq.deviceId)) continue;
      this.#active.set(seq.deviceId, { seq });

      if (seq.inFlight) {
        // We crashed between sending a wave and saving its outcome. It may well have run; counting it as
        // delivered risks a little under-watering, re-sending it risks watering twice.
        const { wave: index, since } = seq.inFlight;
        const wave = seq.waves[index] ?? [];
        this.#deps.audit.record('wave.assumed_delivered', {
          sequence: seq.id,
          device: seq.deviceId,
          zoneNames: seq.zoneNames,
          cycle: index + 1,
          of: seq.waves.length,
          stations: wave,
          sentAt: since.toISOString(),
          reason: 'found in flight after a restart',
        });
        await this.#recordDelivered(seq, index, since, 'assumed');
        if (seq.nextWave >= seq.waves.length) {
          await this.#complete(seq);
          continue;
        }
      }

      const overdueMin = (now.getTime() - seq.dueAt.getTime()) / MINUTE_MS;
      if (overdueMin > this.#deps.options.resumeWindowMinutes) {
        await this.#abandon(seq, `too late to resume after a restart: cycle ${seq.nextWave + 1} was due ${Math.round(overdueMin)} min ago`);
        continue;
      }
      this.#deps.audit.record('sequence.resumed', {
        sequence: seq.id,
        device: seq.deviceId,
        zoneNames: seq.zoneNames,
        nextCycle: seq.nextWave + 1,
        of: seq.waves.length,
        dueAt: seq.dueAt.toISOString(),
      });
      log.info(`Resuming watering sequence ${seq.id} on device ${seq.deviceId} at cycle ${seq.nextWave + 1}/${seq.waves.length}`);
      this.#schedule(seq, Math.max(0, seq.dueAt.getTime() - now.getTime()));
    }
  }

  /** Resolves when no sequence is running (--once uses it to let the last cycles finish). */
  drain(): Promise<void> {
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  /** Stops timers. Pending sequences stay saved and resume on the next start (within the resume window). */
  stop(): void {
    this.#stopped = true;
    for (const { timer } of this.#active.values()) this.#clock.clearTimeout(timer);
    for (const timer of this.#finishTimers) this.#clock.clearTimeout(timer);
    this.#finishTimers.clear();
    if (this.#active.size > 0) {
      log.warn(
        `Stopping with ${this.#active.size} unfinished watering sequence(s) (${[...this.#active.keys()].join(', ')}); ` +
          `they resume on restart if it's within ${this.#deps.options.resumeWindowMinutes} min`,
      );
    }
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }

  // ---------- one attempt at the next wave ----------

  async #attempt(seq: PendingSequence, precheck: boolean): Promise<StartResult> {
    const { bhyve, audit, health } = this.#deps;
    const index = seq.nextWave;
    const wave = seq.waves[index] ?? [];
    const cycle = { sequence: seq.id, device: seq.deviceId, zoneNames: seq.zoneNames, cycle: index + 1, of: seq.waves.length };

    if (precheck) {
      const check = await this.#precheck(seq.deviceId);
      if (!check.go) {
        if (check.abandon) {
          await this.#abandon(seq, check.reason);
          return 'abandoned';
        }
        audit.record('wave.deferred', { ...cycle, reason: check.reason });
        return this.#retryOrAbandon(seq, check.reason);
      }
    }

    // Mark the wave in flight and wait until it is saved *before* sending, so a crash from here on is detectable at restart.
    const sentAt = this.#deps.now();
    seq.inFlight = { wave: index, since: sentAt };
    await this.#store.waveSending(seq, index, sentAt);

    let acknowledged = false;
    let onAck: () => void = () => {};
    const ack = new Promise<void>((resolve) => {
      onAck = resolve;
    });
    const unsubscribe = bhyve.onEvent((e: BhyveEvent) => {
      if (e.device_id === seq.deviceId && STARTED_EVENTS.has(e.event)) {
        acknowledged = true;
        onAck();
      }
    });

    try {
      try {
        await bhyve.startWatering(seq.deviceId, wave);
      } catch (err) {
        // Nothing left our side (no socket, or it refused the message): safe to retry.
        delete seq.inFlight;
        health.failed('bhyve-commands', err);
        audit.record('wave.send_failed', { ...cycle, stations: wave, error: errorMessage(err) });
        log.error(`Could not send ${this.#label(seq)} to device ${seq.deviceId}`, err);
        return await this.#retryOrAbandon(seq, errorMessage(err));
      }
      health.ok('bhyve-commands');
      audit.record('wave.sent', { ...cycle, stations: wave, attempt: seq.attempts + 1 });

      const delivery = await this.#confirm(seq.deviceId, () => acknowledged, ack, sentAt, minutesOf(wave));
      if (delivery === 'idle') {
        delete seq.inFlight;
        audit.record('wave.not_started', { ...cycle, reason: 'B-hyve reported the device idle twice after the command' });
        log.warn(`Device ${seq.deviceId} did not start ${this.#label(seq)}; will retry`);
        return await this.#retryOrAbandon(seq, 'the device did not start the run');
      }

      if (delivery === 'unknown') {
        audit.record('wave.unconfirmed', {
          ...cycle,
          reason: 'no acknowledgement and the device status could not be read; counted as delivered so it is never sent twice',
        });
        log.warn(`Could not confirm ${this.#label(seq)} on device ${seq.deviceId}; counting it as delivered`);
      } else {
        audit.record('wave.confirmed', { ...cycle, via: delivery });
      }
      log.info(`Watering device ${seq.deviceId} (${this.#label(seq)}): ${summary(wave)}`);
      await this.#recordDelivered(seq, index, sentAt, delivery === 'unknown' ? 'unconfirmed' : delivery);

      if (seq.nextWave >= seq.waves.length) {
        await this.#complete(seq);
        this.#scheduleFinished(seq, minutesOf(wave) * MINUTE_MS);
      } else {
        this.#schedule(seq, seq.dueAt.getTime() - this.#deps.now().getTime());
      }
      return 'delivered';
    } finally {
      unsubscribe();
    }
  }

  /** Is the device in a state to take the next wave? */
  async #precheck(deviceId: string): Promise<Precheck> {
    const { bhyve, health } = this.#deps;
    let device;
    try {
      device = await bhyve.getDevice(deviceId);
      health.ok('bhyve');
    } catch (err) {
      // Don't send blind: the owner may have switched the device off in the meantime.
      health.failed('bhyve', err);
      return { go: false, abandon: false, reason: `could not read the device status: ${errorMessage(err)}` };
    }
    const status = device.status;
    if (status?.run_mode === 'off') return { go: false, abandon: true, reason: 'the device was switched off' };
    if (typeof status?.rain_delay === 'number' && status.rain_delay > 0) {
      return { go: false, abandon: true, reason: `a ${status.rain_delay}h rain delay was set` };
    }
    if (device.is_connected === false) return { go: false, abandon: false, reason: 'the device is offline' };
    if (status?.watering_status) return { go: false, abandon: false, reason: 'the device is busy watering' };
    return { go: true };
  }

  /**
   * Did the device start? An acknowledgement event settles it. Otherwise ask for its status twice
   * (B-hyve's status can lag): only two "idle" answers, with no event in between and while the wave
   * would certainly still be running, count as "didn't start".
   */
  async #confirm(
    deviceId: string,
    acknowledged: () => boolean,
    ack: Promise<void>,
    sentAt: Date,
    waveMinutes: number,
  ): Promise<Delivery> {
    const waitMs = this.#deps.options.confirmTimeoutSeconds * 1000;
    const waitForAck = async (): Promise<boolean> => {
      if (acknowledged()) return true;
      if (waitMs > 0) {
        let timer: TimerHandle | undefined;
        await Promise.race([ack, new Promise<void>((resolve) => (timer = this.#clock.setTimeout(resolve, waitMs)))]);
        this.#clock.clearTimeout(timer);
      }
      return acknowledged();
    };
    const status = async (): Promise<'watering' | 'idle' | 'unknown'> => {
      try {
        const device = await this.#deps.bhyve.getDevice(deviceId);
        this.#deps.health.ok('bhyve');
        return device.status?.watering_status ? 'watering' : 'idle';
      } catch (err) {
        this.#deps.health.failed('bhyve', err);
        return 'unknown';
      }
    };

    if (await waitForAck()) return 'event';
    const first = await status();
    if (first === 'watering') return 'status';
    if (first === 'unknown') return 'unknown';
    if (await waitForAck()) return 'event';
    const second = await status();
    if (acknowledged()) return 'event';
    if (second === 'watering') return 'status';
    if (second === 'unknown') return 'unknown';
    // Idle twice. But a short wave may simply be over already; never re-send unless it can't be.
    const elapsed = this.#deps.now().getTime() - sentAt.getTime();
    return waveMinutes * MINUTE_MS > elapsed + FINISHED_MARGIN_MS ? 'idle' : 'unknown';
  }

  // ---------- bookkeeping ----------

  async #retryOrAbandon(seq: PendingSequence, reason: string): Promise<StartResult> {
    seq.attempts++;
    await this.#store.waveFailed(seq, seq.nextWave);
    const now = this.#deps.now();
    const overdueMin = (now.getTime() - seq.dueAt.getTime()) / MINUTE_MS;
    const windowMin = this.#deps.options.retryWindowMinutes;
    if (overdueMin >= windowMin) {
      await this.#abandon(seq, `gave up on ${this.#label(seq)} after ${seq.attempts} attempt(s) over ${Math.round(overdueMin)} min: ${reason}`);
      return 'abandoned';
    }
    const backoff = RETRY_DELAYS_MINUTES[Math.min(seq.attempts, RETRY_DELAYS_MINUTES.length) - 1] ?? 1;
    // Make one last attempt right at the end of the window rather than skipping past it.
    const delayMin = Math.min(backoff, windowMin - overdueMin);
    this.#deps.audit.record('wave.retry_scheduled', {
      sequence: seq.id,
      device: seq.deviceId,
      cycle: seq.nextWave + 1,
      of: seq.waves.length,
      attempt: seq.attempts + 1,
      inMinutes: round1(delayMin),
      reason,
    });
    this.#schedule(seq, delayMin * MINUTE_MS);
    return 'retrying';
  }

  #schedule(seq: PendingSequence, delayMs: number): void {
    if (this.#stopped) return;
    const entry = this.#active.get(seq.deviceId);
    if (!entry) return;
    this.#clock.clearTimeout(entry.timer);
    entry.timer = this.#clock.setTimeout(() => {
      this.#attempt(seq, true).catch((err: unknown) => log.error(`Watering sequence ${seq.id} failed unexpectedly`, err));
    }, Math.max(0, delayMs));
  }

  /** Counts wave `index` (sent at `at`) as delivered; the next wave is due when it has run plus the soak. */
  async #recordDelivered(seq: PendingSequence, index: number, at: Date, delivery: WaveDelivery): Promise<void> {
    const wave = seq.waves[index] ?? [];
    for (const run of wave) {
      this.#deps.history.record({ zoneKey: zoneKey({ deviceId: seq.deviceId, station: run.station }), at, minutes: run.runTime });
    }
    // The wave's stations run back to back; the next wave starts after they finish plus the soak.
    const nextDueAt = index + 1 < seq.waves.length ? new Date(at.getTime() + (minutesOf(wave) + seq.soakMinutes) * MINUTE_MS) : undefined;
    await this.#store.waveDelivered(seq, index, delivery, at, nextDueAt);
    delete seq.inFlight;
    seq.nextWave = index + 1;
    seq.attempts = 0;
    if (nextDueAt) seq.dueAt = nextDueAt;
  }

  /** Reports the water going off once the last cycle's run time has elapsed (not persisted: a restart skips it). */
  #scheduleFinished(seq: PendingSequence, afterMs: number): void {
    if (this.#stopped) return;
    const timer = this.#clock.setTimeout(() => {
      this.#finishTimers.delete(timer);
      this.#deps.audit.record('sequence.finished', {
        sequence: seq.id,
        device: seq.deviceId,
        zoneNames: seq.zoneNames,
        cycles: seq.waves.length,
        deliveredMinutes: round1(seq.waves.reduce((sum, w) => sum + minutesOf(w), 0)),
        startedAt: seq.createdAt.toISOString(),
      });
    }, afterMs);
    this.#finishTimers.add(timer);
  }

  async #complete(seq: PendingSequence): Promise<void> {
    this.#deps.audit.record('sequence.completed', {
      sequence: seq.id,
      device: seq.deviceId,
      zoneNames: seq.zoneNames,
      cycles: seq.waves.length,
      deliveredMinutes: round1(seq.waves.reduce((sum, w) => sum + minutesOf(w), 0)),
    });
    await this.#store.sequenceCompleted(seq, this.#deps.now());
    this.#remove(seq);
  }

  async #abandon(seq: PendingSequence, reason: string): Promise<void> {
    const delivered = seq.waves.slice(0, seq.nextWave).reduce((sum, w) => sum + minutesOf(w), 0);
    const planned = seq.waves.reduce((sum, w) => sum + minutesOf(w), 0);
    this.#deps.audit.record('sequence.abandoned', {
      sequence: seq.id,
      device: seq.deviceId,
      zoneNames: seq.zoneNames,
      reason,
      cyclesDelivered: seq.nextWave,
      of: seq.waves.length,
      deliveredMinutes: round1(delivered),
      plannedMinutes: round1(planned),
    });
    log.warn(
      `Abandoned watering sequence ${seq.id} on device ${seq.deviceId} after ${seq.nextWave}/${seq.waves.length} cycle(s) ` +
        `(${round1(delivered)} of ${round1(planned)} min): ${reason}`,
    );
    await this.#store.sequenceAbandoned(seq, this.#deps.now(), reason);
    this.#remove(seq);
  }

  #remove(seq: PendingSequence): void {
    const entry = this.#active.get(seq.deviceId);
    if (entry?.seq !== seq) return;
    this.#clock.clearTimeout(entry.timer);
    this.#active.delete(seq.deviceId);
    if (this.#active.size === 0) for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }

  #label(seq: PendingSequence): string {
    return seq.waves.length > 1 ? `cycle ${seq.nextWave + 1}/${seq.waves.length}` : 'the run';
  }

}

/** Why each zone is in the sequence, from the command's zones and the decisions that led to it. */
const zonesOf = (command: DeviceCommand, decisions: readonly ZoneDecision[]): SequenceZone[] =>
  command.zones.flatMap((z): SequenceZone[] => {
    const minutes = round1(command.waves.flat().reduce((sum, r) => (r.station === z.station ? sum + r.runTime : sum), 0));
    if (minutes <= 0) return [];
    const d = decisions.find((x) => x.zone.key === z.key);
    const at = d?.reading?.at;
    return [
      {
        zoneKey: z.key,
        zoneName: z.name,
        thresholdPct: z.thresholdPct,
        targetPct: z.targetPct,
        requestedMinutes: minutes,
        ...(d?.reading && Number.isFinite(d.reading.moisturePct) ? { moisturePct: d.reading.moisturePct } : {}),
        ...(at && Number.isFinite(at.getTime()) ? { readingAt: at } : {}),
        ...(d?.allowanceMinutes !== undefined ? { allowanceMinutes: d.allowanceMinutes } : {}),
        ...(d?.budget ? { budget: d.budget } : {}),
        detail: d?.detail ?? 'no decision recorded',
      },
    ];
  });

const summary = (wave: readonly StationRun[]): string => wave.map((r) => `station ${r.station} for ${r.runTime} min`).join(', ');

