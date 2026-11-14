import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { PendingSequence } from '../../conductor/state.ts';
import { guardStore, isTransientStorageError, MAX_BACKLOG, noStore, type ConductorStore } from '../../conductor/store.ts';
import { log } from '../../log.ts';
import { NOW } from '../utils/conductor.ts';

/** An error like node:sqlite throws it (errcode = SQLite's extended result code). */
const sqliteError = (message: string, errcode: number): Error => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
/** As drizzle throws it: the driver's error is the cause. */
const wrapped = (cause: Error): Error => new Error('Failed query: insert into ...', { cause });

const DISK_FULL = 13;
const IO_ERROR_WRITE = 778; // SQLITE_IOERR_WRITE
const CONSTRAINT_UNIQUE = 2067;

/** A store that records its calls and fails while `failWith` is set. */
const recorder = () => {
  const calls: [string, unknown[]][] = [];
  let failWith: Error | undefined;
  const store = Object.fromEntries(
    (Object.keys(noStore) as (keyof ConductorStore)[]).map((m) => [
      m,
      (...args: unknown[]) => {
        if (failWith) throw failWith;
        calls.push([m, structuredClone(args)]);
      },
    ]),
  ) as unknown as ConductorStore;
  return {
    store,
    calls,
    fail: (err: Error | undefined) => {
      failWith = err;
    },
  };
};

const seq = (): PendingSequence => ({
  id: 'seq1',
  deviceId: 'dev1',
  waves: [[{ station: 1, runTime: 10 }]],
  soakMinutes: 0,
  createdAt: NOW,
  nextWave: 0,
  dueAt: NOW,
  attempts: 0,
});

describe('isTransientStorageError', () => {
  it.each([
    ['disk full', sqliteError('database or disk is full', DISK_FULL), true],
    ['an I/O error (extended code)', sqliteError('disk I/O error', IO_ERROR_WRITE), true],
    ['busy', sqliteError('database is locked', 5), true],
    ['read-only', sqliteError('attempt to write a readonly database', 8), true],
    ['a constraint', sqliteError('UNIQUE constraint failed', CONSTRAINT_UNIQUE), false],
    ['a plain error (e.g. "no matching row")', new Error('recording seq1 cycle 1 as delivered: no matching row'), false],
    ['not an error', 'disk full', false],
  ])('%s → %s', (_, err, expected) => {
    expect(isTransientStorageError(err)).toBe(expected);
    if (err instanceof Error) expect(isTransientStorageError(wrapped(err))).toBe(expected);
  });
});

describe('guardStore', () => {
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes every call through while storage works, and audits nothing', () => {
    const r = recorder();
    const audit = new MemoryAuditLog(() => NOW);
    const g = guardStore(r.store, audit, () => NOW);

    g.sequenceStarted(seq(), []);
    g.waveSending(seq(), 0, NOW);
    g.saveAlerts({});

    expect(r.calls.map(([m]) => m)).toEqual(['sequenceStarted', 'waveSending', 'saveAlerts']);
    expect(audit.events).toEqual([]);
  });

  it('never throws, and replays what failed in order, with the arguments as they were, once storage is back', () => {
    const r = recorder();
    const audit = new MemoryAuditLog(() => NOW);
    let now = NOW;
    const g = guardStore(r.store, audit, () => now);
    const s = seq();

    r.fail(wrapped(sqliteError('database or disk is full', DISK_FULL)));
    expect(() => g.sequenceStarted(s, [])).not.toThrow();
    s.nextWave = 1; // the caller moves on while the write is pending
    g.waveSending(s, 0, NOW);
    g.recordReadings([], NOW);
    expect(r.calls).toEqual([]);

    r.fail(undefined);
    now = new Date(NOW.getTime() + 30 * 60_000);
    g.saveAlerts({ 'device:d': { state: 'offline', since: NOW.toISOString() } });

    expect(r.calls.map(([m]) => m)).toEqual(['sequenceStarted', 'waveSending', 'recordReadings', 'saveAlerts']);
    expect((r.calls[0]?.[1][0] as PendingSequence).nextWave).toBe(0); // as it was when the write was made
    expect(audit.events.map((e) => e.type)).toEqual(['state.save_failed', 'state.save_restored']);
    expect(audit.events[0]).toMatchObject({ step: 'sequenceStarted', error: 'database or disk is full' });
    expect(audit.events[1]).toMatchObject({ failures: 3, outageMinutes: 30, lastError: 'database or disk is full' });
    expect(error).toHaveBeenCalledOnce(); // one log line per outage, not per write
  });

  it('skips a write that can never succeed, without holding up the ones after it', () => {
    const r = recorder();
    const audit = new MemoryAuditLog(() => NOW);
    const g = guardStore(r.store, audit, () => NOW);

    r.fail(sqliteError('UNIQUE constraint failed: watering_sequence.device_id', CONSTRAINT_UNIQUE));
    g.sequenceStarted(seq(), []);
    r.fail(undefined);
    g.waveSending(seq(), 0, NOW);

    expect(r.calls.map(([m]) => m)).toEqual(['waveSending']); // the failed one is not retried
    expect(audit.events.map((e) => e.type)).toEqual(['state.save_failed', 'state.save_restored']);
    expect(audit.events[0]).toMatchObject({ step: 'sequenceStarted', error: expect.stringContaining('UNIQUE') });
  });

  it('drops a write found in the backlog that now fails for good, and carries on with the rest', () => {
    const r = recorder();
    const audit = new MemoryAuditLog(() => NOW);
    let attempts = 0;
    const store: ConductorStore = {
      ...r.store,
      waveFailed: () => {
        attempts++;
        // First the disk hiccups; on replay the row turns out to be gone (e.g. the sequence was purged).
        throw attempts === 1 ? sqliteError('disk I/O error', IO_ERROR_WRITE) : new Error('no matching row');
      },
    };
    const g = guardStore(store, audit, () => NOW);

    g.waveFailed(seq(), 0); // transient: kept for replay
    g.waveSending(seq(), 0, NOW); // replays waveFailed (now permanent: dropped), then this one

    expect(attempts).toBe(2);
    expect(r.calls.map(([m]) => m)).toEqual(['waveSending']);
    expect(audit.events.map((e) => e.type)).toEqual(['state.save_failed', 'state.save_restored']);
    expect(audit.events[1]).toMatchObject({ failures: 2, lastError: 'no matching row' });
  });

  it('keeps at most MAX_BACKLOG writes, dropping the oldest', () => {
    const r = recorder();
    const g = guardStore(r.store, new MemoryAuditLog(() => NOW), () => NOW);

    r.fail(sqliteError('database or disk is full', DISK_FULL));
    for (let i = 0; i < MAX_BACKLOG + 5; i++) g.waveSending(seq(), i, NOW);
    r.fail(undefined);
    g.saveAlerts({});

    // The backlog never holds more than MAX_BACKLOG: the write that ended the outage pushed out one more.
    expect(r.calls).toHaveLength(MAX_BACKLOG);
    expect(r.calls[0]?.[1][1]).toBe(6);
    expect(r.calls.at(-1)?.[0]).toBe('saveAlerts');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dropped the oldest unsaved waveSending'));
  });

  it('reports a new outage after a recovery', () => {
    const r = recorder();
    const audit = new MemoryAuditLog(() => NOW);
    const g = guardStore(r.store, audit, () => NOW);

    for (let round = 0; round < 2; round++) {
      r.fail(sqliteError('database or disk is full', DISK_FULL));
      g.saveAlerts({});
      r.fail(undefined);
      g.saveAlerts({});
    }

    expect(audit.events.map((e) => e.type)).toEqual(['state.save_failed', 'state.save_restored', 'state.save_failed', 'state.save_restored']);
  });
});

describe('noStore', () => {
  it('accepts every step and keeps nothing', () => {
    for (const m of Object.keys(noStore) as (keyof ConductorStore)[]) {
      expect(() => (noStore[m] as (...a: unknown[]) => void)()).not.toThrow();
    }
  });
});
