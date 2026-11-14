import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastAuditEventOf, queryAuditEvents, readAuditSource, SqliteAuditLog } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { auditEvent } from '../../db/schema.ts';
import { log } from '../../log.ts';

const T0 = new Date('2026-07-01T11:00:00.000Z');
const T = (min: number): Date => new Date(T0.getTime() + min * 60_000);

describe('SqliteAuditLog', () => {
  let db: ConductorDb;
  let now: Date;
  let audit: SqliteAuditLog;

  beforeEach(() => {
    db = openDatabase(':memory:');
    now = T0;
    audit = new SqliteAuditLog(db, { now: () => now });
  });

  afterEach(() => {
    if (db.$client.isOpen) db.$client.close();
  });

  it('stores events in order, with their time and data, in the JSONL event shape', () => {
    audit.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });
    now = T(1);
    audit.record('wave.sent', { sequence: 'abc', device: 'dev1', stations: [{ station: 1, runTime: 10 }] });
    audit.record('service.stopped');

    expect(queryAuditEvents(db)).toEqual([
      { ts: T0.toISOString(), type: 'service.started', mode: 'continuous', dryRun: false, zones: 2 },
      { ts: T(1).toISOString(), type: 'wave.sent', sequence: 'abc', device: 'dev1', stations: [{ station: 1, runTime: 10 }] },
      { ts: T(1).toISOString(), type: 'service.stopped' },
    ]);
  });

  it('keeps errors and dates readable', () => {
    audit.record('poll.failed', { error: new Error('boom'), at: T(5) });

    expect(queryAuditEvents(db)).toEqual([{ ts: T0.toISOString(), type: 'poll.failed', error: 'boom', at: T(5).toISOString() }]);
  });

  it('tags events with the service run', () => {
    const run = db.$client.prepare(`INSERT INTO service_run (started_at, mode, dry_run, config_hash, config_json, heartbeat_at) VALUES (?, 'once', 1, 'h', '{}', ?)`).run(T0.toISOString(), T0.toISOString());
    const runId = Number(run.lastInsertRowid);
    new SqliteAuditLog(db, { now: () => now, serviceRunId: runId }).record('service.started');
    audit.record('simulation.note', { note: 'no run' });

    expect(db.select({ type: auditEvent.type, run: auditEvent.serviceRunId }).from(auditEvent).all()).toEqual([
      { type: 'service.started', run: runId },
      { type: 'simulation.note', run: null },
    ]);
    expect(queryAuditEvents(db, { serviceRunId: runId }).map((e) => e.type)).toEqual(['service.started']);
  });

  it('logs but never throws when the database cannot be written', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    db.$client.close();

    expect(() => audit.record('service.started')).not.toThrow();
    expect(error).toHaveBeenCalledWith('Could not write audit event service.started to the database', expect.anything());
  });
});

describe('queryAuditEvents / lastAuditEventOf', () => {
  let db: ConductorDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const at = (min: number) => ({ now: () => T(min) });
    new SqliteAuditLog(db, at(0)).record('sequence.started', { sequence: '3f9a1c2e-0000-4000-8000-000000000001' });
    new SqliteAuditLog(db, at(10)).record('wave.sent', { sequence: '3f9a1c2e-0000-4000-8000-000000000001' });
    new SqliteAuditLog(db, at(20)).record('wave.sent', { sequence: '77aa0000-0000-4000-8000-000000000002' });
    new SqliteAuditLog(db, at(30)).record('simulation.note', { note: 'the power fails' });
  });

  afterEach(() => {
    db.$client.close();
  });

  it('filters by time (inclusive), sequence id or its beginning, and type', () => {
    expect(queryAuditEvents(db, { since: T(10), until: T(20) }).map((e) => e.ts)).toEqual([T(10).toISOString(), T(20).toISOString()]);
    expect(queryAuditEvents(db, { sequence: '3f9a1c2e' }).map((e) => e.type)).toEqual(['sequence.started', 'wave.sent']);
    expect(queryAuditEvents(db, { sequence: '3f9a1c2e-0000-4000-8000-000000000001' })).toHaveLength(2);
    expect(queryAuditEvents(db, { sequence: '77' })).toHaveLength(1);
    expect(queryAuditEvents(db, { excludeTypes: ['wave.sent', 'simulation.note'] }).map((e) => e.type)).toEqual(['sequence.started']);
  });

  it('finds the most recent matching event', () => {
    expect(lastAuditEventOf(db)?.type).toBe('simulation.note');
    expect(lastAuditEventOf(db, { excludeTypes: ['simulation.note'] })).toEqual({
      ts: T(20).toISOString(),
      type: 'wave.sent',
      sequence: '77aa0000-0000-4000-8000-000000000002',
    });
    expect(lastAuditEventOf(db, { since: T(31) })).toBeUndefined();
  });
});

describe('readAuditSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-audit-source-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the database read-only, next to a connection that keeps writing', async () => {
    const path = join(dir, 'conductor.db');
    const service = openDatabase(path);
    const audit = new SqliteAuditLog(service, { now: () => T0 });
    audit.record('service.started');
    audit.record('wave.sent', { sequence: 'abc123' });

    const { events, skipped } = await readAuditSource(path, { sequence: 'abc' });
    audit.record('service.stopped'); // the service is unaffected

    expect(skipped).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['wave.sent']);
    expect(queryAuditEvents(service)).toHaveLength(3);
    service.$client.close();
  });

  it('reads a JSON Lines trail, counting lines it cannot read', async () => {
    const path = join(dir, 'sim.audit.jsonl');
    await writeFile(path, '{"ts":"2026-07-01T11:00:00.000Z","type":"service.started"}\n{"ts":"2026-07-01T11:0');

    expect(await readAuditSource(path)).toEqual({ events: [{ ts: '2026-07-01T11:00:00.000Z', type: 'service.started' }], skipped: 1 });
  });

  it('explains a database that does not exist yet', async () => {
    await expect(readAuditSource(join(dir, 'none.db'))).rejects.toThrow(/does not exist yet/);
  });
});
