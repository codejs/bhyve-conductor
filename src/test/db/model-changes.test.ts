import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import type { PendingSequence } from '../../conductor/state.ts';
import { openDatabase, pendingMigrations, MIGRATIONS_FOLDER } from '../../db/database.ts';
import { beginSession } from '../../db/session.ts';
import { SqliteStore } from '../../db/store.ts';
import { log } from '../../log.ts';
import { reading, zone } from '../utils/conductor.ts';

/**
 * The data survives changes to the data model. Each test changes src/db/schema.ts the way a developer
 * would, lets the real drizzle-kit generate the migration (`npm run db:generate`), and applies it with the
 * real openDatabase() to a database filled by the app's own write path. Every row of every table must come
 * through, the app must load the same state, and the views, triggers and references must still hold.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DRIZZLE_KIT = join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');
const run = promisify(execFile);

const T0 = new Date('2026-07-01T11:00:00.000Z');
const T = (min: number): Date => new Date(T0.getTime() + min * 60_000);
const config: ConductorConfig = {
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones: [zone({ name: 'Front' }), zone({ station: 2, name: 'Back' })],
};

type Rows = Record<string, Record<string, unknown>[]>;

/** Every row of every table, in rowid order (the copy in a table rebuild keeps that order). */
const snapshot = (path: string): Rows => {
  const client = new DatabaseSync(path, { readOnly: true });
  const tables = client
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY name`)
    .all() as { name: string }[];
  const rows = Object.fromEntries(tables.map(({ name }) => [name, client.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
  client.close();
  return rows;
};

/** `after` holds every row of `before` (new columns aside; renamed columns under their new name). */
const expectPreserved = (before: Rows, after: Rows, renamed: Record<string, Record<string, string>> = {}): void => {
  for (const [table, rows] of Object.entries(before)) {
    const names = renamed[table] ?? {};
    const projected = (after[table] ?? []).map((row) => Object.fromEntries(Object.keys(rows[0] ?? {}).map((col) => [col, row[names[col] ?? col]])));
    expect(projected, table).toEqual(rows);
  }
};

/** Fills a database the way a running conductor does, and leaves it as a crash would. */
const fillLikeTheService = (path: string): void => {
  const db = openDatabase(path);
  const session = beginSession(db, { config, mode: 'continuous', now: () => T0 });
  const { store, audit } = session;
  audit.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });

  const seq = (id: string, deviceId: string, at: Date): PendingSequence => ({
    id,
    deviceId,
    waves: [[{ station: 1, runTime: 8 }, { station: 2, runTime: 4 }], [{ station: 1, runTime: 8 }]],
    soakMinutes: 20,
    createdAt: at,
    nextWave: 0,
    dueAt: at,
    attempts: 0,
  });
  const why = [{ zoneKey: 'dev1:1', zoneName: 'Front', thresholdPct: 30, targetPct: 40, requestedMinutes: 16, moisturePct: 24, readingAt: T(-3), detail: 'dry' }];

  const done = seq('done-0000', 'dev1', T0); // completed
  store.sequenceStarted(done, why);
  store.waveSending(done, 0, T0);
  store.waveDelivered(done, 0, 'event', T0, T(32));
  store.waveSending(done, 1, T(32));
  store.waveDelivered(done, 1, 'unconfirmed', T(32), undefined);
  store.sequenceCompleted(done, T(32));
  audit.record('sequence.completed', { sequence: done.id, device: 'dev1' });

  const gone = seq('gone-0000', 'dev2', T(60)); // abandoned after a failed attempt
  store.sequenceStarted(gone, []);
  store.waveFailed(gone, 0);
  store.sequenceAbandoned(gone, T(90), 'gave up');

  const crashed = seq('mid-send-0000', 'dev1', T(300)); // in flight when the process died
  store.sequenceStarted(crashed, why);
  store.waveDelivered(crashed, 0, 'status', T(300), T(332));
  store.waveSending(crashed, 1, T(332));

  store.saveAlerts({ 'battery:sensor:s1': { state: 'low', since: T0.toISOString() }, 'device:dev2': { state: 'offline', since: T(60).toISOString() } });
  store.saveZoneSpells([{ zoneKey: 'dev1:1', drySince: T(290) }, { zoneKey: 'dev1:2', noDataSince: T(200) }], T(330));
  store.recordReadings([reading('s1', 24, { at: T(-3), batteryPct: 15, temperatureC: 21.5 }), reading('s2', 40, { at: T(-2) })], T0);
  for (let i = 0; i < 20; i++) audit.record('zone.decision', { zone: 'dev1:1', reason: i % 2 ? 'moist' : 'dry', detail: `poll ${i}` });
  session.heartbeat();
  db.$client.close(); // no end(): as after a crash
};

const loadedState = (path: string) => {
  const db = openDatabase(path, { readOnly: true });
  const state = new SqliteStore(db).loadState(T(340), 0, { repair: false });
  db.$client.close();
  return state;
};

// Each test runs drizzle-kit (about 2 s, more when the whole suite runs in parallel).
describe('migrations after data model changes keep the data', { timeout: 60_000 }, () => {
  let dir: string;
  let schema: string;
  let dbPath: string;

  beforeEach(async () => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), 'conductor-model-'));
    // A copy of the project's schema and migrations that drizzle-kit can work on.
    await symlink(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    await cp(join(ROOT, 'src', 'db', 'schema.ts'), join(dir, 'schema.ts'));
    await cp(MIGRATIONS_FOLDER, join(dir, 'drizzle'), { recursive: true });
    schema = await readFile(join(dir, 'schema.ts'), 'utf8');
    dbPath = join(dir, 'conductor.db');
    fillLikeTheService(dbPath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Edits the schema copy like a developer would (each `find` must be there). */
  const change = async (...edits: [find: string, replace: string][]): Promise<void> => {
    for (const [find, replace] of edits) {
      expect(schema, `schema.ts should contain: ${find}`).toContain(find);
      schema = schema.replace(find, replace);
    }
    await writeFile(join(dir, 'schema.ts'), schema);
  };

  /** `npm run db:generate`: returns the new migration's folder name and SQL. */
  const generate = async (name: string, hints?: unknown[]): Promise<{ folder: string; sql: string }> => {
    const args = [DRIZZLE_KIT, 'generate', '--dialect', 'sqlite', '--schema', 'schema.ts', '--out', 'drizzle', '--name', name, '--output', 'json'];
    if (hints) args.push('--hints', JSON.stringify(hints));
    const { stdout } = await run(process.execPath, args, { cwd: dir });
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { status: string; migration_path?: string };
    expect(result.status, stdout).toBe('ok');
    const folder = (await readdir(join(dir, 'drizzle'))).find((f) => f.endsWith(`_${name}`)) ?? '';
    return { folder, sql: await readFile(join(dir, 'drizzle', folder, 'migration.sql'), 'utf8') };
  };

  /** Starts the conductor on the database with the new migrations, and checks everything came through. */
  const upgradeAndCheck = (folder: string, renamed: Record<string, Record<string, string>> = {}) => {
    const before = snapshot(dbPath);
    const stateBefore = loadedState(dbPath);

    const db = openDatabase(dbPath, { migrationsFolder: join(dir, 'drizzle') });
    const client = db.$client;
    expect(pendingMigrations(client, join(dir, 'drizzle'))).toEqual([]);
    expect(client.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The app-owned views and triggers are back and working.
    expect(() => client.exec('UPDATE zone_watering SET minutes = 0')).toThrow(/append-only/);
    expect(() => client.exec(`UPDATE audit_event SET type = 'x'`)).toThrow(/append-only/);
    expect(client.prepare('SELECT count(*) AS n FROM sequence_result').get()).toEqual({ n: 3 });
    db.$client.close();

    const after = snapshot(dbPath);
    expectPreserved(before, after, renamed);
    // A copy from before the upgrade, with every row.
    expect(snapshot(`${dbPath}.before-${folder}`)).toEqual(before);
    return { before, after, stateBefore };
  };

  it('the harness sees no change in the unchanged model', async () => {
    const { stdout } = await run(process.execPath, [DRIZZLE_KIT, 'generate', '--dialect', 'sqlite', '--schema', 'schema.ts', '--out', 'drizzle', '--output', 'json'], { cwd: dir });
    expect(JSON.parse(stdout.trim())).toEqual({ status: 'no_changes', dialect: 'sqlite' });
  });

  it('adding a nullable column', async () => {
    await change(["    abandonReason: text('abandon_reason'),", "    abandonReason: text('abandon_reason'),\n    note: text('note'),"]);
    const { folder, sql } = await generate('add_note');
    expect(sql).toContain('ALTER TABLE `watering_sequence` ADD `note` text');

    const { after, stateBefore } = upgradeAndCheck(folder);

    expect(after.watering_sequence?.map((r) => r.note)).toEqual([null, null, null]);
    expect(loadedState(dbPath)).toEqual(stateBefore);
  });

  it('adding a NOT NULL column with a default', async () => {
    await change(["    failedAttempts: integer('failed_attempts').notNull().default(0),", "    failedAttempts: integer('failed_attempts').notNull().default(0),\n    channel: text('channel').notNull().default('websocket'),"]);
    const { folder, sql } = await generate('add_channel');
    expect(sql).toContain("DEFAULT 'websocket' NOT NULL");

    const { after, stateBefore } = upgradeAndCheck(folder);

    expect(new Set(after.sequence_wave?.map((r) => r.channel))).toEqual(new Set(['websocket']));
    expect(loadedState(dbPath)).toEqual(stateBefore);
  });

  it('changing a constraint of a parent table (rebuilt; its waves, stations, reasons and ledger links stay)', async () => {
    await change(['sql`${t.soakMinutes} >= 0`', 'sql`${t.soakMinutes} >= 0 AND ${t.soakMinutes} <= 240`']);
    const { folder, sql } = await generate('limit_soak');
    expect(sql).toContain('CREATE TABLE `__new_watering_sequence`');
    expect(sql).toContain('DROP TABLE `watering_sequence`');

    const { after, stateBefore } = upgradeAndCheck(folder);

    expect(after.sequence_wave).toHaveLength(6);
    expect(after.zone_watering?.filter((r) => r.sequence_id !== null)).toHaveLength(5); // 2 + 1 completed, 2 of the crashed one
    expect(loadedState(dbPath)).toEqual(stateBefore); // the crashed sequence is still there to resume
    expect(loadedState(dbPath).sequences).toEqual([expect.objectContaining({ id: 'mid-send-0000', inFlight: { wave: 1, since: T(332) } })]);
  });

  it('changing the watering ledger (rebuilt: still append-only, still linked to its waves)', async () => {
    await change(["    check('zone_watering_minutes_nonnegative', sql`${t.minutes} >= 0`),", "    check('zone_watering_minutes_nonnegative', sql`${t.minutes} >= 0 AND ${t.minutes} <= 240`),"]);
    const { folder, sql } = await generate('limit_ledger_minutes');
    expect(sql).toContain('CREATE TABLE `__new_zone_watering`');

    const { stateBefore } = upgradeAndCheck(folder);

    expect(loadedState(dbPath).history).toEqual(stateBefore.history); // cooldowns and the daily cap see the same runs
  });

  it('changing the audit trail (rebuilt: ids, payloads and derived columns intact; ids keep counting up)', async () => {
    await change(["    jsonCheck('audit_event_data_json', t.data),", "    jsonCheck('audit_event_data_json', t.data),\n    check('audit_event_type_not_empty', sql`length(${t.type}) > 0`),"]);
    const { folder, sql } = await generate('audit_type_check');
    expect(sql).toContain('CREATE TABLE `__new_audit_event`');

    const { before, after } = upgradeAndCheck(folder);

    expect(after.audit_event?.map((r) => [r.id, r.sequence_id])).toEqual(before.audit_event?.map((r) => [r.id, r.sequence_id]));
    const db = openDatabase(dbPath);
    const { lastInsertRowid } = db.$client.prepare(`INSERT INTO audit_event (ts, type) VALUES ('2026-07-02T00:00:00.000Z', 'service.started')`).run();
    expect(Number(lastInsertRowid)).toBeGreaterThan(Math.max(...(before.audit_event ?? []).map((r) => Number(r.id))));
    db.$client.close();
  });

  it('rebuilding several related tables in one migration', async () => {
    await change(
      ['sql`${t.soakMinutes} >= 0`', 'sql`${t.soakMinutes} >= 0 AND ${t.soakMinutes} <= 240`'],
      ["    check('sequence_wave_attempts_nonnegative', sql`${t.failedAttempts} >= 0`),", "    check('sequence_wave_attempts_nonnegative', sql`${t.failedAttempts} >= 0 AND ${t.failedAttempts} < 1000`),"],
      ["    check('wave_station_station_positive', sql`${t.station} >= 1`),", "    check('wave_station_station_positive', sql`${t.station} >= 1 AND ${t.station} <= 64`),"],
      ["    check('zone_watering_minutes_nonnegative', sql`${t.minutes} >= 0`),", "    check('zone_watering_minutes_nonnegative', sql`${t.minutes} >= 0 AND ${t.minutes} <= 240`),"],
    );
    const { folder, sql } = await generate('tighten_sequences');
    for (const table of ['watering_sequence', 'sequence_wave', 'wave_station', 'zone_watering']) expect(sql).toContain(`CREATE TABLE \`__new_${table}\``);

    const { stateBefore } = upgradeAndCheck(folder);

    expect(loadedState(dbPath)).toEqual(stateBefore);
  });

  it('renaming a column (with drizzle-kit\'s rename hint)', async () => {
    await change(["    temperatureC: real('temperature_c'),", "    temperatureC: real('soil_temperature_c'),"]);
    const { folder, sql } = await generate('rename_temperature', [
      { type: 'rename', kind: 'column', from: ['public', 'sensor_reading', 'temperature_c'], to: ['public', 'sensor_reading', 'soil_temperature_c'] },
    ]);
    expect(sql).toContain('RENAME COLUMN `temperature_c` TO `soil_temperature_c`');

    const { after } = upgradeAndCheck(folder, { sensor_reading: { temperature_c: 'soil_temperature_c' } });

    expect(after.sensor_reading?.map((r) => r.soil_temperature_c)).toEqual([21.5, null]);
  });

  it('adding a table and an index', async () => {
    await change(
      [
        '// ---------------------------------------------------------------------------------------------------\n// Views',
        `export const zoneNote = sqliteTable('zone_note', {
  id: integer('id').primaryKey(),
  zoneKey: text('zone_key').notNull().references(() => zone.zoneKey),
  note: text('note').notNull(),
});

// ---------------------------------------------------------------------------------------------------
// Views`,
      ],
      ["    index('sequence_zone_zone').on(t.zoneKey),", "    index('sequence_zone_zone').on(t.zoneKey),\n    index('sequence_zone_name').on(t.zoneName),"],
    );
    const { folder, sql } = await generate('zone_notes');
    expect(sql).toContain('CREATE TABLE `zone_note`');

    const { stateBefore } = upgradeAndCheck(folder);

    expect(loadedState(dbPath)).toEqual(stateBefore);
  });

  it('a change SQLite cannot apply (NOT NULL without a default) fails safely: nothing changes, and the fixed migration then applies', async () => {
    await change(["    abandonReason: text('abandon_reason'),", "    abandonReason: text('abandon_reason'),\n    note: text('note').notNull(),"]);
    const { folder } = await generate('add_required_note');
    const before = snapshot(dbPath);

    expect(() => openDatabase(dbPath, { migrationsFolder: join(dir, 'drizzle') })).toThrow(
      new RegExp(`upgrading the database failed, nothing was changed \\(Cannot add a NOT NULL column with default value NULL\\).*A copy from before the upgrade is at .*before-${folder}`),
    );

    expect(snapshot(dbPath)).toEqual(before);
    expect(existsSync(`${dbPath}.before-${folder}`)).toBe(true);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(check.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('pending_sequence', 'sequence_result', 'zone_watering_no_update', 'audit_event_no_update')`).get()).toEqual({ n: 4 });
    check.close();

    // The fix: delete the migration that never ran, give the column a default, generate again.
    await rm(join(dir, 'drizzle', folder), { recursive: true });
    await change(["    note: text('note').notNull(),", "    note: text('note').notNull().default(''),"]);
    const fixed = await generate('add_required_note_fixed');
    const { after } = upgradeAndCheck(fixed.folder);
    expect(after.watering_sequence?.map((r) => r.note)).toEqual(['', '', '']);
  });
});
