import { describe, expect, it } from 'vitest';
import { teeAudit, MemoryAuditLog, type AuditSink } from '../audit/audit.ts';
import { VirtualClock } from '../clock.ts';

describe('VirtualClock', () => {
  it('runs timers in time order, at their own time, including ones scheduled while advancing', async () => {
    const clock = new VirtualClock(new Date('2026-07-01T00:00:00Z'));
    const seen: string[] = [];
    clock.setTimeout(() => seen.push(`b@${clock.now().toISOString().slice(11, 19)}`), 2000);
    clock.setTimeout(() => {
      seen.push(`a@${clock.now().toISOString().slice(11, 19)}`);
      clock.setTimeout(() => seen.push(`c@${clock.now().toISOString().slice(11, 19)}`), 500);
    }, 1000);
    const cancelled = clock.setTimeout(() => seen.push('never'), 1500);
    clock.clearTimeout(cancelled);

    await clock.advanceBy(10_000);

    expect(seen).toEqual(['a@00:00:01', 'c@00:00:01', 'b@00:00:02']);
    expect(clock.now().toISOString()).toBe('2026-07-01T00:00:10.000Z');
    expect(clock.pendingTimers).toBe(0);
  });

  it('lets promise chains started by a timer finish before the next timer', async () => {
    const clock = new VirtualClock(new Date(0));
    const seen: string[] = [];
    clock.setTimeout(() => {
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        seen.push('chain done');
      })();
    }, 10);
    clock.setTimeout(() => seen.push('next timer'), 20);

    await clock.advanceBy(100);

    expect(seen).toEqual(['chain done', 'next timer']);
  });
});

describe('teeAudit', () => {
  it('sends each event to every sink, even if one throws', () => {
    const a = new MemoryAuditLog();
    const broken: AuditSink = {
      record: () => {
        throw new Error('boom');
      },
    };
    const b = new MemoryAuditLog();

    teeAudit(a, broken, b).record('service.started', { zones: 1 });

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });
});
