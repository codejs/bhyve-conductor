import { errorMessage, type AuditSink } from '../audit/audit.ts';
import type { WaveDelivery } from '../db/schema.ts';
import { log } from '../log.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { AlertState } from './alerts.ts';
import type { WateringRun } from './history.ts';
import type { PendingSequence } from './state.ts';
import type { WaterBudget } from './water-budget.ts';

/**
 * What the conductor persists, one step at a time (implemented over SQLite by src/db/store.ts). Each call
 * is one transaction, made at the moment the step happens. In particular `waveSending` is on disk before
 * the watering command leaves, so a crash mid-send is detectable at restart.
 *
 * Implementations may throw. The Monitor and Sequencer only ever see a `guardStore()` wrapper, which turns a
 * failure into a log line and one `state.save_failed` audit event per outage; watering carries on.
 */

export type { WaveDelivery };

/** Why a zone is part of a sequence: the decision that led to it. */
export interface SequenceZone {
  zoneKey: string;
  zoneName: string;
  thresholdPct: number;
  targetPct: number;
  /** Total minutes planned for the zone, over all waves. */
  requestedMinutes: number;
  moisturePct?: number;
  readingAt?: Date;
  allowanceMinutes?: number;
  budget?: WaterBudget;
  detail: string;
}

/** A zone's dry spell and sensor blackout (Monitor #drySince / #noDataSince). */
export interface ZoneSpell {
  zoneKey: string;
  drySince?: Date;
  noDataSince?: Date;
}

export interface SavedZoneSpell extends ZoneSpell {
  /** The poll that last saved it. */
  evaluatedAt: Date;
}

/** The Sequencer's steps. */
export interface SequenceJournal {
  /** Planned: the sequence, why each zone is in it, its waves. Wave 0 is due at `seq.dueAt`. */
  sequenceStarted(seq: PendingSequence, zones: readonly SequenceZone[]): void;
  /** About to send the wave. Must be durable before the command is sent. */
  waveSending(seq: PendingSequence, wave: number, at: Date): void;
  /** An attempt at the wave failed (send failed, device idle, deferred); it is pending again. */
  waveFailed(seq: PendingSequence, wave: number): void;
  /** The wave counts as delivered: its runs go into the watering ledger. `nextDueAt` is unset for the last wave. */
  waveDelivered(seq: PendingSequence, wave: number, delivery: WaveDelivery, sentAt: Date, nextDueAt: Date | undefined): void;
  sequenceCompleted(seq: PendingSequence, at: Date): void;
  /** The rest of the sequence won't be sent. */
  sequenceAbandoned(seq: PendingSequence, at: Date, reason: string): void;
}

/** Everything the conductor persists. */
export interface ConductorStore extends SequenceJournal {
  /** Replaces the open alert conditions. */
  saveAlerts(alerts: AlertState): void;
  /** Every configured zone's spells after a poll. */
  saveZoneSpells(spells: readonly ZoneSpell[], at: Date): void;
  recordReadings(readings: readonly MoistureReading[], polledAt: Date): void;
}

/** What a previous run left, to carry on from. */
export interface StoredState {
  /** Recent supplemental runs (enough for cooldowns and the 24 h cap). */
  history: WateringRun[];
  sequences: PendingSequence[];
  alerts: AlertState;
  zoneSpells: SavedZoneSpell[];
}

const nothing = (): void => {};

/** Persists nothing (dry runs, and tests that don't look at storage). */
export const noStore: ConductorStore = {
  sequenceStarted: nothing,
  waveSending: nothing,
  waveFailed: nothing,
  waveDelivered: nothing,
  sequenceCompleted: nothing,
  sequenceAbandoned: nothing,
  saveAlerts: nothing,
  saveZoneSpells: nothing,
  recordReadings: nothing,
};

const METHODS = Object.keys(noStore) as (keyof ConductorStore)[];

/** SQLite result codes that can clear up by themselves: busy, locked, read-only, I/O error, disk full, can't open. */
const TRANSIENT_CODES = new Set([5, 6, 8, 10, 13, 14]);
/** Writes kept for replay during a storage outage (the oldest are dropped beyond this). */
export const MAX_BACKLOG = 1_000;

/** Whether a failed write may succeed later (drizzle wraps the driver's error: look through `cause`). */
export const isTransientStorageError = (err: unknown): boolean => {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { errcode?: unknown }).errcode;
    if (typeof code === 'number') return TRANSIENT_CODES.has(code & 0xff);
  }
  return false;
};

const describeError = (err: unknown): string => {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  return cause ?? errorMessage(err);
};

/**
 * Wraps a store so that it never throws, and so that a storage outage (disk full, I/O error, locked) loses
 * nothing while the process runs: a write that fails for such a reason is kept, with a copy of its
 * arguments, and replayed in order before the next write. Once storage works again, the database catches
 * up with everything that happened meanwhile (cooldowns and daily caps would otherwise under-count after a
 * restart). A write that fails for good (a constraint, a bug) is logged and skipped, so it can't block the
 * rest. Replays are in memory: a restart during an outage loses what wasn't written.
 *
 * Like ConnectionHealth, it audits transitions only: one `state.save_failed` when saving starts failing,
 * one `state.save_restored` when everything is written again.
 */
export const guardStore = (store: ConductorStore, audit: AuditSink, now: () => Date = () => new Date()): ConductorStore => {
  const backlog: { method: keyof ConductorStore; args: unknown[] }[] = [];
  let outage: { since: Date; failures: number; lastError: string } | undefined;

  const failed = (method: keyof ConductorStore, err: unknown, willRetry: boolean): void => {
    const error = describeError(err);
    if (outage) {
      outage.failures++;
      outage.lastError = error;
      if (!willRetry) log.error(`Could not save ${method}; skipped`, err);
      return;
    }
    log.error(`Could not save ${method}${willRetry ? '; will retry with the next save' : '; skipped'}`, err);
    outage = { since: now(), failures: 1, lastError: error };
    audit.record('state.save_failed', { step: method, error });
  };

  const apply = (method: keyof ConductorStore, args: unknown[]): void => {
    (store[method] as (...a: unknown[]) => void)(...args);
  };

  /** Writes the backlog in order; stops at a failure that may clear up. True if everything is written. */
  const drain = (): boolean => {
    while (backlog.length > 0) {
      const op = backlog[0];
      if (!op) break;
      try {
        apply(op.method, op.args);
      } catch (err) {
        if (isTransientStorageError(err)) {
          failed(op.method, err, true);
          return false;
        }
        failed(op.method, err, false);
      }
      backlog.shift();
    }
    return true;
  };

  const restored = (): void => {
    if (!outage) return;
    const minutes = Math.round(((now().getTime() - outage.since.getTime()) / 60_000) * 10) / 10;
    log.info(`Saving state works again after ${outage.failures} failure(s) over ${minutes} min`);
    audit.record('state.save_restored', { failures: outage.failures, outageMinutes: minutes, lastError: outage.lastError });
    outage = undefined;
  };

  const guarded = {} as Record<keyof ConductorStore, (...args: unknown[]) => void>;
  for (const method of METHODS) {
    guarded[method] = (...args: unknown[]) => {
      if (backlog.length === 0) {
        try {
          apply(method, args);
          restored();
          return;
        } catch (err) {
          if (!isTransientStorageError(err)) {
            failed(method, err, false);
            return;
          }
          failed(method, err, true);
          // Copy the arguments now: the caller goes on changing its objects (the sequence moves on).
          backlog.push({ method, args: structuredClone(args) });
          return;
        }
      }
      backlog.push({ method, args: structuredClone(args) });
      if (backlog.length > MAX_BACKLOG) {
        const dropped = backlog.shift();
        log.error(`Storage outage: dropped the oldest unsaved ${dropped?.method ?? 'write'} (more than ${MAX_BACKLOG} waiting)`);
      }
      if (drain()) restored();
    };
  }
  return guarded as unknown as ConductorStore;
};
