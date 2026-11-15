import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_ID, openDatabase, type ConductorDb } from '../../db/database.ts';
import { appliedMigrations, editedMigrations, MIGRATIONS_FOLDER, MIGRATIONS_TABLE, pendingMigrations, readMigrations, SCHEMA_PATH } from '../../db/migrate.ts';
import { diagnoseMigrationHistory, diffDatabaseToSchema, diffMigrationsToSchema } from '../../db/schema-engine.ts';
import { log } from '../../log.ts';

type SchemaObject = { type: string; name: string; tbl_name: string };

const objects = (client: DatabaseSync): SchemaObject[] =>
  client
    .prepare(`SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name`)
    .all() as SchemaObject[];

const pragma = (client: DatabaseSync, name: string): unknown => Object.values(client.prepare(`PRAGMA ${name}`).get() ?? {})[0];

const T0 = new Date('2026-07-01T11:00:00.000Z');
const SCHEMA = await readFile(SCHEMA_PATH, 'utf8');

beforeEach(() => {
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(log, 'warn').mockImplementation(() => {});
});

describe('the Prisma migrations', () => {
  let db: ConductorDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(async () => {
    await db.close();
  });

  it('create every table and index of the data model, and nothing else (no views, no triggers)', () => {
    const byType = (type: string) => objects(db.sqlite).filter((o) => o.type === type).map((o) => o.name);

    expect(byType('table')).toEqual([
      MIGRATIONS_TABLE,
      'audit_event',
      'open_alert',
      'sensor_reading',
      'sequence_wave',
      'sequence_zone',
      'service_run',
      'simulation_event',
      'simulation_notification',
      'simulation_run',
      'simulation_sequence',
      'simulation_watering',
      'watering_sequence',
      'wave_station',
      'zone',
      'zone_state',
      'zone_watering',
    ]);
    expect(byType('index')).toEqual([
      'audit_event_device',
      'audit_event_sequence',
      'audit_event_ts',
      'audit_event_type_ts',
      'audit_event_zone',
      'sequence_zone_zone',
      'simulation_event_run',
      'simulation_notification_run',
      'simulation_run_scenario',
      'simulation_watering_run',
      'watering_sequence_created',
      'watering_sequence_device_created',
      'watering_sequence_device_status',
      'zone_device_station',
      'zone_watering_once_per_wave',
      'zone_watering_zone_time',
    ]);
    expect(byType('view')).toEqual([]);
    expect(byType('trigger')).toEqual([]);
  });

  it('produce exactly prisma/schema.prisma (what npm run db:check checks, with Prisma\'s schema engine)', async () => {
    expect(await diffMigrationsToSchema(MIGRATIONS_FOLDER, SCHEMA)).toBe('');
  });

  it('leave a database that matches the schema, with a history Prisma recognises as its own', async () => {
    expect(await diffDatabaseToSchema(db.sqlite, SCHEMA)).toBe('');
    expect(await diagnoseMigrationHistory(db.sqlite, MIGRATIONS_FOLDER, SCHEMA)).toMatchObject({
      hasMigrationsTable: true,
      editedMigrationNames: [],
      failedMigrationNames: [],
      history: null, // in sync: nothing to apply, nothing unknown
    });
  });

  it('are recorded as Prisma records them: name, and the SHA-256 of migration.sql', async () => {
    const files = readMigrations();
    const rows = db.sqlite.prepare(`SELECT migration_name, checksum, applied_steps_count, finished_at, rolled_back_at FROM ${MIGRATIONS_TABLE}`).all();

    expect(rows).toEqual(
      await Promise.all(
        files.map(async (m) => ({
          migration_name: m.name,
          checksum: createHash('sha256').update(await readFile(join(MIGRATIONS_FOLDER, m.name, 'migration.sql'))).digest('hex'),
          applied_steps_count: 1,
          finished_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          rolled_back_at: null,
        })),
      ),
    );
    expect(pendingMigrations(db.sqlite)).toEqual([]);
  });

  it('went into the generated client: it was generated from the current schema (npm run db:generate)', async () => {
    const client = await readFile(fileURLToPath(new URL('../../db/generated/internal/class.ts', import.meta.url)), 'utf8');
    const inline = /"inlineSchema": ("(?:[^"\\]|\\.)*")/.exec(client)?.[1];

    expect(inline && (JSON.parse(inline) as string)).toBe(SCHEMA);
  });

  it('turn on foreign keys and mark the file as a conductor database', () => {
    expect(pragma(db.sqlite, 'foreign_keys')).toBe(1);
    expect(pragma(db.sqlite, 'application_id')).toBe(APPLICATION_ID);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(pragma(db.sqlite, 'integrity_check')).toBe('ok');
  });
});

describe('database file', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-db-'));
    path = join(dir, 'conductor.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A copy of the real migrations plus more, applied after the real ones. */
  const withExtraMigrations = async (...extra: [name: string, sql: string][]): Promise<string> => {
    const folder = join(dir, 'migrations');
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
    for (const [name, sqlText] of extra) {
      await mkdir(join(folder, name), { recursive: true });
      await writeFile(join(folder, name, 'migration.sql'), sqlText);
    }
    return folder;
  };

  /** What Prisma's schema engine writes when a change needs `table` rebuilt ("RedefineTables"). */
  const redefine = async (table: string): Promise<string> => {
    const [init] = readMigrations();
    const create = (init?.sql ?? '').split('\n\n').find((c) => c.includes(`CREATE TABLE "${table}" (`)) ?? '';
    const columns = [...create.matchAll(/^ {4}"(\w+)" /gm)].map((m) => `"${m[1]}"`).join(', ');
    return [
      '-- RedefineTables',
      'PRAGMA defer_foreign_keys=ON;',
      'PRAGMA foreign_keys=OFF;',
      create.replace('-- CreateTable\n', '').replace(`CREATE TABLE "${table}"`, `CREATE TABLE "new_${table}"`),
      `INSERT INTO "new_${table}" (${columns}) SELECT ${columns} FROM "${table}";`,
      `DROP TABLE "${table}";`,
      `ALTER TABLE "new_${table}" RENAME TO "${table}";`,
      'PRAGMA foreign_keys=ON;',
      'PRAGMA defer_foreign_keys=OFF;',
    ].join('\n');
  };

  const seed = async (db: ConductorDb): Promise<void> => {
    const p = db.prisma;
    await p.zone.create({ data: { zoneKey: 'd:1', deviceId: 'd', station: 1, name: 'Z', firstSeenAt: T0, lastSeenAt: T0 } });
    await p.wateringSequence.create({
      data: {
        id: 's1',
        deviceId: 'd',
        soakMinutes: 20,
        createdAt: T0,
        waves: {
          create: [
            { waveIndex: 0, status: 'delivered', dueAt: T0, sentAt: T0, delivery: 'event', stations: { create: [{ station: 1, runMinutes: 8 }] } },
            { waveIndex: 1, status: 'sending', dueAt: T0, sentAt: T0, stations: { create: [{ station: 1, runMinutes: 8 }] } },
          ],
        },
      },
    });
    await p.zoneWatering.create({ data: { zoneKey: 'd:1', startedAt: T0, minutes: 8, sequenceId: 's1', waveIndex: 0 } });
    await p.auditEvent.create({ data: { ts: T0, type: 'wave.sent', data: { sequence: 's1' }, sequenceId: 's1' } });
  };

  it('uses WAL with full sync, and applies each migration exactly once across restarts', async () => {
    const first = openDatabase(path);
    expect(pragma(first.sqlite, 'journal_mode')).toBe('wal');
    expect(pragma(first.sqlite, 'synchronous')).toBe(2); // FULL
    await first.prisma.openAlert.create({ data: { alertKey: 'device:d1', kind: 'device', state: 'offline', since: T0 } });
    await first.close();

    const second = openDatabase(path);
    expect(appliedMigrations(second.sqlite).map((m) => m.name)).toEqual(readMigrations().map((m) => m.name));
    expect(await second.prisma.openAlert.findMany()).toEqual([{ alertKey: 'device:d1', kind: 'device', state: 'offline', since: T0 }]);
    await second.close();
    expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toEqual([]); // nothing was upgraded
  });

  it('refuses a SQLite file that belongs to something else, and leaves it untouched', () => {
    const foreign = join(dir, 'other.db');
    const client = new DatabaseSync(foreign);
    client.exec('CREATE TABLE notes (body TEXT)');
    client.close();
    expect(() => openDatabase(foreign)).toThrow(/not a bhyve-conductor database/);
    expect(() => openDatabase(foreign, { readOnly: true })).toThrow(/not a bhyve-conductor database/);

    const tagged = join(dir, 'tagged.db');
    const other = new DatabaseSync(tagged);
    other.exec('PRAGMA application_id = 1234');
    other.close();
    expect(() => openDatabase(tagged)).toThrow(/application_id 1234/);

    const check = new DatabaseSync(foreign);
    expect(check.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all().map((r) => r.name)).toEqual(['notes']);
    check.close();
  });

  describe('read-only', () => {
    it('reads without writing or migrating', async () => {
      const writer = openDatabase(path);
      await seed(writer);
      await writer.close();

      const reader = openDatabase(path, { readOnly: true });
      expect(await reader.prisma.auditEvent.count()).toBe(1);
      await expect(reader.prisma.auditEvent.create({ data: { ts: T0, type: 'wave.sent', data: {} } })).rejects.toThrow(/readonly/);
      await reader.close();
    });

    it('explains a missing file, and warns about an outdated one', async () => {
      expect(() => openDatabase(join(dir, 'missing.db'), { readOnly: true })).toThrow(/does not exist yet/);

      await openDatabase(path).close();
      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE "later" ("x" INTEGER);']);
      await openDatabase(path, { readOnly: true, migrationsFolder: folder }).close();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('1 migration(s) pending'));
    });
  });

  describe('upgrades', () => {
    it('backs the file up before applying pending migrations', async () => {
      const db = openDatabase(path);
      await seed(db);
      await db.close();
      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE "later" ("x" INTEGER);']);

      const upgraded = openDatabase(path, { migrationsFolder: folder });
      await upgraded.prisma.openAlert.create({ data: { alertKey: 'device:after', kind: 'device', state: 'offline', since: T0 } });
      await upgraded.close();

      const copy = new DatabaseSync(`${path}.before-29991231235959_later`);
      expect(copy.prepare('SELECT count(*) AS n FROM audit_event').get()).toEqual({ n: 1 });
      expect(copy.prepare('SELECT count(*) AS n FROM open_alert').get()).toEqual({ n: 0 }); // from before the upgrade
      expect(copy.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'later'`).get()).toBeUndefined();
      copy.close();
    });

    it('keeps the copy from before the first attempt when a failed upgrade is retried', async () => {
      const db = openDatabase(path);
      await seed(db);
      await db.close();
      const folder = await withExtraMigrations(['29991231235959_later', 'INSERT INTO "no_such_table" VALUES (1);']);
      expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow(/upgrading the database failed/);

      // Meanwhile the previous release runs again and records more.
      const old = openDatabase(path);
      await old.prisma.auditEvent.create({ data: { ts: T0, type: 'service.started', data: {} } });
      await old.close();
      await writeFile(join(folder, '29991231235959_later', 'migration.sql'), 'CREATE TABLE "later" ("x" INTEGER);'); // the fixed release
      await openDatabase(path, { migrationsFolder: folder }).close();

      const copy = new DatabaseSync(`${path}.before-29991231235959_later`);
      expect(copy.prepare('SELECT count(*) AS n FROM audit_event').get()).toEqual({ n: 1 }); // as before the first attempt
      copy.close();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already exists (an earlier upgrade attempt); keeping it'));
    });

    it('does not back up a brand-new database, or when asked not to', async () => {
      await openDatabase(path).close();
      expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toEqual([]);

      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE "later" ("x" INTEGER);']);
      await openDatabase(path, { migrationsFolder: folder, backup: false }).close();
      expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toEqual([]);
    });

    it('keeps child rows when a migration rebuilds their parent table (Prisma\'s RedefineTables)', async () => {
      const db = openDatabase(path);
      await seed(db);
      await db.close();
      const folder = await withExtraMigrations(['29991231235959_redefine_watering_sequence', await redefine('watering_sequence')]);

      const upgraded = openDatabase(path, { migrationsFolder: folder });

      // With foreign keys on inside the transaction, the DROP TABLE would have cascaded into every wave and station.
      expect(await upgraded.prisma.sequenceWave.count()).toBe(2);
      expect(await upgraded.prisma.waveStation.count()).toBe(2);
      expect((await upgraded.prisma.zoneWatering.findFirst())?.sequenceId).toBe('s1');
      expect(pragma(upgraded.sqlite, 'foreign_keys')).toBe(1);
      await upgraded.close();
    });

    it('refuses to start when a migration leaves rows pointing at nothing', async () => {
      await openDatabase(path).close();
      const folder = await withExtraMigrations(['29991231235959_orphan', `INSERT INTO "sequence_wave" ("sequence_id", "wave_index") VALUES ('ghost', 0);`]);

      expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow(/1 row\(s\) would reference missing rows \(sequence_wave → watering_sequence\)/);
      const check = new DatabaseSync(path);
      expect(check.prepare('SELECT count(*) AS n FROM sequence_wave').get()).toEqual({ n: 0 });
      check.close();
    });

    it('rolls a failed upgrade back completely, says why and where the copy is, and a fixed release can retry', async () => {
      const db = openDatabase(path);
      await seed(db);
      await db.close();
      const folder = await withExtraMigrations(
        ['29991231235958_fine', 'CREATE TABLE "fine" ("x" INTEGER);'],
        ['29991231235959_broken', 'CREATE TABLE "half_done" ("x" INTEGER);\nINSERT INTO "no_such_table" VALUES (1);'],
      );

      expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow(
        /upgrading the database failed, nothing was changed \(migration 29991231235959_broken failed: no such table: no_such_table\)\. Pending: 29991231235958_fine, 29991231235959_broken\. A copy from before the upgrade is at .*before-29991231235958_fine/,
      );

      const check = new DatabaseSync(path);
      expect(objects(check).map((o) => o.name)).not.toEqual(expect.arrayContaining(['fine']));
      expect(objects(check).some((o) => o.name === 'half_done' || o.name === 'fine')).toBe(false);
      expect(appliedMigrations(check).map((m) => m.name)).toEqual(readMigrations().map((m) => m.name));
      check.close();
      const reopened = openDatabase(path);
      expect(await reopened.prisma.wateringSequence.count()).toBe(1);
      await reopened.close();
    });

    it('warns about a migration changed after it was applied, and applies nothing for it', async () => {
      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE "later" ("x" INTEGER);']);
      await openDatabase(path, { migrationsFolder: folder }).close();
      await writeFile(join(folder, '29991231235959_later', 'migration.sql'), 'CREATE TABLE "later" ("x" INTEGER, "y" TEXT);');

      const db = openDatabase(path, { migrationsFolder: folder });

      expect(editedMigrations(db.sqlite, folder)).toEqual(['29991231235959_later']);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Migration 29991231235959_later was changed after it was applied'));
      expect(db.sqlite.prepare(`SELECT name FROM pragma_table_info('later')`).all().map((c) => c.name)).toEqual(['x']);
      await db.close();
    });

    it('refuses to start on a migration a Prisma tool started and never finished', async () => {
      await openDatabase(path).close();
      const client = new DatabaseSync(path);
      client
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('x', 'c', '29991231235959_failed', ?, 0)`)
        .run(T0.toISOString());
      client.close();

      expect(() => openDatabase(path)).toThrow(/29991231235959_failed were started by a Prisma tool and never finished/);
    });
  });

  it('a database file is only ever created by opening it, not by checking it', async () => {
    expect(existsSync(path)).toBe(false);
    expect(() => openDatabase(path, { readOnly: true })).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
