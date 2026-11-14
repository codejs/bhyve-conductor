import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Applies Prisma's migrations (prisma/migrations/<name>/migration.sql) at startup, keeping the data.
 *
 * Prisma's own `migrate deploy` needs its native engine, which isn't on the Raspberry Pi, and on SQLite it
 * runs each migration without a transaction: a failure halfway leaves the database half-migrated. This
 * runner applies all pending migrations in ONE transaction with foreign keys off:
 *
 *  - Prisma changes most SQLite tables by rebuilding them ("RedefineTables": copy, DROP TABLE, rename). With
 *    foreign keys on, that DROP deletes the rows first and ON DELETE CASCADE empties the child tables.
 *    The `PRAGMA foreign_keys=OFF` Prisma writes into the migration does nothing inside a transaction, and
 *    SQLite can't change it there, so it is switched off here, around the transaction.
 *  - Before COMMIT, `PRAGMA foreign_key_check` must come back clean; otherwise everything rolls back.
 *
 * It keeps Prisma's bookkeeping (`_prisma_migrations`, same table, checksums and columns), so Prisma's tools
 * see the same history (`prisma migrate status` shows the database up to date).
 */

/** prisma/migrations, from both src/db and dist/db. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

export const MIGRATIONS_TABLE = '_prisma_migrations';

/** Prisma's own definition of its bookkeeping table for SQLite. */
const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

export interface MigrationFile {
  /** The folder name, e.g. "20261115093000_init". */
  name: string;
  sql: string;
  /** SHA-256 of migration.sql, as Prisma computes it. */
  checksum: string;
}

/** The migrations in `folder`, in the order they apply (folder-name order, like Prisma). */
export const readMigrations = (folder: string = MIGRATIONS_FOLDER): MigrationFile[] =>
  (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [])
    .filter((e) => e.isDirectory() && existsSync(join(folder, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(folder, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });

const hasMigrationsTable = (client: DatabaseSync): boolean =>
  client.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(MIGRATIONS_TABLE) !== undefined;

/** Migrations recorded as applied (finished, not rolled back), with their checksums. */
export const appliedMigrations = (client: DatabaseSync): { name: string; checksum: string }[] =>
  hasMigrationsTable(client)
    ? (client
        .prepare(`SELECT migration_name AS name, checksum FROM "${MIGRATIONS_TABLE}" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name`)
        .all() as { name: string; checksum: string }[])
    : [];

/** Migrations a Prisma tool started but never finished (possible only if one was applied outside this app). */
export const failedMigrations = (client: DatabaseSync): string[] =>
  hasMigrationsTable(client)
    ? (client.prepare(`SELECT migration_name AS name FROM "${MIGRATIONS_TABLE}" WHERE finished_at IS NULL AND rolled_back_at IS NULL`).all() as { name: string }[]).map((r) => r.name)
    : [];

/** Migrations in `folder` not applied yet, in order. */
export const pendingMigrations = (client: DatabaseSync, folder: string = MIGRATIONS_FOLDER): MigrationFile[] => {
  const applied = new Set(appliedMigrations(client).map((m) => m.name));
  return readMigrations(folder).filter((m) => !applied.has(m.name));
};

/** Applied migrations whose file changed since (Prisma reports these as "modified after applied"). */
export const editedMigrations = (client: DatabaseSync, folder: string = MIGRATIONS_FOLDER): string[] => {
  const files = new Map(readMigrations(folder).map((m) => [m.name, m.checksum]));
  return appliedMigrations(client)
    .filter((m) => files.has(m.name) && files.get(m.name) !== m.checksum)
    .map((m) => m.name);
};

/** SQLite's message for an error (node:sqlite's own, without wrapping). */
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Applies `migrations` in one transaction (see above). Throws, with everything rolled back, if one fails or
 * leaves rows pointing at nothing.
 */
export const applyMigrations = (client: DatabaseSync, migrations: readonly MigrationFile[], now: () => Date = () => new Date()): void => {
  if (migrations.length === 0) return;
  client.exec('PRAGMA foreign_keys = OFF');
  try {
    client.exec('BEGIN IMMEDIATE');
    try {
      client.exec(MIGRATIONS_TABLE_DDL);
      const record = client.prepare(
        `INSERT INTO "${MIGRATIONS_TABLE}" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
      );
      for (const m of migrations) {
        const startedAt = now().toISOString();
        try {
          client.exec(m.sql);
        } catch (err) {
          throw new Error(`migration ${m.name} failed: ${reasonOf(err)}`, { cause: err });
        }
        record.run(randomUUID(), m.checksum, now().toISOString(), m.name, startedAt);
      }
      const broken = client.prepare('PRAGMA foreign_key_check').all() as { table: string; parent: string }[];
      if (broken.length > 0) {
        const where = [...new Set(broken.map((v) => `${v.table} → ${v.parent}`))].join(', ');
        throw new Error(`${broken.length} row(s) would reference missing rows (${where})`);
      }
      client.exec('COMMIT');
    } catch (err) {
      if (client.isTransaction) client.exec('ROLLBACK');
      throw err;
    }
  } finally {
    client.exec('PRAGMA foreign_keys = ON');
  }
};
