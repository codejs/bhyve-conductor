import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog, parseAudit, readAudit, toJsonData } from '../../audit/audit.ts';
import { ConnectionHealth } from '../../audit/health.ts';
import { log } from '../../log.ts';

describe('readAudit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-audit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a JSON Lines trail (simulations, versions before the database)', async () => {
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '{"ts":"2026-06-30T00:00:00.000Z","type":"service.started"}\n{"ts":"2026-06-30T01:00:00.000Z","type":"service.stopped","reason":"SIGTERM"}\n');

    expect(await readAudit(path)).toEqual({
      events: [
        { ts: '2026-06-30T00:00:00.000Z', type: 'service.started' },
        { ts: '2026-06-30T01:00:00.000Z', type: 'service.stopped', reason: 'SIGTERM' },
      ],
      skipped: 0,
    });
  });

  it('has no events when there is no file, and fails on anything else it cannot read', async () => {
    await expect(readAudit(join(dir, 'none.jsonl'))).resolves.toEqual({ events: [], skipped: 0 });
    await expect(readAudit(dir)).rejects.toThrow(); // a directory
  });
});

describe('toJsonData', () => {
  it('keeps error messages and dates readable, and nothing but JSON', () => {
    expect(toJsonData({ error: new Error('boom'), at: new Date('2026-07-01T00:00:00Z'), n: 1, skip: undefined, nested: { ok: true } })).toEqual({
      error: 'boom',
      at: '2026-07-01T00:00:00.000Z',
      n: 1,
      nested: { ok: true },
    });
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
