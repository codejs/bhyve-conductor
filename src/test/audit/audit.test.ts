import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileAuditLog, lastAuditEvent, MemoryAuditLog, parseAudit, readAudit } from '../../audit/audit.ts';
import { ConnectionHealth } from '../../audit/health.ts';
import { log } from '../../log.ts';

describe('FileAuditLog', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-audit-'));
    path = join(dir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per event, in order, with a timestamp', async () => {
    const audit = new FileAuditLog(path, () => new Date('2026-07-01T12:00:00Z'));

    for (let i = 0; i < 20; i++) audit.record('wave.sent', { cycle: i });
    await audit.flush();

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ ts: '2026-07-01T12:00:00.000Z', type: 'wave.sent', cycle: 0 });
    expect(lines.map((l) => (JSON.parse(l) as { cycle: number }).cycle)).toEqual([...Array(20).keys()]);
  });

  it('keeps existing events (append-only)', async () => {
    await writeFile(path, '{"ts":"2026-06-30T00:00:00.000Z","type":"service.started"}\n');
    const audit = new FileAuditLog(path);

    audit.record('service.stopped', { reason: 'SIGTERM' });
    await audit.flush();

    expect((await readAudit(path)).events.map((e) => e.type)).toEqual(['service.started', 'service.stopped']);
  });

  it('stores error messages and dates readably', async () => {
    const audit = new FileAuditLog(path);
    audit.record('poll.failed', { error: new Error('boom'), at: new Date('2026-07-01T00:00:00Z') });
    await audit.flush();

    expect((await readAudit(path)).events[0]).toMatchObject({ error: 'boom', at: '2026-07-01T00:00:00.000Z' });
  });

  it('logs but never throws when the file cannot be written', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const audit = new FileAuditLog(join(dir, 'missing-dir', 'audit.jsonl'));

    expect(() => audit.record('service.started')).not.toThrow();
    await audit.flush();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not write audit event service.started'), expect.anything());
    // ...and keeps working afterwards
    const ok = new FileAuditLog(path);
    ok.record('service.started');
    await ok.flush();
    expect((await readAudit(path)).events).toHaveLength(1);
  });

  it('finds the last event from the tail of a large file', async () => {
    const filler = `${JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', type: 'wave.sent', pad: 'x'.repeat(200) })}\n`.repeat(1000);
    await writeFile(path, filler);
    await appendFile(path, '{"ts":"2026-07-02T00:00:00.000Z","type":"service.stopped"}\n');

    await expect(lastAuditEvent(path, 4096)).resolves.toMatchObject({ type: 'service.stopped' });
  });

  it('has no last event when there is no file', async () => {
    await expect(lastAuditEvent(join(dir, 'none.jsonl'))).resolves.toBeUndefined();
    await expect(readAudit(join(dir, 'none.jsonl'))).resolves.toEqual({ events: [], skipped: 0 });
  });
});

describe('parseAudit', () => {
  it('skips torn or foreign lines (e.g. cut short by a crash) and counts them', () => {
    const text = [
      '{"ts":"2026-07-01T00:00:00.000Z","type":"service.started"}',
      '{"ts":"2026-07-01T00:01:00.000Z","type":"wave.se', // torn
      '',
      '{"not":"an event"}',
      '{"ts":"2026-07-01T00:02:00.000Z","type":"service.stopped"}',
    ].join('\n');

    const { events, skipped } = parseAudit(text);

    expect(events.map((e) => e.type)).toEqual(['service.started', 'service.stopped']);
    expect(skipped).toBe(2);
  });
});

describe('MemoryAuditLog', () => {
  it('records events with timestamps and filters by type', () => {
    const audit = new MemoryAuditLog(() => new Date('2026-07-01T12:00:00Z'));
    audit.record('connection.lost', { service: 'tuya', error: new Error('down') });
    audit.record('connection.restored', { service: 'tuya' });

    expect(audit.ofType('connection.lost')).toEqual([
      { ts: '2026-07-01T12:00:00.000Z', type: 'connection.lost', service: 'tuya', error: 'down' },
    ]);
  });
});

describe('ConnectionHealth', () => {
  let now: Date;
  let audit: MemoryAuditLog;
  let health: ConnectionHealth;

  beforeEach(() => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    now = new Date('2026-07-01T12:00:00Z');
    audit = new MemoryAuditLog(() => now);
    health = new ConnectionHealth(audit, () => now);
  });

  it('records nothing while everything works', () => {
    health.ok('tuya');
    health.ok('bhyve');

    expect(audit.events).toEqual([]);
  });

  it('records one loss and one restoration per outage, with its length and failure count', () => {
    health.failed('tuya', new Error('timed out after 20s'));
    now = new Date('2026-07-01T12:15:00Z');
    health.failed('tuya', new Error('HTTP 502'));
    health.failed('tuya', new Error('HTTP 503'));
    now = new Date('2026-07-01T12:45:30Z');
    health.ok('tuya');
    health.ok('tuya');

    expect(audit.events).toEqual([
      { ts: '2026-07-01T12:00:00.000Z', type: 'connection.lost', service: 'tuya', error: 'timed out after 20s' },
      {
        ts: '2026-07-01T12:45:30.000Z',
        type: 'connection.restored',
        service: 'tuya',
        downSince: '2026-07-01T12:00:00.000Z',
        outageMinutes: 45.5,
        failures: 3,
        lastError: 'HTTP 503',
      },
    ]);
  });

  it('tracks services independently', () => {
    health.failed('bhyve-commands', new Error('socket'));
    health.ok('bhyve');

    expect(health.isDown('bhyve-commands')).toBe(true);
    expect(health.isDown('bhyve')).toBe(false);
    expect(audit.events.map((e) => e.type)).toEqual(['connection.lost']);
  });
});
