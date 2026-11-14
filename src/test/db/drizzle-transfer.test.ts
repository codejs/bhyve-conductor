import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import { queryAuditEvents } from '../../db/audit-log.ts';
import { openDatabase } from '../../db/database.ts';
import { DRIZZLE_TABLES, isDrizzleDatabase, recoverInterruptedTransfer, transferPathOf } from '../../db/drizzle-transfer.ts';
import { MIGRATIONS_TABLE, readMigrations } from '../../db/migrate.ts';
import { beginSession } from '../../db/session.ts';
import { SqliteStore } from '../../db/store.ts';
import { log } from '../../log.ts';
import { zone } from '../utils/conductor.ts';
import { buildDrizzleDatabase, copyDrizzleFixture, DRIZZLE_MIGRATIONS, fillDrizzleDatabase } from '../utils/drizzle-db.ts';

/**
 * A database written by the drizzle-based version becomes a Prisma-managed one on the first start of this
 * version, with every row, and the conductor carries on from it as if nothing had happened.
 */

const T = (m: number): Date => new Date(Date.parse('2026-07-01T11:00:00.000Z') + m * 60_000);
const config: ConductorConfig = {
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones: [zone({ name: 'Front lawn', deviceId: 'timer-1' }), zone({ name: 'Back lawn', deviceId: 'timer-1', station: 2 })],
};

type Rows = Record<string, Record<string, unknown>[]>;

/**
 * Every row of every table the two versions share, column by column. (Opened read-write: a read-only
 * connection to a WAL database leaves its -wal/-shm files behind.)
 */
const snapshot = (path: string): Rows => {
  const client = new DatabaseSync(path);
  const rows = Object.fromEntries(
    Object.entries(DRIZZLE_TABLES).map(([table, cols]) => [
      table,
      client
        .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" ORDER BY rowid`)
        .all()
        .map((r) => ({ ...r })),
    ]),
  );
  client.close();
  return rows;
};

const objects = (path: string): string[] => {
  const client = new DatabaseSync(path);
  const names = (client.prepare(`SELECT type || ' ' || name AS o FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY 1`).all() as { o: string }[]).map((r) => r.o);
  client.close();
  return names;
};

describe('converting a database of the drizzle-based version', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), 'conductor-transfer-'));
    path = join(dir, 'conductor.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('the database that version wrote', () => {
    beforeEach(() => {
      copyDrizzleFixture(path);
    });

    it('keeps every row of every table, and the original file as a backup', async () => {
      const before = snapshot(path);
      expect(isDrizzleDatabase(path)).toBe(true);

      const db = openDatabase(path);
      await db.close();

      expect(snapshot(path)).toEqual(before);
      expect(db.transferred).toEqual({
        backupPath: `${path}.drizzle-backup`,
        rows: Object.fromEntries(Object.entries(before).map(([t, r]) => [t, r.length])),
        drizzleMigrations: [...DRIZZLE_MIGRATIONS],
      });
      expect(snapshot(`${path}.drizzle-backup`)).toEqual(before);
      expect(isDrizzleDatabase(path)).toBe(false);
      expect((await readdir(dir)).sort()).toEqual(['conductor.db', 'conductor.db.drizzle-backup']);
    });

    it('leaves nothing of drizzle behind: its bookkeeping, views, triggers and generated columns are gone', async () => {
      const old = objects(path);
      expect(old).toEqual(expect.arrayContaining(['table __drizzle_migrations', 'view pending_sequence', 'view sequence_result', 'trigger audit_event_no_update', 'trigger zone_watering_no_update']));

      await openDatabase(path).close();

      const now = objects(path);
      expect(now.filter((o) => !o.startsWith('table') && !o.startsWith('index'))).toEqual([]);
      expect(now).toContain(`table ${MIGRATIONS_TABLE}`);
      expect(now).not.toContain('table __drizzle_migrations');
      const client = new DatabaseSync(path);
      const hidden = client.prepare(`SELECT name FROM pragma_table_xinfo('audit_event') WHERE hidden <> 0`).all();
      const applied = client.prepare(`SELECT migration_name AS name FROM ${MIGRATIONS_TABLE}`).all() as { name: string }[];
      client.close();
      expect(hidden).toEqual([]); // no generated columns
      expect(applied.map((m) => m.name)).toEqual(readMigrations().map((m) => m.name));
    });

    it('lets the conductor carry on: the same state, the crashed sequence to resume, the crash reported', async () => {
      const db = openDatabase(path);
      const session = await beginSession(db, { config, mode: 'continuous', now: () => T(345) });

      expect(session.unclean).toEqual({ lastEvent: 'wave.sent', lastEventAt: T(332.5).toISOString() });
      expect(session.state.sequences).toEqual([
        {
          id: 'mid-send-0000-4000-8000-000000000003',
          deviceId: 'timer-1',
          waves: [
            [
              { station: 1, runTime: 8 },
              { station: 2, runTime: 4.5 },
            ],
            [{ station: 1, runTime: 8 }],
          ],
          soakMinutes: 20,
          zoneNames: ['Front lawn', 'Back lawn'],
          createdAt: T(300),
          nextWave: 1,
          dueAt: T(332.5),
          attempts: 1,
          inFlight: { wave: 1, since: T(333) },
        },
      ]);
      expect(session.state.alerts).toEqual({
        'battery:sensor:front-a': { state: 'low', since: T(5).toISOString() },
        'device:timer-2': { state: 'offline', since: T(61).toISOString() },
        'moisture:timer-1:1:front-a': { state: 'high', since: T(40).toISOString() },
      });
      expect(session.state.zoneSpells).toEqual([
        { zoneKey: 'timer-1:1', drySince: T(290), evaluatedAt: T(333) },
        { zoneKey: 'timer-1:2', noDataSince: T(200), evaluatedAt: T(333) },
      ]);
      expect(session.state.history).toEqual([
        { zoneKey: 'timer-1:2', at: T(-600), minutes: 12 }, // imported by that version from its JSON files
        { zoneKey: 'timer-1:1', at: T(0), minutes: 8 },
        { zoneKey: 'timer-1:2', at: T(0), minutes: 4.5 },
        { zoneKey: 'timer-1:1', at: T(32.5), minutes: 8 },
        { zoneKey: 'timer-1:1', at: T(300), minutes: 8 },
        { zoneKey: 'timer-1:2', at: T(300), minutes: 4.5 },
      ]);
      const results = await session.store.sequenceResults();
      expect(results.map((r) => [r.id.slice(0, 8), r.status, r.cyclesDelivered, r.deliveredMinutes, r.uncertainStationRuns, r.failedAttempts])).toEqual([
        ['3d7cc742', 'completed', 2, 20.5, 1, 0],
        ['77aa0000', 'abandoned', 0, 0, 0, 2],
        ['mid-send', 'active', 1, 12.5, 0, 1],
      ]);
      // The sequence resumes and finishes in the converted database.
      const [pending] = session.state.sequences;
      if (!pending) throw new Error('no pending sequence');
      await session.store.waveDelivered(pending, 1, 'assumed', T(333), undefined);
      await session.store.sequenceCompleted(pending, T(345));
      await session.end('test');
      await db.close();
    });

    it('keeps the audit trail readable and its ids counting up from where they were', async () => {
      const before = new DatabaseSync(path);
      const oldEvents = (before.prepare('SELECT ts, type, data FROM audit_event ORDER BY id').all() as { ts: string; type: string; data: string }[]).map((e) => ({
        ts: e.ts,
        type: e.type,
        ...(JSON.parse(e.data) as object),
      }));
      before.close();

      const db = openDatabase(path);
      expect(await queryAuditEvents(db)).toEqual(oldEvents);
      expect(await db.prisma.auditEvent.count({ where: { deviceId: '12345' } })).toBe(1); // a former generated column, as text
      const { id } = await db.prisma.auditEvent.create({ data: { ts: T(400), type: 'service.started', data: {} }, select: { id: true } });
      expect(id).toBe(39); // the old counter was 38: deleted ids are never reused
      await db.close();
    });
  });

  it.each([1, 2, 3] as const)('converts a database at drizzle migration level %i', async (level) => {
    const client = buildDrizzleDatabase(path, level);
    fillDrizzleDatabase(client);
    client.close();
    const before = snapshot(path);

    const db = openDatabase(path);

    expect(db.transferred?.drizzleMigrations).toEqual(DRIZZLE_MIGRATIONS.slice(0, level));
    expect(await new SqliteStore(db).loadState(T(30), 0)).toMatchObject({ sequences: [expect.objectContaining({ id: 's1', nextWave: 1, attempts: 1, inFlight: { wave: 1, since: T(29) } })] });
    await db.close();
    expect(snapshot(path)).toEqual(before);
  });

  it('converts once: the next start opens the converted file as it is', async () => {
    copyDrizzleFixture(path);
    await openDatabase(path).close();
    const db = openDatabase(path);

    expect(db.transferred).toBeUndefined();
    expect(await db.prisma.wateringSequence.count()).toBe(3);
    await db.close();
    expect((await readdir(dir)).filter((f) => f.includes('drizzle-backup'))).toEqual(['conductor.db.drizzle-backup']);
  });

  it('does nothing while the old service still has the file open', async () => {
    copyDrizzleFixture(path);
    const running = new DatabaseSync(path); // the previous version, still running
    running.prepare('SELECT count(*) FROM audit_event').get();
    const before = snapshot(path);

    expect(() => openDatabase(path)).toThrow(/still open in another process/);

    running.close();
    expect(snapshot(path)).toEqual(before);
    expect(isDrizzleDatabase(path)).toBe(true);
    expect(existsSync(transferPathOf(path))).toBe(false);
  });

  it('changes nothing when the copy fails, and says why', async () => {
    const client = buildDrizzleDatabase(path);
    fillDrizzleDatabase(client);
    client.exec('PRAGMA foreign_keys = OFF');
    client.exec(`INSERT INTO wave_station VALUES ('ghost', 0, 1, 5)`); // a row pointing at nothing
    client.close();
    const before = snapshot(path);

    expect(() => openDatabase(path)).toThrow(/converting the database to the new storage format failed, nothing was changed \(1 copied row\(s\) reference missing rows\)/);

    expect(snapshot(path)).toEqual(before);
    expect(isDrizzleDatabase(path)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['conductor.db']);
  });

  it('refuses to read (npm run audit) a database that has not been converted yet', () => {
    copyDrizzleFixture(path);

    expect(() => openDatabase(path, { readOnly: true })).toThrow(/from the previous storage version; start the conductor \(or run npm run db:migrate\) once/);
  });

  describe('after a crash during the conversion', () => {
    it('removes a half-built new file and converts again', async () => {
      copyDrizzleFixture(path);
      await writeFile(transferPathOf(path), 'half written');

      const db = openDatabase(path);

      expect(db.transferred).toBeDefined();
      expect(existsSync(transferPathOf(path))).toBe(false);
      await db.close();
    });

    it('finishes the swap when the crash came between the two renames', async () => {
      copyDrizzleFixture(path);
      const before = snapshot(path);
      await openDatabase(path).close(); // a full conversion...
      const { renameSync } = await import('node:fs');
      renameSync(path, transferPathOf(path)); // ...as if the process died after moving the original away

      recoverInterruptedTransfer(path);

      expect(existsSync(path)).toBe(true);
      expect(snapshot(path)).toEqual(before);
      const db = openDatabase(path);
      expect(db.transferred).toBeUndefined();
      await db.close();
    });

    it('stops if the original is gone without a backup (something else happened: look before starting)', async () => {
      await writeFile(transferPathOf(path), 'x');

      expect(() => recoverInterruptedTransfer(path)).toThrow(/is missing and .* is there without a backup/);
    });
  });

  it('leaves other databases alone', async () => {
    const other = join(dir, 'other.db');
    const client = new DatabaseSync(other);
    client.exec('CREATE TABLE __drizzle_migrations (id INTEGER)'); // drizzle, but not the conductor's
    client.close();

    expect(isDrizzleDatabase(other)).toBe(false);
    expect(isDrizzleDatabase(join(dir, 'missing.db'))).toBe(false);
    await writeFile(join(dir, 'junk.db'), 'not a database');
    expect(isDrizzleDatabase(join(dir, 'junk.db'))).toBe(false);
    expect(() => openDatabase(other)).toThrow(/not a bhyve-conductor database/);
  });
});
