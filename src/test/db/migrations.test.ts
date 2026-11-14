import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, getViewConfig, SQLiteTable, SQLiteView } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPLICATION_ID, MIGRATIONS_FOLDER, openDatabase, type ConductorDb } from '../../db/database.ts';
import * as schema from '../../db/schema.ts';

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

const objects = (client: DatabaseSync): SchemaObject[] =>
  client
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY type, name`,
    )
    .all() as SchemaObject[];

const pragma = (db: ConductorDb, name: string): unknown => Object.values(db.$client.prepare(`PRAGMA ${name}`).get() ?? {})[0];

/** The tables and views declared in schema.ts. */
const schemaValues: unknown[] = Object.values(schema);
const schemaTables = schemaValues.filter((v): v is SQLiteTable => v instanceof SQLiteTable);
const schemaViews = schemaValues.filter((v): v is SQLiteView => v instanceof SQLiteView);

const migrationFolders = async (): Promise<string[]> => (await readdir(MIGRATIONS_FOLDER)).sort();

describe('database migrations', () => {
  let db: ConductorDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.$client.close();
  });

  it('creates every table, view, index and trigger of the design', () => {
    const byType = (type: string) => objects(db.$client).filter((o) => o.type === type).map((o) => o.name);

    expect(byType('table')).toEqual([
      'audit_event',
      'open_alert',
      'sensor_reading',
      'sequence_wave',
      'sequence_zone',
      'service_run',
      'watering_sequence',
      'wave_station',
      'zone',
      'zone_state',
      'zone_watering',
    ]);
    expect(byType('view')).toEqual(['pending_sequence', 'sequence_result']);
    expect(byType('index')).toEqual([
      'audit_event_device',
      'audit_event_sequence',
      'audit_event_ts',
      'audit_event_type_ts',
      'audit_event_zone',
      'sequence_zone_zone',
      'watering_sequence_created',
      'watering_sequence_device_created',
      'watering_sequence_one_active_per_device',
      'zone_watering_zone_time',
    ]);
    // Hand-written (drizzle-kit doesn't model triggers). A table rebuild in a later migration drops them.
    expect(objects(db.$client).filter((o) => o.type === 'trigger').map((o) => `${o.tbl_name}.${o.name}`)).toEqual([
      'audit_event.audit_event_no_update',
      'zone_watering.zone_watering_no_update',
    ]);
  });

  it('runs every statement of every migration file', async () => {
    // The migrator runs each chunk between breakpoint markers as ONE prepared statement, and node:sqlite
    // silently ignores anything after the first statement. exec() runs them all, so a chunk holding two
    // statements (a forgotten marker in a hand-written migration) makes the two schemas differ.
    const reference = new DatabaseSync(':memory:');
    for (const folder of await migrationFolders()) {
      const text = await readFile(join(MIGRATIONS_FOLDER, folder, 'migration.sql'), 'utf8');
      reference.exec(text.replaceAll('--> statement-breakpoint', ''));
    }

    expect(objects(db.$client)).toEqual(objects(reference));
    reference.close();
  });

  it('matches the drizzle schema, so the models and the migrations cannot drift apart', () => {
    expect(schemaTables.map((t) => getTableName(t)).sort()).toEqual(objects(db.$client).filter((o) => o.type === 'table').map((o) => o.name));

    for (const table of schemaTables) {
      const config = getTableConfig(table);
      const inDb = db.$client.prepare(`PRAGMA table_xinfo(${config.name})`).all() as { name: string; type: string; notnull: number }[];
      // drizzle-kit never writes NOT NULL on a single-column primary key (see the next test).
      const expected = config.columns.map((c) => ({ name: c.name, type: c.getSQLType().toUpperCase(), notnull: c.notNull && !c.primary ? 1 : 0 }));
      expect(inDb.map((c) => ({ name: c.name, type: c.type.toUpperCase(), notnull: c.notnull })), config.name).toEqual(expected);
    }
    for (const view of schemaViews) {
      const config = getViewConfig(view);
      const inDb = db.$client.prepare(`PRAGMA table_info(${config.name})`).all() as { name: string }[];
      expect(inDb.map((c) => c.name), config.name).toEqual(Object.values(config.selectedFields).map((f) => (f as { name: string }).name));
    }
  });

  it('rejects a NULL primary key in every table (SQLite allows one in non-INTEGER keys unless told otherwise)', () => {
    const singleKey = schemaTables
      .map((t) => getTableConfig(t))
      .flatMap((c) => c.columns.filter((col) => col.primary).map((col) => ({ table: c.name, column: col.name, type: col.getSQLType() })));
    expect(singleKey.map((k) => `${k.table}.${k.column}`).sort()).toEqual([
      'audit_event.id',
      'open_alert.alert_key',
      'service_run.id',
      'watering_sequence.id',
      'zone.zone_key',
      'zone_state.zone_key',
      'zone_watering.id',
    ]);
    // INTEGER keys alias the rowid and are assigned when NULL. Text keys need the check: each row below is
    // valid except for its key.
    const t = "'2026-07-01T11:00:00.000Z'";
    const inserts: Record<string, string> = {
      'open_alert.alert_key': `INSERT INTO open_alert (alert_key, state, since) VALUES (NULL, 'low', ${t})`,
      'watering_sequence.id': `INSERT INTO watering_sequence (id, device_id, soak_minutes, created_at) VALUES (NULL, 'd', 0, ${t})`,
      'zone.zone_key': `INSERT INTO zone VALUES (NULL, 'd', 1, 'Z', ${t}, ${t})`,
      'zone_state.zone_key': `INSERT INTO zone_state (zone_key, evaluated_at) VALUES (NULL, ${t})`,
    };
    expect(Object.keys(inserts)).toEqual(singleKey.filter((k) => k.type !== 'integer').map((k) => `${k.table}.${k.column}`).sort());
    for (const [key, insert] of Object.entries(inserts)) {
      expect(() => db.$client.prepare(insert).run(), key).toThrow(/CHECK constraint failed: \w+_not_null/);
    }
  });

  it('turns on foreign keys and marks the file as a conductor database', () => {
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(pragma(db, 'application_id')).toBe(APPLICATION_ID);
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(pragma(db, 'integrity_check')).toBe('ok');
  });
});

describe('database file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-db-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses WAL with full sync, and applies each migration exactly once across restarts', async () => {
    const path = join(dir, 'conductor.db');
    const first = openDatabase(path);
    expect(pragma(first, 'journal_mode')).toBe('wal');
    expect(pragma(first, 'synchronous')).toBe(2); // FULL
    first.insert(schema.openAlert).values({ alertKey: 'device:d1', state: 'offline', since: new Date('2026-07-01T11:00:00.000Z') }).run();
    first.$client.close();

    const second = openDatabase(path);
    const applied = second.$client.prepare('SELECT name FROM __drizzle_migrations ORDER BY id').all() as { name: string }[];
    expect(applied.map((m) => m.name)).toEqual(await migrationFolders());
    expect(second.select().from(schema.openAlert).all()).toEqual([
      { alertKey: 'device:d1', kind: 'device', state: 'offline', since: new Date('2026-07-01T11:00:00.000Z') },
    ]);
    second.$client.close();
  });

  it('refuses a SQLite file that belongs to something else, and leaves it untouched', () => {
    const foreign = join(dir, 'other.db');
    const client = new DatabaseSync(foreign);
    client.exec('CREATE TABLE notes (body TEXT)');
    client.close();
    expect(() => openDatabase(foreign)).toThrow(/not a bhyve-conductor database/);

    const tagged = join(dir, 'tagged.db');
    const other = new DatabaseSync(tagged);
    other.exec('PRAGMA application_id = 1234');
    other.close();
    expect(() => openDatabase(tagged)).toThrow(/application_id 1234/);

    const check = new DatabaseSync(foreign);
    expect(check.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all().map((r) => r.name)).toEqual(['notes']);
    check.close();
  });

  /** A copy of the real migrations plus one more, applied after the real ones. */
  const withExtraMigration = async (name: string, sqlText: string): Promise<string> => {
    const folder = join(dir, 'migrations');
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
    await mkdir(join(folder, name));
    await writeFile(join(folder, name, 'migration.sql'), sqlText);
    return folder;
  };

  it('keeps child rows when a later migration rebuilds a parent table', async () => {
    const path = join(dir, 'conductor.db');
    const db = openDatabase(path);
    const t = new Date('2026-07-01T11:00:00.000Z');
    db.insert(schema.zone).values({ zoneKey: 'd:1', deviceId: 'd', station: 1, name: 'Z', firstSeenAt: t, lastSeenAt: t }).run();
    db.insert(schema.wateringSequence).values({ id: 's1', deviceId: 'd', soakMinutes: 20, createdAt: t }).run();
    db.insert(schema.sequenceWave).values({ sequenceId: 's1', waveIndex: 0, status: 'sending', dueAt: t, sentAt: t }).run();
    db.insert(schema.waveStation).values({ sequenceId: 's1', waveIndex: 0, station: 1, runMinutes: 8 }).run();
    db.$client.close();

    // What drizzle-kit generates when a change needs watering_sequence rebuilt (plus the view drop/re-create
    // the rename needs, see docs/sqlite-storage.md). Built from the init migration's own statements.
    const [init] = await migrationFolders();
    const chunks = (await readFile(join(MIGRATIONS_FOLDER, init ?? '', 'migration.sql'), 'utf8')).split('--> statement-breakpoint').map((c) => c.trim());
    const table = chunks.find((c) => c.startsWith('CREATE TABLE `watering_sequence`')) ?? '';
    const indexes = chunks.filter((c) => /^CREATE (UNIQUE )?INDEX .* ON `watering_sequence`/.test(c));
    const views = chunks.filter((c) => c.startsWith('CREATE VIEW'));
    const rebuild = [
      'DROP VIEW `pending_sequence`',
      'DROP VIEW `sequence_result`',
      'PRAGMA foreign_keys=OFF', // as drizzle-kit writes it: a no-op inside the migrator's transaction
      table.replace('CREATE TABLE `watering_sequence`', 'CREATE TABLE `__new_watering_sequence`'),
      'INSERT INTO `__new_watering_sequence` SELECT * FROM `watering_sequence`',
      'DROP TABLE `watering_sequence`',
      'ALTER TABLE `__new_watering_sequence` RENAME TO `watering_sequence`',
      'PRAGMA foreign_keys=ON',
      ...indexes,
      ...views,
    ].join('\n--> statement-breakpoint\n');
    const folder = await withExtraMigration('29991231235959_rebuild_watering_sequence', rebuild);

    const upgraded = openDatabase(path, { migrationsFolder: folder });

    expect(upgraded.select({ id: schema.pendingSequence.id, inFlight: schema.pendingSequence.inFlightWave }).from(schema.pendingSequence).all()).toEqual([
      { id: 's1', inFlight: 0 },
    ]);
    expect(upgraded.select().from(schema.waveStation).all()).toHaveLength(1);
    expect(pragma(upgraded, 'foreign_keys')).toBe(1);
    upgraded.$client.close();
  });

  it('refuses to start when a migration leaves rows pointing at nothing', async () => {
    const path = join(dir, 'conductor.db');
    openDatabase(path).$client.close();
    const folder = await withExtraMigration('29991231235959_orphan', "INSERT INTO sequence_wave (sequence_id, wave_index) VALUES ('ghost', 0);");

    expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow(/1 row\(s\) reference missing rows \(sequence_wave → watering_sequence\)/);
  });

  it('rolls a failed upgrade back completely, so a later fixed release can retry', async () => {
    const folder = join(dir, 'migrations');
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
    await mkdir(join(folder, '29991231235959_broken'));
    await writeFile(
      join(folder, '29991231235959_broken', 'migration.sql'),
      'CREATE TABLE half_done (x INTEGER);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);',
    );
    const path = join(dir, 'conductor.db');
    openDatabase(path).$client.close(); // the current release

    expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow();

    const db = openDatabase(path);
    expect(objects(db.$client).some((o) => o.name === 'half_done')).toBe(false);
    db.$client.close();
  });
});
