import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import type { PendingSequence } from '../../conductor/state.ts';
import { openDatabase } from '../../db/database.ts';
import { MIGRATIONS_FOLDER, pendingMigrations, SCHEMA_PATH } from '../../db/migrate.ts';
import { createMigration, diffDatabaseToSchema } from '../../db/schema-engine.ts';
import { beginSession } from '../../db/session.ts';
import { SqliteStore } from '../../db/store.ts';
import { log } from '../../log.ts';
import { reading, zone } from '../utils/conductor.ts';

/**
 * The data survives changes to the data model. Each test changes prisma/schema.prisma the way a developer
 * would, lets Prisma's schema engine write the migration (`npm run db:migration`, the same SQL as
 * `prisma migrate dev`), and applies it with the app's migration runner to a database filled by the app's
 * own write path. Every row of every table must come through, the database must then match the new model,
 * references and integrity must hold, and the app must load the same state.
 */

const T0 = new Date('2026-07-01T11:00:00.000Z');
const T = (min: number): Date => new Date(T0.getTime() + min * 60_000);
const SCHEMA = await readFile(SCHEMA_PATH, 'utf8');
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
  const client = new DatabaseSync(path);
  const tables = client
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '_prisma_migrations' ORDER BY name`)
    .all() as { name: string }[];
  const rows = Object.fromEntries(tables.map(({ name }) => [name, client.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
  client.close();
  return rows;
};

interface Expected {
  /** Columns renamed by the change, per table: old name → new name. */
  renamed?: Record<string, Record<string, string>>;
  /** Columns whose values the change is meant to alter (checked by the test itself), per table. */
  changed?: Record<string, string[]>;
}

/** `after` holds every row of `before` (new columns aside; renamed ones under their new name). */
const expectPreserved = (before: Rows, after: Rows, { renamed = {}, changed = {} }: Expected = {}): void => {
  for (const [table, rows] of Object.entries(before)) {
    const names = renamed[table] ?? {};
    const columns = Object.keys(rows[0] ?? {}).filter((c) => !(changed[table] ?? []).includes(c));
    const pick = (row: Record<string, unknown>, name: (c: string) => string) => Object.fromEntries(columns.map((c) => [c, row[name(c)]]));
    expect(
      (after[table] ?? []).map((row) => pick(row, (c) => names[c] ?? c)),
      table,
    ).toEqual(rows.map((row) => pick(row, (c) => c)));
  }
};

/** Fills a database the way a running conductor does, and leaves it as a crash would. */
const fillLikeTheService = async (path: string): Promise<void> => {
  const db = openDatabase(path);
  const session = await beginSession(db, { config, mode: 'continuous', now: () => T0 });
  const { store, audit } = session;
  audit.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });

  const seq = (id: string, deviceId: string, at: Date): PendingSequence => ({
    id,
    deviceId,
    waves: [
      [
        { station: 1, runTime: 8 },
        { station: 2, runTime: 4 },
      ],
      [{ station: 1, runTime: 8 }],
    ],
    soakMinutes: 20,
    createdAt: at,
    nextWave: 0,
    dueAt: at,
    attempts: 0,
  });
  const why = [{ zoneKey: 'dev1:1', zoneName: 'Front', thresholdPct: 30, targetPct: 40, requestedMinutes: 16, moisturePct: 24, readingAt: T(-3), detail: 'dry' }];

  const done = seq('done-0000', 'dev1', T0); // completed
  await store.sequenceStarted(done, why);
  await store.waveSending(done, 0, T0);
  await store.waveDelivered(done, 0, 'event', T0, T(32));
  await store.waveSending(done, 1, T(32));
  await store.waveDelivered(done, 1, 'unconfirmed', T(32), undefined);
  await store.sequenceCompleted(done, T(32));
  audit.record('sequence.completed', { sequence: done.id, device: 'dev1' });

  const gone = seq('gone-0000', 'dev2', T(60)); // abandoned after a failed attempt
  await store.sequenceStarted(gone, []);
  await store.waveFailed(gone, 0);
  await store.sequenceAbandoned(gone, T(90), 'gave up');

  const crashed = seq('mid-send-0000', 'dev1', T(300)); // in flight when the process died
  await store.sequenceStarted(crashed, why);
  await store.waveDelivered(crashed, 0, 'status', T(300), T(332));
  await store.waveSending(crashed, 1, T(332));

  await store.saveAlerts({ 'battery:sensor:s1': { state: 'low', since: T0.toISOString() }, 'device:dev2': { state: 'offline', since: T(60).toISOString() } });
  await store.saveZoneSpells([{ zoneKey: 'dev1:1', drySince: T(290) }, { zoneKey: 'dev1:2', noDataSince: T(200) }], T(330));
  await store.recordReadings([reading('s1', 24, { at: T(-3), batteryPct: 15, temperatureC: 21.5 }), reading('s2', 40, { at: T(-2) })], T0);
  for (let i = 0; i < 20; i++) audit.record('zone.decision', { zone: 'dev1:1', reason: i % 2 ? 'moist' : 'dry', detail: `poll ${i}` });
  await session.heartbeat();
  await audit.flush();
  await db.close(); // no end(): as after a crash
};

const loadedState = async (path: string) => {
  const db = openDatabase(path, { readOnly: true });
  const state = await new SqliteStore(db).loadState(T(340), 0, { repair: false });
  await db.close();
  return state;
};

// Each test runs Prisma's schema engine a few times (WebAssembly): give it time when the suite runs in parallel.
describe('migrations after data model changes keep the data', { timeout: 60_000 }, () => {
  let dir: string;
  let migrations: string;
  let schema: string;
  let dbPath: string;

  beforeEach(async () => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), 'conductor-model-'));
    migrations = join(dir, 'migrations');
    await cp(MIGRATIONS_FOLDER, migrations, { recursive: true });
    schema = SCHEMA;
    dbPath = join(dir, 'conductor.db');
    await fillLikeTheService(dbPath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Edits the schema like a developer would (each `find` must be there). */
  const change = (...edits: [find: string, replace: string][]): void => {
    for (const [find, replace] of edits) {
      expect(schema, `schema.prisma should contain: ${find}`).toContain(find);
      schema = schema.replace(find, replace);
    }
  };

  /** `npm run db:migration -- <name>`: the new migration's folder and SQL. */
  const generate = async (name: string): Promise<{ folder: string; sql: string }> => {
    const created = await createMigration(migrations, schema, name, new Date('2099-01-01T00:00:00.000Z'));
    if (!created) throw new Error('the schema change produced no migration');
    return created;
  };

  /** Starts the conductor on the database with the new migration, and checks everything came through. */
  const upgradeAndCheck = async (folder: string, expected: Expected = {}) => {
    const before = snapshot(dbPath);
    const stateBefore = await loadedState(dbPath);

    const db = openDatabase(dbPath, { migrationsFolder: migrations });
    const client = db.sqlite;
    expect(pendingMigrations(client, migrations)).toEqual([]);
    expect(client.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(await diffDatabaseToSchema(client, schema)).toBe(''); // the database is the new model
    await db.close();

    const after = snapshot(dbPath);
    expectPreserved(before, after, expected);
    expect(snapshot(`${dbPath}.before-${folder}`)).toEqual(before); // a copy from before the upgrade, with every row
    return { before, after, stateBefore };
  };

  it('adding a nullable column', async () => {
    change(['  abandonReason String?   @map("abandon_reason")', '  abandonReason String?   @map("abandon_reason")\n  note          String?']);
    const { folder, sql } = await generate('add_note');
    expect(sql).toContain('ALTER TABLE "watering_sequence" ADD COLUMN "note" TEXT;');

    const { after, stateBefore } = await upgradeAndCheck(folder);

    expect(after.watering_sequence?.map((r) => r.note)).toEqual([null, null, null]);
    expect(await loadedState(dbPath)).toEqual(stateBefore);
  });

  it('adding a required column with a default', async () => {
    change(['  failedAttempts Int       @default(0) @map("failed_attempts")', '  failedAttempts Int       @default(0) @map("failed_attempts")\n  channel        String    @default("websocket")']);
    const { folder, sql } = await generate('add_channel');
    expect(sql).toMatch(/"channel" TEXT NOT NULL DEFAULT 'websocket'/);

    const { after, stateBefore } = await upgradeAndCheck(folder);

    expect(new Set(after.sequence_wave?.map((r) => r.channel))).toEqual(new Set(['websocket']));
    expect(await loadedState(dbPath)).toEqual(stateBefore);
  });

  it('changing a parent table: rebuilt, and its waves, stations, reasons and ledger links stay (no cascade)', async () => {
    change(['  soakMinutes   Float     @map("soak_minutes")', '  soakMinutes   Float     @default(0) @map("soak_minutes")']);
    const { folder, sql } = await generate('default_soak');
    expect(sql).toContain('-- RedefineTables');
    expect(sql).toContain('DROP TABLE "watering_sequence";'); // with foreign keys on, this would cascade into every child row

    const { after, stateBefore } = await upgradeAndCheck(folder);

    expect(after.sequence_wave).toHaveLength(6);
    expect(after.wave_station).toHaveLength(9);
    expect(after.sequence_zone).toHaveLength(2);
    expect(after.zone_watering?.filter((r) => r.sequence_id !== null)).toHaveLength(5); // 2 + 1 completed, 2 of the crashed one
    expect(await loadedState(dbPath)).toEqual(stateBefore); // the crashed sequence is still there to resume
    expect((await loadedState(dbPath)).sequences).toEqual([expect.objectContaining({ id: 'mid-send-0000', inFlight: { wave: 1, since: T(332) } })]);
  });

  it('changing the watering ledger: rebuilt, still linked to its waves', async () => {
    change(['  minutes    Float\n', '  minutes    Float    @default(0)\n']);
    const { folder, sql } = await generate('default_ledger_minutes');
    expect(sql).toContain('DROP TABLE "zone_watering";');

    const { stateBefore } = await upgradeAndCheck(folder);

    expect((await loadedState(dbPath)).history).toEqual(stateBefore.history); // cooldowns and the daily cap see the same runs
  });

  it('changing the audit trail: rebuilt, with ids and payloads intact and ids counting up from where they were', async () => {
    change(['  type         String\n', '  type         String   @default("unknown")\n']);
    const { folder, sql } = await generate('default_audit_type');
    expect(sql).toContain('DROP TABLE "audit_event";');

    const { before, after } = await upgradeAndCheck(folder);

    expect(after.audit_event?.map((r) => [r.id, r.data])).toEqual(before.audit_event?.map((r) => [r.id, r.data]));
    const db = openDatabase(dbPath);
    const { id } = await db.prisma.auditEvent.create({ data: { ts: T(400), type: 'service.started', data: {} }, select: { id: true } });
    expect(id).toBeGreaterThan(Math.max(...(before.audit_event ?? []).map((r) => Number(r.id))));
    await db.close();
  });

  it('rebuilding several related tables in one migration', async () => {
    change(
      ['  soakMinutes   Float     @map("soak_minutes")', '  soakMinutes   Float     @default(0) @map("soak_minutes")'],
      ['  status         String    @default("pending")', '  status         String    @default("waiting")'],
      ['  runMinutes Float  @map("run_minutes")', '  runMinutes Float  @default(1) @map("run_minutes")'],
      ['  minutes    Float\n', '  minutes    Float    @default(0)\n'],
    );
    const { folder, sql } = await generate('defaults_everywhere');
    for (const table of ['watering_sequence', 'sequence_wave', 'wave_station', 'zone_watering']) expect(sql).toContain(`DROP TABLE "${table}";`);

    const { stateBefore } = await upgradeAndCheck(folder);

    expect(await loadedState(dbPath)).toEqual(stateBefore);
  });

  it('adding a table with a relation, and an index', async () => {
    change(
      ['  sequenceZones SequenceZone[]\n', '  sequenceZones SequenceZone[]\n  notes         ZoneNote[]\n'],
      ['  @@index([zoneKey], map: "sequence_zone_zone")', '  @@index([zoneKey], map: "sequence_zone_zone")\n  @@index([zoneName], map: "sequence_zone_name")'],
    );
    schema += `
model ZoneNote {
  id      Int    @id @default(autoincrement())
  zoneKey String @map("zone_key")
  note    String
  zone    Zone   @relation(fields: [zoneKey], references: [zoneKey])

  @@map("zone_note")
}
`;
    const { folder, sql } = await generate('zone_notes');
    expect(sql).toContain('CREATE TABLE "zone_note"');

    const { stateBefore } = await upgradeAndCheck(folder);

    expect(await loadedState(dbPath)).toEqual(stateBefore);
  });

  it('renaming a column: Prisma writes drop-and-add, so the migration is edited to a rename, and the data moves', async () => {
    change(['  temperatureC Float?   @map("temperature_c")', '  temperatureC Float?   @map("soil_temperature_c")']);
    const { folder, sql } = await generate('rename_temperature');
    // Prisma can't tell a rename from drop + add: as generated, the old values would be lost.
    expect(sql).not.toMatch(/"temperature_c"[^;]*INTO|RENAME COLUMN/);
    // The documented fix (docs/sqlite-storage.md): replace the migration with a rename.
    await writeFile(join(migrations, folder, 'migration.sql'), 'ALTER TABLE "sensor_reading" RENAME COLUMN "temperature_c" TO "soil_temperature_c";\n');

    const { after } = await upgradeAndCheck(folder, { renamed: { sensor_reading: { temperature_c: 'soil_temperature_c' } } });

    expect(after.sensor_reading?.map((r) => r.soil_temperature_c)).toEqual([21.5, null]);
  });

  it('a change the data can\'t take (a required column without a default) fails safely: nothing changes, and the fixed migration then applies', async () => {
    change(['  pid         Int?\n', '  pid         Int\n']);
    const { folder, sql } = await generate('require_pid');
    expect(sql).toContain('DROP TABLE "service_run";');
    const before = snapshot(dbPath);

    expect(() => openDatabase(dbPath, { migrationsFolder: migrations })).toThrow(
      new RegExp(`upgrading the database failed, nothing was changed \\(migration ${folder} failed: NOT NULL constraint failed: new_service_run\\.pid\\).*A copy from before the upgrade is at`),
    );
    expect(snapshot(dbPath)).toEqual(before);

    // The fix: delete the migration that never ran, give the column a default, generate again.
    await rm(join(migrations, folder), { recursive: true });
    schema = schema.replace('  pid         Int\n', '  pid         Int       @default(0)\n');
    const fixed = await generate('require_pid_with_default');
    const { after } = await upgradeAndCheck(fixed.folder, { changed: { service_run: ['pid'] } });
    expect(after.service_run?.map((r) => r.pid)).toEqual([0]); // the missing value took the new default
  });
});
