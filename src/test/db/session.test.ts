import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import { SqliteAuditLog } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { auditEvent, serviceRun, wateringSequence, zone as zoneTable } from '../../db/schema.ts';
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
  db.select({ id: serviceRun.id, dryRun: serviceRun.dryRun, stoppedAt: serviceRun.stoppedAt, stopReason: serviceRun.stopReason }).from(serviceRun).orderBy(asc(serviceRun.id)).all();

describe('service runs', () => {
  let db: ConductorDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.$client.close();
  });

  it('records a run with its mode, process and effective configuration', () => {
    const cfg = config();
    const { runId, unclean } = beginServiceRun(db, { startedAt: T0, mode: 'once', dryRun: true, config: cfg, pid: 4242 });

    expect(unclean).toBeUndefined();
    expect(db.select().from(serviceRun).get()).toEqual({
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

  it('reports nothing after a clean stop', () => {
    const first = start(db, T0);
    recordHeartbeat(db, first.runId, T(15));
    endServiceRun(db, first.runId, T(20), 'SIGTERM');

    expect(start(db, T(30)).unclean).toBeUndefined();
    expect(runs(db)[0]).toMatchObject({ stoppedAt: T(20), stopReason: 'SIGTERM' });
  });

  it('closes and reports a run that never stopped, with its last activity', () => {
    const first = start(db, T0);
    const audit = new SqliteAuditLog(db, { now: () => T(28), serviceRunId: first.runId });
    audit.record('wave.confirmed', { sequence: 's' });
    new SqliteAuditLog(db, { now: () => T(35), serviceRunId: first.runId }).record('simulation.note', { note: 'killed' });
    recordHeartbeat(db, first.runId, T(30));

    const second = start(db, T(50));

    expect(second.unclean).toEqual({ runId: first.runId, lastEvent: 'wave.confirmed', lastEventAt: T(28).toISOString() });
    expect(runs(db)).toEqual([
      { id: first.runId, dryRun: false, stoppedAt: T(30), stopReason: 'unclean' }, // died after its last heartbeat
      { id: second.runId, dryRun: false, stoppedAt: null, stopReason: null },
    ]);
    expect(start(db, T(60)).unclean?.runId).toBe(second.runId); // each crash is reported once
  });

  it('falls back to the heartbeat when the crashed run recorded no events', () => {
    const first = start(db, T0);
    recordHeartbeat(db, first.runId, T(45));

    expect(start(db, T(50)).unclean).toEqual({ runId: first.runId, lastEvent: 'service.started', lastEventAt: T(45).toISOString() });
  });

  it('reports the latest real run among several unfinished ones, and closes the rest quietly', () => {
    const a = start(db, T0);
    const b = start(db, T(10)); // (a second instance: its start closed a)
    const dry = start(db, T(20), true); // a conductor:check that was killed

    const next = start(db, T(30));

    expect(next.unclean?.runId).toBe(b.runId);
    expect(runs(db).map((r) => [r.id, r.stopReason])).toEqual([
      [a.runId, 'unclean'],
      [b.runId, 'unclean'],
      [dry.runId, 'unclean'],
      [next.runId, null],
    ]);
  });

  it('a dry run leaves the live service alone (it may run next to it)', () => {
    const live = start(db, T0);

    const check = start(db, T(5), true);

    expect(check.unclean).toBeUndefined();
    expect(runs(db).find((r) => r.id === live.runId)?.stoppedAt).toBeNull();
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

  afterEach(() => {
    db.$client.close();
  });

  const session = (cfg = config(), extra: Partial<Parameters<typeof beginSession>[1]> = {}) =>
    beginSession(db, { config: cfg, mode: 'continuous', now: () => now, ...extra });

  it('records the run, registers the zones, and opens an audit trail tagged with the run', () => {
    const s = session();
    s.audit.record('service.started');

    expect(db.select({ key: zoneTable.zoneKey, name: zoneTable.name }).from(zoneTable).orderBy(asc(zoneTable.zoneKey)).all()).toEqual([
      { key: 'dev1:1', name: 'Front' },
      { key: 'dev1:2', name: 'Back' },
    ]);
    expect(db.select({ run: auditEvent.serviceRunId }).from(auditEvent).get()).toEqual({ run: s.runId });
    expect(s.state).toEqual({ history: [], sequences: [], alerts: {}, zoneSpells: [] });
  });

  it('loads what the previous run left, with history going back the longest cooldown', () => {
    const first = session();
    const left = { id: 'left', deviceId: 'dev1', waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]], soakMinutes: 30, createdAt: T0, nextWave: 0, dueAt: T0, attempts: 0 };
    first.store.sequenceStarted(left, []);
    first.store.waveDelivered(left, 0, 'event', T0, T(40));
    first.end('SIGTERM');

    now = T(24 * 60 + 5); // over 24 h later: neither the 600-minute cooldown nor the 24 h cap needs that run
    const second = session();

    expect(second.state.sequences).toEqual([expect.objectContaining({ id: 'left', nextWave: 1, dueAt: T(40) })]);
    expect(second.state.history).toEqual([]);
    now = T(20 * 60);
    expect(session().state.history).toEqual([{ zoneKey: 'dev1:1', at: T0, minutes: 10 }]);
  });

  it('reports a crash of the previous run', () => {
    session(); // never ended
    now = T(30);

    expect(session().unclean).toEqual({ lastEvent: 'service.started', lastEventAt: T0.toISOString() });
  });

  it('reports a crash of the version before the database, found in its imported trail', () => {
    const crashed = session({ ...config() }, { legacyLastEvent: { ts: T(-5).toISOString(), type: 'wave.sent' } });
    expect(crashed.unclean).toEqual({ lastEvent: 'wave.sent', lastEventAt: T(-5).toISOString() });
    crashed.end('x');

    const clean = session(config(), { legacyLastEvent: { ts: T(-5).toISOString(), type: 'service.stopped' } });
    expect(clean.unclean).toBeUndefined();
  });

  it('keeps the heartbeat and records a clean end', () => {
    const s = session();
    now = T(15);
    s.heartbeat();
    now = T(20);
    s.end('SIGINT');

    expect(db.select({ heartbeat: serviceRun.heartbeatAt, stopped: serviceRun.stoppedAt, reason: serviceRun.stopReason }).from(serviceRun).get()).toEqual({
      heartbeat: T(20),
      stopped: T(20),
      reason: 'SIGINT',
    });
  });

  it('a dry run registers nothing and repairs nothing, and never reports a crash', () => {
    const live = session();
    const stuck = { id: 'stuck', deviceId: 'dev1', waves: [[{ station: 1, runTime: 5 }]], soakMinutes: 0, createdAt: T0, nextWave: 0, dueAt: T0, attempts: 0 };
    live.store.sequenceStarted(stuck, []);
    live.store.waveDelivered(stuck, 0, 'event', T0, undefined); // fully delivered, never closed

    const dry = session(config({ dryRun: true, zones: [zone({ deviceId: 'other', name: 'Elsewhere' })] }), { legacyLastEvent: { ts: T0.toISOString(), type: 'wave.sent' } });

    expect(dry.unclean).toBeUndefined();
    expect(db.select({ key: zoneTable.zoneKey }).from(zoneTable).all().map((z) => z.key)).not.toContain('other:1');
    expect(db.select({ status: wateringSequence.status }).from(wateringSequence).get()).toEqual({ status: 'active' });
  });
});
