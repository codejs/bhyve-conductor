import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import { SqliteAuditLog } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { beginServiceRun, configHash, endServiceRun, recordHeartbeat } from '../../db/service-run.ts';
import { beginSession } from '../../db/session.ts';
import { log } from '../../log.ts';
import { zone } from '../utils/conductor.ts';

const T0 = new Date('2026-07-01T11:00:00.000Z');
const T = (min: number): Date => new Date(T0.getTime() + min * 60_000);

const config = (overrides: Partial<ConductorConfig> = {}): ConductorConfig => ({
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones: [zone({ name: 'Front' }), zone({ station: 2, name: 'Back', cooldownMinutes: 600 })],
  ...overrides,
});

const start = (db: ConductorDb, at: Date, dryRun = false) => beginServiceRun(db, { startedAt: at, mode: 'continuous', dryRun, config: { dryRun } });
const runs = (db: ConductorDb) =>
  db.prisma.serviceRun.findMany({ orderBy: { id: 'asc' }, select: { id: true, dryRun: true, stoppedAt: true, stopReason: true } });

describe('service runs', () => {
  let db: ConductorDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(async () => {
    await db.close();
  });

  it('records a run with its mode, process and effective configuration', async () => {
    const cfg = config();
    const { runId, unclean } = await beginServiceRun(db, { startedAt: T0, mode: 'once', dryRun: true, config: cfg, pid: 4242 });

    expect(unclean).toBeUndefined();
    expect(await db.prisma.serviceRun.findFirst()).toEqual({
      id: runId,
      startedAt: T0,
      mode: 'once',
      dryRun: true,
      pid: 4242,
      configHash: configHash(cfg),
      config: JSON.parse(JSON.stringify(cfg)),
      heartbeatAt: T0,
      stoppedAt: null,
      stopReason: null,
    });
    expect(configHash(cfg)).toBe(configHash(config())); // stable for the same configuration
    expect(configHash(cfg)).not.toBe(configHash(config({ pollIntervalMinutes: 5 })));
  });

  it('reports nothing after a clean stop', async () => {
    const first = await start(db, T0);
    await recordHeartbeat(db, first.runId, T(15));
    await endServiceRun(db, first.runId, T(20), 'SIGTERM');

    expect((await start(db, T(30))).unclean).toBeUndefined();
    expect((await runs(db))[0]).toMatchObject({ stoppedAt: T(20), stopReason: 'SIGTERM' });
  });

  it('closes and reports a run that never stopped, with its last activity', async () => {
    const first = await start(db, T0);
    const audit = new SqliteAuditLog(db, { now: () => T(28), serviceRunId: first.runId });
    audit.record('wave.confirmed', { sequence: 's' });
    const notes = new SqliteAuditLog(db, { now: () => T(35), serviceRunId: first.runId });
    notes.record('simulation.note', { note: 'killed' });
    await Promise.all([audit.flush(), notes.flush()]);
    await recordHeartbeat(db, first.runId, T(30));

    const second = await start(db, T(50));

    expect(second.unclean).toEqual({ runId: first.runId, lastEvent: 'wave.confirmed', lastEventAt: T(28).toISOString() });
    expect(await runs(db)).toEqual([
      { id: first.runId, dryRun: false, stoppedAt: T(30), stopReason: 'unclean' }, // died after its last heartbeat
      { id: second.runId, dryRun: false, stoppedAt: null, stopReason: null },
    ]);
    expect((await start(db, T(60))).unclean?.runId).toBe(second.runId); // each crash is reported once
  });

  it('falls back to the heartbeat when the crashed run recorded no events', async () => {
    const first = await start(db, T0);
    await recordHeartbeat(db, first.runId, T(45));

    expect((await start(db, T(50))).unclean).toEqual({ runId: first.runId, lastEvent: 'service.started', lastEventAt: T(45).toISOString() });
  });

  it('reports the latest real run among several unfinished ones, and closes the rest quietly', async () => {
    const a = await start(db, T0);
    const b = await start(db, T(10)); // (a second instance: its start closed a)
    const dry = await start(db, T(20), true); // a conductor:check that was killed

    const next = await start(db, T(30));

    expect(next.unclean?.runId).toBe(b.runId);
    expect((await runs(db)).map((r) => [r.id, r.stopReason])).toEqual([
      [a.runId, 'unclean'],
      [b.runId, 'unclean'],
      [dry.runId, 'unclean'],
      [next.runId, null],
    ]);
  });

  it('a dry run leaves the live service alone (it may run next to it)', async () => {
    const live = await start(db, T0);

    const check = await start(db, T(5), true);

    expect(check.unclean).toBeUndefined();
    expect((await runs(db)).find((r) => r.id === live.runId)?.stoppedAt).toBeNull();
  });
});

describe('beginSession', () => {
  let db: ConductorDb;
  let now: Date;

  beforeEach(() => {
    db = openDatabase(':memory:');
    now = T0;
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await db.close();
  });

  const session = (cfg = config(), extra: Partial<Parameters<typeof beginSession>[1]> = {}) =>
    beginSession(db, { config: cfg, mode: 'continuous', now: () => now, ...extra });

  it('records the run, registers the zones, and opens an audit trail tagged with the run', async () => {
    const s = await session();
    s.audit.record('service.started');
    await s.audit.flush();

    expect(await db.prisma.zone.findMany({ orderBy: { zoneKey: 'asc' }, select: { zoneKey: true, name: true } })).toEqual([
      { zoneKey: 'dev1:1', name: 'Front' },
      { zoneKey: 'dev1:2', name: 'Back' },
    ]);
    expect(await db.prisma.auditEvent.findFirst({ select: { serviceRunId: true } })).toEqual({ serviceRunId: s.runId });
    expect(s.state).toEqual({ history: [], sequences: [], alerts: {}, zoneSpells: [] });
  });

  it('loads what the previous run left, with history going back the longest cooldown', async () => {
    const first = await session();
    const left = { id: 'left', deviceId: 'dev1', waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]], soakMinutes: 30, createdAt: T0, nextWave: 0, dueAt: T0, attempts: 0 };
    await first.store.sequenceStarted(left, []);
    await first.store.waveDelivered(left, 0, 'event', T0, T(40));
    await first.end('SIGTERM');

    now = T(24 * 60 + 5); // over 24 h later: neither the 600-minute cooldown nor the 24 h cap needs that run
    const second = await session();

    expect(second.state.sequences).toEqual([expect.objectContaining({ id: 'left', nextWave: 1, dueAt: T(40) })]);
    expect(second.state.history).toEqual([]);
    now = T(20 * 60);
    expect((await session()).state.history).toEqual([{ zoneKey: 'dev1:1', at: T0, minutes: 10 }]);
  });

  it('reports a crash of the previous run', async () => {
    await session(); // never ended
    now = T(30);

    expect((await session()).unclean).toEqual({ lastEvent: 'service.started', lastEventAt: T0.toISOString() });
  });

  it('reports a crash of the version before the database, found in its imported trail', async () => {
    const crashed = await session({ ...config() }, { legacyLastEvent: { ts: T(-5).toISOString(), type: 'wave.sent' } });
    expect(crashed.unclean).toEqual({ lastEvent: 'wave.sent', lastEventAt: T(-5).toISOString() });
    await crashed.end('x');

    const clean = await session(config(), { legacyLastEvent: { ts: T(-5).toISOString(), type: 'service.stopped' } });
    expect(clean.unclean).toBeUndefined();
  });

  it('keeps the heartbeat and records a clean end after the audit trail is written', async () => {
    const s = await session();
    now = T(15);
    await s.heartbeat();
    now = T(20);
    s.audit.record('service.stopped', { reason: 'SIGINT' });
    await s.end('SIGINT');

    expect(await db.prisma.serviceRun.findFirst({ select: { heartbeatAt: true, stoppedAt: true, stopReason: true } })).toEqual({
      heartbeatAt: T(20),
      stoppedAt: T(20),
      stopReason: 'SIGINT',
    });
    expect(await db.prisma.auditEvent.count({ where: { type: 'service.stopped' } })).toBe(1);
  });

  it('a dry run registers nothing and repairs nothing, and never reports a crash', async () => {
    const live = await session();
    const stuck = { id: 'stuck', deviceId: 'dev1', waves: [[{ station: 1, runTime: 5 }]], soakMinutes: 0, createdAt: T0, nextWave: 0, dueAt: T0, attempts: 0 };
    await live.store.sequenceStarted(stuck, []);
    await live.store.waveDelivered(stuck, 0, 'event', T0, undefined); // fully delivered, never closed

    const dry = await session(config({ dryRun: true, zones: [zone({ deviceId: 'other', name: 'Elsewhere' })] }), { legacyLastEvent: { ts: T0.toISOString(), type: 'wave.sent' } });

    expect(dry.unclean).toBeUndefined();
    expect((await db.prisma.zone.findMany({ select: { zoneKey: true } })).map((z) => z.zoneKey)).not.toContain('other:1');
    expect(await db.prisma.wateringSequence.findFirst({ select: { status: true } })).toEqual({ status: 'active' });
  });
});
