import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterValue, lastAuditEventOf, queryAuditEvents, readAuditSource, SqliteAuditLog } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
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

  afterEach(async () => {
    await db.close();
  });

  it('stores events in the order they are recorded, with their time and data, in the JSONL event shape', async () => {
    audit.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });
    now = T(1);
    audit.record('wave.sent', { sequence: 'abc', device: 'dev1', stations: [{ station: 1, runTime: 10 }] });
    audit.record('service.stopped');
    await audit.flush();

    expect(await queryAuditEvents(db)).toEqual([
      { ts: T0.toISOString(), type: 'service.started', mode: 'continuous', dryRun: false, zones: 2 },
      { ts: T(1).toISOString(), type: 'wave.sent', sequence: 'abc', device: 'dev1', stations: [{ station: 1, runTime: 10 }] },
      { ts: T(1).toISOString(), type: 'service.stopped' },
    ]);
  });

  it('takes the time and the data when the event is recorded, not when it is written', async () => {
    const data = { reason: 'first' };
    audit.record('service.stopped', data);
    data.reason = 'changed afterwards';
    now = T(5);
    await audit.flush();

    expect(await queryAuditEvents(db)).toEqual([{ ts: T0.toISOString(), type: 'service.stopped', reason: 'first' }]);
  });

  it('keeps errors and dates readable', async () => {
    audit.record('poll.failed', { error: new Error('boom'), at: T(5) });
    await audit.flush();

    expect(await queryAuditEvents(db)).toEqual([{ ts: T0.toISOString(), type: 'poll.failed', error: 'boom', at: T(5).toISOString() }]);
  });

  it('fills the filter columns from the payload, as text', async () => {
    audit.record('wave.sent', { sequence: 's1', device: 12345, zone: ['not', 'a', 'string'] });
    audit.record('service.stopped');
    await audit.flush();

    expect(await db.prisma.auditEvent.findMany({ orderBy: { id: 'asc' }, select: { deviceId: true, zoneKey: true, sequenceId: true } })).toEqual([
      { deviceId: '12345', zoneKey: '["not","a","string"]', sequenceId: 's1' },
      { deviceId: null, zoneKey: null, sequenceId: null },
    ]);
  });

  it('tags events with the service run', async () => {
    const run = await db.prisma.serviceRun.create({ data: { startedAt: T0, mode: 'once', dryRun: true, configHash: 'h', config: {}, heartbeatAt: T0 }, select: { id: true } });
    const tagged = new SqliteAuditLog(db, { now: () => now, serviceRunId: run.id });
    tagged.record('service.started');
    audit.record('simulation.note', { note: 'no run' });
    await Promise.all([tagged.flush(), audit.flush()]);

    expect(await db.prisma.auditEvent.findMany({ orderBy: { id: 'asc' }, select: { type: true, serviceRunId: true } })).toEqual([
      { type: 'service.started', serviceRunId: run.id },
      { type: 'simulation.note', serviceRunId: null },
    ]);
    expect((await queryAuditEvents(db, { serviceRunId: run.id })).map((e) => e.type)).toEqual(['service.started']);
  });

  it('logs but never throws when the database cannot be written, and keeps going', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    db.sqlite.exec('PRAGMA query_only = ON');

    expect(() => audit.record('service.started')).not.toThrow();
    await audit.flush();
    expect(error).toHaveBeenCalledWith('Could not write audit event service.started to the database', expect.anything());

    db.sqlite.exec('PRAGMA query_only = OFF');
    audit.record('service.stopped');
    await audit.flush();
    expect((await queryAuditEvents(db)).map((e) => e.type)).toEqual(['service.stopped']);
  });

  it('logs an event it cannot even serialize, and records the next one', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    audit.record('poll.failed', circular);
    audit.record('service.stopped');
    await audit.flush();

    expect(error).toHaveBeenCalledWith('Could not record audit event poll.failed', expect.any(TypeError));
    expect((await queryAuditEvents(db)).map((e) => e.type)).toEqual(['service.stopped']);
  });
});

describe('filterValue', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['dev1', 'dev1'],
    [12345, '12345'],
    [true, 'true'],
    [{ a: 1 }, '{"a":1}'],
  ])('%o → %o', (value, expected) => expect(filterValue(value)).toBe(expected));
});

describe('queryAuditEvents / lastAuditEventOf', () => {
  let db: ConductorDb;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    let now = T(0);
    const audit = new SqliteAuditLog(db, { now: () => now });
    audit.record('sequence.started', { sequence: '3f9a1c2e-0000-4000-8000-000000000001' });
    now = T(10);
    audit.record('wave.sent', { sequence: '3f9a1c2e-0000-4000-8000-000000000001' });
    now = T(20);
    audit.record('wave.sent', { sequence: '77aa0000-0000-4000-8000-000000000002' });
    now = T(30);
    audit.record('simulation.note', { note: 'the power fails' });
    await audit.flush();
  });

  afterEach(async () => {
    await db.close();
  });

  it('filters by time (inclusive), sequence id or its beginning, and type', async () => {
    expect((await queryAuditEvents(db, { since: T(10), until: T(20) })).map((e) => e.ts)).toEqual([T(10).toISOString(), T(20).toISOString()]);
    expect((await queryAuditEvents(db, { sequence: '3f9a1c2e' })).map((e) => e.type)).toEqual(['sequence.started', 'wave.sent']);
    expect(await queryAuditEvents(db, { sequence: '3f9a1c2e-0000-4000-8000-000000000001' })).toHaveLength(2);
    expect(await queryAuditEvents(db, { sequence: '77' })).toHaveLength(1);
    expect((await queryAuditEvents(db, { excludeTypes: ['wave.sent', 'simulation.note'] })).map((e) => e.type)).toEqual(['sequence.started']);
  });

  it('finds the most recent matching event', async () => {
    expect((await lastAuditEventOf(db))?.type).toBe('simulation.note');
    expect(await lastAuditEventOf(db, { excludeTypes: ['simulation.note'] })).toEqual({
      ts: T(20).toISOString(),
      type: 'wave.sent',
      sequence: '77aa0000-0000-4000-8000-000000000002',
    });
    expect(await lastAuditEventOf(db, { since: T(31) })).toBeUndefined();
  });
});

describe('readAuditSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-audit-source-'));
    vi.spyOn(log, 'info').mockImplementation(() => {});
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
    await audit.flush();

    const { events, skipped } = await readAuditSource(path, { sequence: 'abc' });
    audit.record('service.stopped'); // the service is unaffected
    await audit.flush();

    expect(skipped).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['wave.sent']);
    expect(await queryAuditEvents(service)).toHaveLength(3);
    await service.close();
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
