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
import type { DeviceCommand } from './plan.ts';
import type { PendingSequence } from './state.ts';

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
 *  - Progress is saved after every step. After a restart, sequences resume if their next wave was due
 *    within `resumeWindowMinutes`; a wave found mid-send is counted as delivered.
 *  - pause() holds every sequence: no further wave is sent (checked again right before each send) until
 *    continueHeld() or discardHeld(). A held sequence continues under the same rule as after a restart:
 *    only if its next wave was due within `resumeWindowMinutes`; an older plan is abandoned instead.
 */

export type SequencerBhyve = Pick<BhyveClient, 'startWatering' | 'getDevice' | 'onEvent'>;

/** Back-off between retries of a wave, in minutes (the last value repeats). */
export const RETRY_DELAYS_MINUTES = [1, 2, 5, 10];
/** Events (reverse-engineered names) showing the device accepted a manual run. */
const STARTED_EVENTS = new Set(['watering_in_progress_notification', 'change_mode']);
const MINUTE_MS = 60_000;
/** A wave shorter than the time it takes to confirm it (plus this margin) may legitimately be over already. */
const FINISHED_MARGIN_MS = 30_000;

/** `held`: not sent because the sequencer is paused (the sequence waits for continueHeld/discardHeld). */
export type StartResult = 'delivered' | 'retrying' | 'abandoned' | 'held';

/** A wave the conductor started whose run time hasn't elapsed: water is (probably) on. */
export interface RunningWave {
  deviceId: string;
  zoneNames: string[];
  cycle: number;
  of: number;
  until: Date;
}

/** What continuing a sequence would mean right now. */
export interface HeldSequence {
  seq: PendingSequence;
  /** When its next wave is due (after counting a wave found in flight as delivered). */
  dueAt: Date;
  /** Too late to continue: continuing would abandon it (see resumeWindowMinutes). */
  stale: boolean;
}

export interface SequencerDeps {
  bhyve: SequencerBhyve;
  history: WateringHistory;
  audit: AuditSink;
  health: ConnectionHealth;
  /** Persists history + pending sequences; called after every step. */
  save: () => Promise<void>;
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
  readonly #active = new Map<string, { seq: PendingSequence; timer?: TimerHandle }>();
  readonly #clock: Clock;
  #drainWaiters: (() => void)[] = [];
  #stopped = false;
  /** "Water off" timers for sequences whose last cycle is still running. */
  readonly #finishTimers = new Set<TimerHandle>();
  #paused = false;
  /** Attempts past the last pause check, i.e. sending or confirming a wave (can't be recalled). */
  #sending = 0;
  /** The last wave delivered per device, to tell whether water is on right now. */
  readonly #lastWave = new Map<string, RunningWave>();

  constructor(deps: SequencerDeps) {
    this.#deps = deps;
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

  /** Starts a sequence and makes the first attempt at its first wave (the caller has just checked the device). */
  async start(command: DeviceCommand, details: Record<string, unknown> = {}): Promise<StartResult> {
    if (this.#paused) {
      // The monitor doesn't ask while paused; this guards against a poll that was already under way.
      log.warn(`Not starting a watering sequence on device ${command.deviceId}: the conductor is paused`);
      return 'held';
    }
    if (this.#active.has(command.deviceId)) {
      // Only possible if a poll that was given up on by the watchdog wakes up late; never run two at once.
      log.warn(`Not starting a second watering sequence on device ${command.deviceId}: one is already running`);
      return 'abandoned';
    }
    const now = this.#deps.now();
    const seq: PendingSequence = {
      id: randomUUID().slice(0, 8),
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
    return this.#attempt(seq, false);
  }

  /** Picks up sequences saved by a previous run (call once at startup). */
  async resume(saved: readonly PendingSequence[]): Promise<void> {
    for (const original of saved) {
      const seq: PendingSequence = { ...original };
      if (this.#active.has(seq.deviceId)) continue;
      this.#active.set(seq.deviceId, { seq });
      this.#reactivate(seq, 'restart');
    }
    await this.#save();
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Holds every sequence: timers are cleared and nothing more is sent until continueHeld() or
   * discardHeld(). Returns true if a wave is being sent at this very moment (it can't be recalled).
   */
  pause(): boolean {
    this.#paused = true;
    for (const entry of this.#active.values()) {
      this.#clock.clearTimeout(entry.timer);
      delete entry.timer;
    }
    // Nothing progresses while paused, so nobody should wait for it (e.g. --once).
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
    return this.#sending > 0;
  }

  /** Takes sequences saved by a previous run without sending anything (startup while paused). */
  hold(saved: readonly PendingSequence[]): void {
    this.pause();
    for (const original of saved) {
      if (!this.#active.has(original.deviceId)) this.#active.set(original.deviceId, { seq: { ...original } });
    }
  }

  /** The sequences waiting, and whether each could still be continued now. */
  held(): HeldSequence[] {
    const now = this.#deps.now().getTime();
    return this.pending().map((seq) => {
      const dueAt = effectiveDue(seq);
      // A last wave found in flight only completes the sequence: nothing more would be sent.
      const nothingLeft = seq.inFlight !== undefined && seq.inFlight.wave + 1 >= seq.waves.length;
      return { seq, dueAt, stale: !nothingLeft && (now - dueAt.getTime()) / MINUTE_MS > this.#deps.options.resumeWindowMinutes };
    });
  }

  /** Ends the pause and carries on with each held sequence that isn't too old; older ones are abandoned. */
  async continueHeld(): Promise<{ continued: PendingSequence[]; abandoned: { seq: PendingSequence; reason: string }[] }> {
    this.#paused = false;
    const continued: PendingSequence[] = [];
    const abandoned: { seq: PendingSequence; reason: string }[] = [];
    for (const seq of this.pending()) {
      const outcome = this.#reactivate(seq, 'pause');
      if (outcome.result === 'continued') continued.push(seq);
      else if (outcome.result === 'abandoned') abandoned.push({ seq, reason: outcome.reason });
    }
    await this.#save();
    return { continued, abandoned };
  }

  /** Ends the pause, abandoning every held sequence (the monitor re-evaluates the zones from their sensors). */
  async discardHeld(reason: string): Promise<PendingSequence[]> {
    this.#paused = false;
    const discarded = this.pending();
    for (const seq of discarded) this.#abandon(seq, reason);
    await this.#save();
    return discarded;
  }

  /** Waves started by the conductor whose run time hasn't elapsed yet. */
  wateringNow(): RunningWave[] {
    const now = this.#deps.now().getTime();
    return [...this.#lastWave.values()].filter((w) => w.until.getTime() > now).map((w) => ({ ...w, zoneNames: [...w.zoneNames] }));
  }

  /**
   * Brings a registered sequence back to life (after a restart or a pause): a wave found in flight
   * counts as delivered; a sequence whose next wave is overdue by more than the resume window is
   * abandoned (the plan is stale); otherwise its next wave is scheduled.
   */
  #reactivate(seq: PendingSequence, after: 'restart' | 'pause'): { result: 'continued' | 'completed' } | { result: 'abandoned'; reason: string } {
    const now = this.#deps.now();
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
      this.#recordDelivered(seq, wave, since);
      if (seq.nextWave >= seq.waves.length) {
        this.#complete(seq);
        return { result: 'completed' };
      }
      seq.dueAt = new Date(since.getTime() + (minutesOf(wave) + seq.soakMinutes) * MINUTE_MS);
    }

    const overdueMin = (now.getTime() - seq.dueAt.getTime()) / MINUTE_MS;
    if (overdueMin > this.#deps.options.resumeWindowMinutes) {
      const reason =
        after === 'restart'
          ? `too late to resume after a restart: cycle ${seq.nextWave + 1} was due ${Math.round(overdueMin)} min ago`
          : `too late to continue after the pause: cycle ${seq.nextWave + 1} was due ${Math.round(overdueMin)} min ago`;
      this.#abandon(seq, reason);
      return { result: 'abandoned', reason };
    }
    this.#deps.audit.record('sequence.resumed', {
      sequence: seq.id,
      device: seq.deviceId,
      zoneNames: seq.zoneNames,
      nextCycle: seq.nextWave + 1,
      of: seq.waves.length,
      dueAt: seq.dueAt.toISOString(),
      ...(after === 'pause' ? { after: 'pause' } : {}),
    });
    log.info(
      `${after === 'pause' ? 'Continuing' : 'Resuming'} watering sequence ${seq.id} on device ${seq.deviceId} ` +
        `at cycle ${seq.nextWave + 1}/${seq.waves.length}`,
    );
    this.#schedule(seq, Math.max(0, seq.dueAt.getTime() - now.getTime()));
    return { result: 'continued' };
  }

  /** Resolves when no sequence is running (--once uses it to let the last cycles finish). */
  drain(): Promise<void> {
    if (this.#active.size === 0 || this.#paused) return Promise.resolve();
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
    const { audit } = this.#deps;
    const index = seq.nextWave;
    const cycle = { sequence: seq.id, device: seq.deviceId, zoneNames: seq.zoneNames, cycle: index + 1, of: seq.waves.length };
    if (this.#paused) return 'held';

    if (precheck) {
      const check = await this.#precheck(seq.deviceId);
      if (!check.go) {
        if (check.abandon) {
          this.#abandon(seq, check.reason);
          await this.#save();
          return 'abandoned';
        }
        audit.record('wave.deferred', { ...cycle, reason: check.reason });
        return this.#retryOrAbandon(seq, check.reason);
      }
    }
    // Paused while the device was being checked: nothing has been sent, so nothing is.
    if (this.#paused) return 'held';

    this.#sending++;
    try {
      return await this.#send(seq, cycle);
    } finally {
      this.#sending--;
    }
  }

  async #send(seq: PendingSequence, cycle: { sequence: string; device: string; zoneNames?: string[] | undefined; cycle: number; of: number }): Promise<StartResult> {
    const { bhyve, audit, health } = this.#deps;
    const index = seq.nextWave;
    const wave = seq.waves[index] ?? [];
    // Mark the wave in flight *before* sending, so a crash from here on is detectable at restart.
    const sentAt = this.#deps.now();
    seq.inFlight = { wave: index, since: sentAt };
    await this.#save();

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
      this.#recordDelivered(seq, wave, sentAt);

      if (seq.nextWave >= seq.waves.length) {
        this.#complete(seq);
        this.#scheduleFinished(seq, minutesOf(wave) * MINUTE_MS);
      } else {
        // The wave's stations run back to back; the next wave starts after they finish plus the soak.
        seq.dueAt = new Date(sentAt.getTime() + (minutesOf(wave) + seq.soakMinutes) * MINUTE_MS);
        this.#schedule(seq, seq.dueAt.getTime() - this.#deps.now().getTime());
      }
      await this.#save();
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
    if (this.#paused) {
      // Held: no retry timer. Continuing later applies the resume window instead of the retry window.
      await this.#save();
      return 'held';
    }
    const now = this.#deps.now();
    const overdueMin = (now.getTime() - seq.dueAt.getTime()) / MINUTE_MS;
    const windowMin = this.#deps.options.retryWindowMinutes;
    if (overdueMin >= windowMin) {
      this.#abandon(seq, `gave up on ${this.#label(seq)} after ${seq.attempts} attempt(s) over ${Math.round(overdueMin)} min: ${reason}`);
      await this.#save();
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
    await this.#save();
    return 'retrying';
  }

  #schedule(seq: PendingSequence, delayMs: number): void {
    if (this.#stopped || this.#paused) return;
    const entry = this.#active.get(seq.deviceId);
    if (!entry) return;
    this.#clock.clearTimeout(entry.timer);
    entry.timer = this.#clock.setTimeout(() => {
      this.#attempt(seq, true).catch((err: unknown) => log.error(`Watering sequence ${seq.id} failed unexpectedly`, err));
    }, Math.max(0, delayMs));
  }

  #recordDelivered(seq: PendingSequence, wave: readonly StationRun[], at: Date): void {
    for (const run of wave) {
      this.#deps.history.record({ zoneKey: zoneKey({ deviceId: seq.deviceId, station: run.station }), at, minutes: run.runTime });
    }
    this.#lastWave.set(seq.deviceId, {
      deviceId: seq.deviceId,
      zoneNames: [...(seq.zoneNames ?? [])],
      cycle: seq.nextWave + 1,
      of: seq.waves.length,
      until: new Date(at.getTime() + minutesOf(wave) * MINUTE_MS),
    });
    delete seq.inFlight;
    seq.nextWave++;
    seq.attempts = 0;
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

  #complete(seq: PendingSequence): void {
    this.#deps.audit.record('sequence.completed', {
      sequence: seq.id,
      device: seq.deviceId,
      zoneNames: seq.zoneNames,
      cycles: seq.waves.length,
      deliveredMinutes: round1(seq.waves.reduce((sum, w) => sum + minutesOf(w), 0)),
    });
    this.#remove(seq);
  }

  #abandon(seq: PendingSequence, reason: string): void {
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

  async #save(): Promise<void> {
    await this.#deps.save();
  }
}

/** When the sequence's next wave is due, counting a wave found in flight as delivered (as a resume would). */
const effectiveDue = (seq: PendingSequence): Date => {
  if (!seq.inFlight) return seq.dueAt;
  const wave = seq.waves[seq.inFlight.wave] ?? [];
  return new Date(seq.inFlight.since.getTime() + (minutesOf(wave) + seq.soakMinutes) * MINUTE_MS);
};

const summary = (wave: readonly StationRun[]): string => wave.map((r) => `station ${r.station} for ${r.runTime} min`).join(', ');

