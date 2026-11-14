import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, getViewConfig, SQLiteTable, SQLiteView } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_ID, appliedMigrations, MIGRATIONS_FOLDER, openDatabase, pendingMigrations, type ConductorDb } from '../../db/database.ts';
import { ensureRepeatables, REPEATABLE_OBJECTS } from '../../db/repeatable.ts';
import * as schema from '../../db/schema.ts';
import { log } from '../../log.ts';

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

const objects = (client: DatabaseSync): SchemaObject[] =>
  client
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY type, name`,
    )
    .all() as SchemaObject[];

const repeatableNames = new Set(REPEATABLE_OBJECTS.map((o) => o.name));
/** Tables and indexes: what migrations own. */
const migrated = (client: DatabaseSync): SchemaObject[] => objects(client).filter((o) => !repeatableNames.has(o.name));

const pragma = (db: ConductorDb, name: string): unknown => Object.values(db.$client.prepare(`PRAGMA ${name}`).get() ?? {})[0];

/** The tables and views declared in schema.ts. */
const schemaValues: unknown[] = Object.values(schema);
const schemaTables = schemaValues.filter((v): v is SQLiteTable => v instanceof SQLiteTable);
const schemaViews = schemaValues.filter((v): v is SQLiteView => v instanceof SQLiteView);

const migrationFolders = async (): Promise<string[]> => (await readdir(MIGRATIONS_FOLDER)).sort();
const T0 = new Date('2026-07-01T11:00:00.000Z');

beforeEach(() => {
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(log, 'warn').mockImplementation(() => {});
});

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

    expect(migrated(db.$client)).toEqual(migrated(reference));
    reference.close();
  });

  it('keeps its views and triggers exactly as the app defines them', () => {
    for (const o of REPEATABLE_OBJECTS) {
      const row = db.$client.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get(o.type, o.name) as { sql: string };
      expect(row.sql, o.name).toBe(o.sql);
    }
    expect(ensureRepeatables(db.$client)).toEqual([]); // nothing to do on the next start
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
    // The views are defined in repeatable.ts and declared with .existing() in schema.ts.
    expect(schemaViews.map((v) => getViewConfig(v).name).sort()).toEqual(objects(db.$client).filter((o) => o.type === 'view').map((o) => o.name));
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

  it('has nothing pending once open', async () => {
    expect(pendingMigrations(db.$client)).toEqual([]);
    expect(appliedMigrations(db.$client)).toEqual(await migrationFolders());
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
      await mkdir(join(folder, name));
      await writeFile(join(folder, name, 'migration.sql'), sqlText);
    }
    return folder;
  };

  /** Statements of the init migration, to build drizzle-kit-style rebuilds from. */
  const initStatements = async (): Promise<string[]> => {
    const [init] = await migrationFolders();
    return (await readFile(join(MIGRATIONS_FOLDER, init ?? '', 'migration.sql'), 'utf8')).split('--> statement-breakpoint').map((c) => c.trim());
  };

  /** What drizzle-kit generates when a change needs `table` rebuilt (copy, drop, rename, indexes). */
  const rebuildOf = async (table: string): Promise<string> => {
    const statements = await initStatements();
    const create = statements.find((c) => c.startsWith(`CREATE TABLE \`${table}\``)) ?? '';
    const indexes = statements.filter((c) => new RegExp(`^CREATE (UNIQUE )?INDEX .* ON \`${table}\``).test(c));
    return [
      'PRAGMA foreign_keys=OFF', // as drizzle-kit writes it: a no-op inside the migrator's transaction
      create.replace(`CREATE TABLE \`${table}\``, `CREATE TABLE \`__new_${table}\``),
      `INSERT INTO \`__new_${table}\` SELECT * FROM \`${table}\``,
      `DROP TABLE \`${table}\``,
      `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\``,
      'PRAGMA foreign_keys=ON',
      ...indexes,
    ].join('\n--> statement-breakpoint\n');
  };

  const seed = (db: ConductorDb): void => {
    db.insert(schema.zone).values({ zoneKey: 'd:1', deviceId: 'd', station: 1, name: 'Z', firstSeenAt: T0, lastSeenAt: T0 }).run();
    db.insert(schema.wateringSequence).values({ id: 's1', deviceId: 'd', soakMinutes: 20, createdAt: T0 }).run();
    db.insert(schema.sequenceWave)
      .values([
        { sequenceId: 's1', waveIndex: 0, status: 'delivered', dueAt: T0, sentAt: T0, delivery: 'event' },
        { sequenceId: 's1', waveIndex: 1, status: 'sending', dueAt: T0, sentAt: T0 },
      ])
      .run();
    db.insert(schema.waveStation)
      .values([
        { sequenceId: 's1', waveIndex: 0, station: 1, runMinutes: 8 },
        { sequenceId: 's1', waveIndex: 1, station: 1, runMinutes: 8 },
      ])
      .run();
    db.insert(schema.zoneWatering).values({ zoneKey: 'd:1', startedAt: T0, minutes: 8, sequenceId: 's1', waveIndex: 0 }).run();
    db.insert(schema.auditEvent).values({ ts: T0, type: 'wave.sent', data: { sequence: 's1' } }).run();
  };

  it('uses WAL with full sync, and applies each migration exactly once across restarts', async () => {
    const first = openDatabase(path);
    expect(pragma(first, 'journal_mode')).toBe('wal');
    expect(pragma(first, 'synchronous')).toBe(2); // FULL
    first.insert(schema.openAlert).values({ alertKey: 'device:d1', state: 'offline', since: T0 }).run();
    first.$client.close();

    const second = openDatabase(path);
    expect(appliedMigrations(second.$client)).toEqual(await migrationFolders());
    expect(second.select().from(schema.openAlert).all()).toEqual([{ alertKey: 'device:d1', kind: 'device', state: 'offline', since: T0 }]);
    second.$client.close();
    expect(existsSync(`${path}.before-${(await migrationFolders())[0]}`)).toBe(false); // nothing was upgraded
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
    it('reads without writing or migrating', () => {
      const writer = openDatabase(path);
      seed(writer);
      writer.$client.close();

      const reader = openDatabase(path, { readOnly: true });
      expect(reader.select().from(schema.auditEvent).all()).toHaveLength(1);
      expect(() => reader.insert(schema.auditEvent).values({ ts: T0, type: 'wave.sent' }).run()).toThrow();
      reader.$client.close();
    });

    it('explains a missing file, and warns about an outdated one', async () => {
      expect(() => openDatabase(join(dir, 'missing.db'), { readOnly: true })).toThrow(/does not exist yet/);

      openDatabase(path).$client.close();
      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE later (x INTEGER);']);
      openDatabase(path, { readOnly: true, migrationsFolder: folder }).$client.close();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('1 migration(s) pending'));
    });
  });

  describe('upgrades', () => {
    it('backs the file up before applying pending migrations', async () => {
      const db = openDatabase(path);
      seed(db);
      db.$client.close();
      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE later (x INTEGER);']);

      const upgraded = openDatabase(path, { migrationsFolder: folder });
      upgraded.insert(schema.openAlert).values({ alertKey: 'device:after', state: 'offline', since: T0 }).run();
      upgraded.$client.close();

      const backup = `${path}.before-29991231235959_later`;
      const copy = new DatabaseSync(backup, { readOnly: true });
      expect(copy.prepare('SELECT count(*) AS n FROM audit_event').get()).toEqual({ n: 1 });
      expect(copy.prepare('SELECT count(*) AS n FROM open_alert').get()).toEqual({ n: 0 }); // from before the upgrade
      expect(copy.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'later'`).get()).toBeUndefined();
      copy.close();
    });

    it('keeps the copy from before the first attempt when a failed upgrade is retried', async () => {
      const db = openDatabase(path);
      seed(db);
      db.$client.close();
      const broken = await withExtraMigrations(['29991231235959_later', 'INSERT INTO no_such_table VALUES (1);']);
      expect(() => openDatabase(path, { migrationsFolder: broken })).toThrow(/upgrading the database failed/);

      // Meanwhile the previous release runs again and records more.
      const old = openDatabase(path);
      old.insert(schema.auditEvent).values({ ts: T0, type: 'service.started' }).run();
      old.$client.close();
      await writeFile(join(broken, '29991231235959_later', 'migration.sql'), 'CREATE TABLE later (x INTEGER);'); // the fixed release
      openDatabase(path, { migrationsFolder: broken }).$client.close();

      const copy = new DatabaseSync(`${path}.before-29991231235959_later`, { readOnly: true });
      expect(copy.prepare('SELECT count(*) AS n FROM audit_event').get()).toEqual({ n: 1 }); // as before the first attempt
      copy.close();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already exists (an earlier upgrade attempt); keeping it'));
    });

    it('does not back up a brand-new database, or when asked not to', async () => {
      openDatabase(path).$client.close();
      expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toEqual([]);

      const folder = await withExtraMigrations(['29991231235959_later', 'CREATE TABLE later (x INTEGER);']);
      openDatabase(path, { migrationsFolder: folder, backup: false }).$client.close();
      expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toEqual([]);
    });

    it('keeps child rows when a later migration rebuilds a parent table', async () => {
      const db = openDatabase(path);
      seed(db);
      db.$client.close();
      const folder = await withExtraMigrations(['29991231235959_rebuild_watering_sequence', await rebuildOf('watering_sequence')]);

      const upgraded = openDatabase(path, { migrationsFolder: folder });

      // Without foreign keys off, the DROP TABLE would have cascaded into every wave and station.
      expect(upgraded.select({ id: schema.pendingSequence.id, inFlight: schema.pendingSequence.inFlightWave }).from(schema.pendingSequence).all()).toEqual([
        { id: 's1', inFlight: 1 },
      ]);
      expect(upgraded.select().from(schema.waveStation).all()).toHaveLength(2);
      expect(upgraded.select().from(schema.zoneWatering).get()?.sequenceId).toBe('s1');
      expect(pragma(upgraded, 'foreign_keys')).toBe(1);
      upgraded.$client.close();
    });

    it('keeps the append-only triggers when a migration rebuilds their table', async () => {
      const db = openDatabase(path);
      seed(db);
      db.$client.close();
      const folder = await withExtraMigrations(
        ['29991231235958_rebuild_zone_watering', await rebuildOf('zone_watering')],
        ['29991231235959_rebuild_audit_event', await rebuildOf('audit_event')],
      );

      const upgraded = openDatabase(path, { migrationsFolder: folder });

      expect(() => upgraded.$client.exec('UPDATE zone_watering SET minutes = 0')).toThrow(/zone_watering is append-only/);
      expect(() => upgraded.$client.exec(`UPDATE audit_event SET type = 'x'`)).toThrow(/audit_event is append-only/);
      expect(upgraded.select().from(schema.auditEvent).all()).toHaveLength(1);
      upgraded.$client.close();
    });

    it('refuses to start when a migration leaves rows pointing at nothing', async () => {
      openDatabase(path).$client.close();
      const folder = await withExtraMigrations(['29991231235959_orphan', "INSERT INTO sequence_wave (sequence_id, wave_index) VALUES ('ghost', 0);"]);

      expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow(/1 row\(s\) reference missing rows \(sequence_wave → watering_sequence\)/);
    });

    it('rolls a failed upgrade back completely, with views and triggers intact, so a later fixed release can retry', async () => {
      const db = openDatabase(path);
      seed(db);
      db.$client.close();
      const folder = await withExtraMigrations([
        '29991231235959_broken',
        'CREATE TABLE half_done (x INTEGER);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);',
      ]);

      expect(() => openDatabase(path, { migrationsFolder: folder })).toThrow();

      const check = new DatabaseSync(path);
      expect(objects(check).some((o) => o.name === 'half_done')).toBe(false);
      expect(objects(check).filter((o) => repeatableNames.has(o.name)).map((o) => o.name)).toEqual([
        'audit_event_no_update',
        'zone_watering_no_update',
        'pending_sequence',
        'sequence_result',
      ]);
      check.close();
      const reopened = openDatabase(path);
      expect(reopened.select().from(schema.pendingSequence).all()).toHaveLength(1);
      reopened.$client.close();
    });

    it('leaves the views and triggers as they were when a new definition cannot be applied', () => {
      openDatabase(path).$client.close();
      const broken = REPEATABLE_OBJECTS.map((o) => (o.name === 'sequence_result' ? { ...o, sql: 'CREATE VIEW sequence_result AS SELECT nope FROM nowhere' } : o));

      expect(() => openDatabase(path, { repeatables: broken })).toThrow(/no such table: (main\.)?nowhere/);

      const check = new DatabaseSync(path, { readOnly: true });
      expect(check.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'sequence_result'`).get()).toEqual({
        sql: REPEATABLE_OBJECTS.find((o) => o.name === 'sequence_result')?.sql,
      });
      check.close();
    });

    it('applies changed view or trigger definitions at the next start without a migration', () => {
      openDatabase(path).$client.close();
      const changed = REPEATABLE_OBJECTS.map((o) =>
        o.name === 'audit_event_no_update' ? { ...o, sql: o.sql.replace('audit_event is append-only', 'audit trail is read-only') } : o,
      );

      const db = openDatabase(path, { repeatables: changed });
      seed(db);

      expect(() => db.$client.exec(`UPDATE audit_event SET type = 'x'`)).toThrow(/audit trail is read-only/);
      db.$client.close();
    });
  });
});
