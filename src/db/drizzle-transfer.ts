import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../log.ts';
import { APPLICATION_ID, checkOwner, connect } from './connection.ts';
import { applyMigrations, readMigrations, MIGRATIONS_FOLDER } from './migrate.ts';

/**
 * One-time conversion of a database written by the drizzle-based version into the Prisma-managed format.
 *
 * Tables and columns have the same names and values in both versions; what differs is the DDL (drizzle's
 * CHECK constraints, generated columns, views and triggers, its `__drizzle_migrations` table). Rather than
 * altering the old file in place, the conversion builds a new file from the Prisma migrations and copies
 * every row into it, then swaps the files:
 *
 *  1. The old file is checkpointed (its WAL folded in). If another process still has it open (the old
 *     service still running), nothing is done: renaming the file under it would lose its later writes.
 *  2. `<file>.prisma-transfer` is built from the migrations, and all rows are copied in one transaction
 *     with foreign keys off. Row counts and contents are compared table by table, both ways, and
 *     `PRAGMA foreign_key_check` must be clean, or nothing is committed.
 *  3. The old file becomes `<file>.drizzle-backup`, the new one takes its name.
 *
 * A crash at any point leaves either the old file in place (step 1–2; the half-built file is removed at the
 * next start) or the finished new file next to the backup (between the two renames; the next start finishes
 * the swap). Values that were generated columns in the old file (audit_event.device_id/zone_key/sequence_id,
 * open_alert.kind) are copied as plain values.
 */

/** Every table of the drizzle-based version, in an order where parents come first, with its columns. */
export const DRIZZLE_TABLES: Readonly<Record<string, readonly string[]>> = {
  service_run: ['id', 'started_at', 'mode', 'dry_run', 'pid', 'config_hash', 'config_json', 'heartbeat_at', 'stopped_at', 'stop_reason'],
  zone: ['zone_key', 'device_id', 'station', 'name', 'first_seen_at', 'last_seen_at'],
  watering_sequence: ['id', 'service_run_id', 'device_id', 'soak_minutes', 'created_at', 'status', 'ended_at', 'abandon_reason'],
  sequence_zone: [
    'sequence_id',
    'zone_key',
    'zone_name',
    'moisture_pct',
    'reading_at',
    'threshold_pct',
    'target_pct',
    'requested_minutes',
    'allowance_minutes',
    'budget_inches',
    'budget_json',
    'detail',
  ],
  sequence_wave: ['sequence_id', 'wave_index', 'status', 'due_at', 'sent_at', 'delivery', 'failed_attempts'],
  wave_station: ['sequence_id', 'wave_index', 'station', 'run_minutes'],
  zone_watering: ['id', 'zone_key', 'started_at', 'minutes', 'sequence_id', 'wave_index'],
  open_alert: ['alert_key', 'kind', 'state', 'since'],
  zone_state: ['zone_key', 'dry_since', 'no_data_since', 'evaluated_at'],
  audit_event: ['id', 'ts', 'type', 'service_run_id', 'data', 'device_id', 'zone_key', 'sequence_id'],
  sensor_reading: ['sensor_id', 'measured_at', 'polled_at', 'moisture_pct', 'temperature_c', 'battery_pct', 'online'],
};

const DRIZZLE_MIGRATIONS_TABLE = '__drizzle_migrations';

export interface DrizzleTransferResult {
  /** Where the old file is now. */
  backupPath: string;
  /** Rows copied, per table. */
  rows: Record<string, number>;
  /** The drizzle migrations the old file had applied. */
  drizzleMigrations: string[];
}

export const transferPathOf = (path: string): string => `${path}.prisma-transfer`;
const backupPathOf = (path: string): string => {
  const plain = `${path}.drizzle-backup`;
  return existsSync(plain) ? `${plain}-${Date.now()}` : plain;
};
const hasBackup = (path: string): boolean => readdirSync(dirname(path)).some((f) => f.startsWith(`${basename(path)}.drizzle-backup`));

const removeDatabaseFile = (path: string): void => {
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true });
};

/** True for a conductor database written by the drizzle-based version. */
export const isDrizzleDatabase = (path: string): boolean => {
  if (!existsSync(path)) return false;
  let client: DatabaseSync | undefined;
  try {
    // Read-write if possible, without writing: a read-only connection to a WAL database leaves its -wal and
    // -shm files behind, which would look like another process still using it.
    try {
      client = new DatabaseSync(path);
    } catch {
      client = new DatabaseSync(path, { readOnly: true });
    }
    const appId = (client.prepare('PRAGMA application_id').get() as { application_id: number } | undefined)?.application_id;
    const drizzle = client.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(DRIZZLE_MIGRATIONS_TABLE);
    return appId === APPLICATION_ID && drizzle !== undefined;
  } catch {
    return false; // not a database we can read: openDatabase reports it
  } finally {
    client?.close();
  }
};

/**
 * Finishes or cleans up a conversion interrupted by a crash: a finished new file next to the backup without
 * the original in place takes its name; a half-built one next to the original is removed.
 */
export const recoverInterruptedTransfer = (path: string): void => {
  const tmp = transferPathOf(path);
  if (!existsSync(tmp)) return;
  if (existsSync(path)) {
    log.warn(`Removing ${tmp}, left by an interrupted conversion of ${path}; it will be converted again`);
    removeDatabaseFile(tmp);
    return;
  }
  if (!hasBackup(path)) {
    throw new Error(`${path} is missing and ${tmp} is there without a backup of the original; check the files before starting`);
  }
  renameSync(tmp, path);
  log.warn(`Finished an interrupted conversion: ${tmp} is now ${path}`);
};

const quoteList = (cols: readonly string[], prefix = ''): string => cols.map((c) => `${prefix}"${c}"`).join(', ');

/** Converts the drizzle-based database at `path` (see above). Throws, leaving the old file as it was, if anything is off. */
export const transferFromDrizzle = (path: string, options: { migrationsFolder?: string; now?: () => Date } = {}): DrizzleTransferResult => {
  // 1. Fold the WAL into the file; if the files stay, someone else has it open.
  const old = new DatabaseSync(path);
  let drizzleMigrations: string[];
  try {
    old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const tables = new Set((old.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name));
    const missing = Object.keys(DRIZZLE_TABLES).filter((t) => !tables.has(t));
    if (missing.length > 0) throw new Error(`${path} looks like a drizzle-era database but has no ${missing.join(', ')}`);
    drizzleMigrations = (old.prepare(`SELECT coalesce(name, hash) AS name FROM ${DRIZZLE_MIGRATIONS_TABLE} ORDER BY id`).all() as { name: string }[]).map((r) => r.name);
  } finally {
    old.close();
  }
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    throw new Error(`${path} is still open in another process (is the previous version of the conductor still running?); stop it, then start again`);
  }

  // 2. Build the new file and copy every row.
  const tmp = transferPathOf(path);
  removeDatabaseFile(tmp);
  const rows: Record<string, number> = {};
  const next = connect(tmp);
  try {
    checkOwner(next, tmp, false);
    applyMigrations(next, readMigrations(options.migrationsFolder ?? MIGRATIONS_FOLDER), options.now);
    next.prepare('ATTACH DATABASE ? AS old').run(path);
    next.exec('PRAGMA foreign_keys = OFF');
    next.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, cols] of Object.entries(DRIZZLE_TABLES)) {
        next.exec(`INSERT INTO main."${table}" (${quoteList(cols)}) SELECT ${quoteList(cols)} FROM old."${table}"`);
        const count = (t: string) => (next.prepare(`SELECT count(*) AS n FROM ${t}."${table}"`).get() as { n: number }).n;
        const differs = (a: string, b: string) =>
          next.prepare(`SELECT count(*) AS n FROM (SELECT ${quoteList(cols)} FROM ${a}."${table}" EXCEPT SELECT ${quoteList(cols)} FROM ${b}."${table}")`).get() as {
            n: number;
          };
        if (count('main') !== count('old') || differs('main', 'old').n > 0 || differs('old', 'main').n > 0) {
          throw new Error(`the copy of ${table} does not match the original`);
        }
        rows[table] = count('main');
      }
      // Audit ids are never reused: carry over the old counter (it can be above the highest id left after retention).
      const oldSeq = next.prepare(`SELECT seq FROM old.sqlite_sequence WHERE name = 'audit_event'`).get() as { seq: number } | undefined;
      if (oldSeq) next.prepare(`UPDATE main.sqlite_sequence SET seq = max(seq, ?) WHERE name = 'audit_event'`).run(oldSeq.seq);
      const broken = next.prepare('PRAGMA main.foreign_key_check').all();
      if (broken.length > 0) throw new Error(`${broken.length} copied row(s) reference missing rows`);
      next.exec('COMMIT');
    } catch (err) {
      if (next.isTransaction) next.exec('ROLLBACK');
      throw err;
    } finally {
      next.exec('PRAGMA foreign_keys = ON');
    }
    next.exec('DETACH DATABASE old');
    const integrity = next.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error(`the converted database failed its integrity check: ${integrity.integrity_check}`);
  } catch (err) {
    next.close();
    removeDatabaseFile(tmp);
    throw new Error(`${path}: converting the database to the new storage format failed, nothing was changed (${err instanceof Error ? err.message : String(err)})`, {
      cause: err,
    });
  }
  next.close();

  // 3. Swap.
  const backupPath = backupPathOf(path);
  renameSync(path, backupPath);
  renameSync(tmp, path);
  const total = Object.values(rows).reduce((a, b) => a + b, 0);
  log.info(`Converted ${path} to the new storage format (${total} rows); the original is kept as ${backupPath}`);
  return { backupPath, rows, drizzleMigrations };
};
