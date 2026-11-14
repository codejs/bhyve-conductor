import { errorMessage, type AuditSink } from '../audit/audit.ts';
import type { WaveDelivery } from '../db/model.ts';
import { log } from '../log.ts';
import type { MoistureReading } from '../sensors/types.ts';
import type { AlertState } from './alerts.ts';
import type { WateringRun } from './history.ts';
import type { PendingSequence } from './state.ts';
import type { WaterBudget } from './water-budget.ts';

/**
 * What the conductor persists, one step at a time (implemented with Prisma over SQLite by src/db/store.ts).
 * Each call is one transaction, made when the step happens, and the caller awaits it. In particular
 * `waveSending` is on disk before the watering command leaves, so a crash mid-send is detectable at restart.
 *
 * Implementations may reject. The Monitor and Sequencer only ever see a `guardStore()` wrapper, which writes
 * in call order, turns a failure into a log line and one `state.save_failed` audit event per outage, and
 * never rejects: watering carries on.
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
  sequenceStarted(seq: PendingSequence, zones: readonly SequenceZone[]): Promise<void>;
  /** About to send the wave. Must be durable before the command is sent. */
  waveSending(seq: PendingSequence, wave: number, at: Date): Promise<void>;
  /** An attempt at the wave failed (send failed, device idle, deferred); it is pending again. */
  waveFailed(seq: PendingSequence, wave: number): Promise<void>;
  /** The wave counts as delivered: its runs go into the watering ledger. `nextDueAt` is unset for the last wave. */
  waveDelivered(seq: PendingSequence, wave: number, delivery: WaveDelivery, sentAt: Date, nextDueAt: Date | undefined): Promise<void>;
  sequenceCompleted(seq: PendingSequence, at: Date): Promise<void>;
  /** The rest of the sequence won't be sent. */
  sequenceAbandoned(seq: PendingSequence, at: Date, reason: string): Promise<void>;
}

/** Everything the conductor persists. */
export interface ConductorStore extends SequenceJournal {
  /** Replaces the open alert conditions. */
  saveAlerts(alerts: AlertState): Promise<void>;
  /** Every configured zone's spells after a poll. */
  saveZoneSpells(spells: readonly ZoneSpell[], at: Date): Promise<void>;
  recordReadings(readings: readonly MoistureReading[], polledAt: Date): Promise<void>;
}

/** What a previous run left, to carry on from. */
export interface StoredState {
  /** Recent supplemental runs (enough for cooldowns and the 24 h cap). */
  history: WateringRun[];
  sequences: PendingSequence[];
  alerts: AlertState;
  zoneSpells: SavedZoneSpell[];
}

const nothing = async (): Promise<void> => {};

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

/**
 * What SQLite said about a failed write, wherever it is in the error: node:sqlite's own error (`errcode`),
 * the driver adapter's (`cause` = { kind, extendedCode }), or Prisma's (`meta.driverAdapterError.cause`).
 */
export const storageErrorOf = (err: unknown): { code?: number; kind?: string; message?: string } | undefined => {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && typeof e === 'object' && !seen.has(e); ) {
    seen.add(e);
    const o = e as { errcode?: unknown; kind?: unknown; extendedCode?: unknown; message?: unknown; cause?: unknown; meta?: { driverAdapterError?: unknown } };
    if (typeof o.errcode === 'number') return { code: o.errcode, ...(typeof o.message === 'string' ? { message: o.message } : {}) };
    if (typeof o.kind === 'string') {
      return {
        kind: o.kind,
        ...(typeof o.extendedCode === 'number' ? { code: o.extendedCode } : {}),
        ...(typeof o.message === 'string' ? { message: o.message } : {}),
      };
    }
    e = o.meta?.driverAdapterError ?? o.cause;
  }
  return undefined;
};

/** Whether a failed write may succeed later. */
export const isTransientStorageError = (err: unknown): boolean => {
  const s = storageErrorOf(err);
  if (!s) return false;
  if (s.kind === 'SocketTimeout') return true; // busy
  return s.code !== undefined && TRANSIENT_CODES.has(s.code & 0xff);
};

const describeError = (err: unknown): string => {
  const s = storageErrorOf(err);
  if (s?.message) return s.message;
  if (s?.kind) return s.kind;
  // Prisma's messages start with where the call came from; the reason is on the last line.
  return (errorMessage(err).trim().split('\n').at(-1) ?? '').trim() || errorMessage(err);
};

/**
 * Wraps a store so that it never rejects and writes in call order, and so that a storage outage (disk full,
 * I/O error, locked) loses nothing while the process runs: a write that fails for such a reason is kept, with
 * a copy of its arguments, and replayed in order before the next write. Once storage works again, the
 * database catches up with everything that happened meanwhile (cooldowns and daily caps would otherwise
 * under-count after a restart). A write that fails for good (a constraint, a bug) is logged and skipped, so it
 * can't block the rest. Replays are in memory: a restart during an outage loses what wasn't written.
 *
 * Like ConnectionHealth, it audits transitions only: one `state.save_failed` when saving starts failing,
 * one `state.save_restored` when everything is written again.
 */
export const guardStore = (store: ConductorStore, audit: AuditSink, now: () => Date = () => new Date()): ConductorStore => {
  const backlog: { method: keyof ConductorStore; args: unknown[] }[] = [];
  let outage: { since: Date; failures: number; lastError: string } | undefined;
  let queue: Promise<void> = Promise.resolve();

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

  const apply = (method: keyof ConductorStore, args: unknown[]): Promise<void> => (store[method] as (...a: unknown[]) => Promise<void>)(...args);

  /** Writes the backlog in order; stops at a failure that may clear up. True if everything is written. */
  const drain = async (): Promise<boolean> => {
    while (backlog.length > 0) {
      const op = backlog[0];
      if (!op) break;
      try {
        await apply(op.method, op.args);
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

  const write = async (method: keyof ConductorStore, args: unknown[]): Promise<void> => {
    if (backlog.length === 0) {
      try {
        await apply(method, args);
        restored();
      } catch (err) {
        if (!isTransientStorageError(err)) {
          failed(method, err, false);
          return;
        }
        failed(method, err, true);
        backlog.push({ method, args });
      }
      return;
    }
    backlog.push({ method, args });
    if (backlog.length > MAX_BACKLOG) {
      const dropped = backlog.shift();
      log.error(`Storage outage: dropped the oldest unsaved ${dropped?.method ?? 'write'} (more than ${MAX_BACKLOG} waiting)`);
    }
    if (await drain()) restored();
  };

  const guarded = {} as Record<keyof ConductorStore, (...args: unknown[]) => Promise<void>>;
  for (const method of METHODS) {
    guarded[method] = (...args: unknown[]) => {
      // Copy the arguments now: the caller goes on changing its objects (the sequence moves on), and a write
      // may wait behind others or be replayed later.
      const copy = structuredClone(args);
      const done = queue.then(() => write(method, copy));
      queue = done.catch(() => {});
      return done;
    };
  }
  return guarded as unknown as ConductorStore;
};
