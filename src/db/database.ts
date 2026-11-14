import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../log.ts';
import { NodeSqliteAdapterFactory } from './adapter.ts';
import { checkOwner, connect, isFile } from './connection.ts';
import { isDrizzleDatabase, recoverInterruptedTransfer, transferFromDrizzle, type DrizzleTransferResult } from './drizzle-transfer.ts';
import { PrismaClient } from './generated/client.ts';
import { appliedMigrations, applyMigrations, editedMigrations, failedMigrations, MIGRATIONS_FOLDER, pendingMigrations, readMigrations } from './migrate.ts';

/**
 * Opens the conductor's SQLite database (Prisma ORM over node:sqlite) and brings it up to date, keeping the
 * data:
 *
 *  1. A database of the drizzle-based version is converted once (drizzle-transfer.ts): every row is copied
 *     into a new file built from the Prisma migrations, and the old file is kept as `<file>.drizzle-backup`.
 *  2. A file that already holds data is copied to `<file>.before-<first pending migration>` before any
 *     migration runs (VACUUM INTO: a consistent snapshot).
 *  3. Pending migrations run in one transaction with foreign keys off (migrate.ts); a failure rolls back
 *     completely and the service refuses to start, saying why and where the copy is.
 *
 * One connection serves everything: node:sqlite is synchronous, and the driver adapter queues queries around
 * transactions. Needs no native module and no Prisma engine binary.
 */

export { MIGRATIONS_FOLDER };
export { APPLICATION_ID, checkOwner, connect, isFile } from './connection.ts';

export interface ConductorDb {
  prisma: PrismaClient;
  /** The same connection, for what Prisma doesn't do (pragmas, checks). */
  sqlite: DatabaseSync;
  /** Set when this open converted a database of the drizzle-based version. */
  transferred?: DrizzleTransferResult;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /** Default: prisma/migrations. */
  migrationsFolder?: string;
  /** How long to wait for another connection's write lock. Default 5 s. */
  busyTimeoutMs?: number;
  /** Only read (e.g. `npm run audit` next to the running service): no migrations, no writes. The file must exist. */
  readOnly?: boolean;
  /** Copy the file before upgrading it (default true; file databases that already hold data only). */
  backup?: boolean;
  /** The clock for migration bookkeeping (default: the system's). */
  now?: () => Date;
}

/** Copies the file before an upgrade; returns where the copy is. */
const backupBeforeUpgrade = (client: DatabaseSync, path: string, firstPending: string): string => {
  const target = `${path}.before-${firstPending}`;
  // A previous attempt at the same upgrade failed: keep the copy from before the first attempt.
  if (existsSync(target)) {
    log.warn(`Database backup ${target} already exists (an earlier upgrade attempt); keeping it`);
    return target;
  }
  client.prepare('VACUUM INTO ?').run(target);
  log.info(`Backed up ${path} to ${target} before upgrading its schema`);
  return target;
};

/** Applies pending migrations with a backup first; explains a failure. */
export const upgrade = (client: DatabaseSync, path: string, options: Pick<OpenDatabaseOptions, 'migrationsFolder' | 'backup' | 'now'> = {}): string[] => {
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const failed = failedMigrations(client);
  if (failed.length > 0) {
    throw new Error(`${path}: migration(s) ${failed.join(', ')} were started by a Prisma tool and never finished; resolve them with prisma migrate resolve`);
  }
  for (const name of editedMigrations(client, folder)) log.warn(`Migration ${name} was changed after it was applied to ${path}; the change is not applied`);
  const pending = pendingMigrations(client, folder);
  if (pending.length === 0) return [];
  const backup = appliedMigrations(client).length > 0 && isFile(path) && options.backup !== false ? backupBeforeUpgrade(client, path, pending[0]?.name ?? 'upgrade') : undefined;
  try {
    applyMigrations(client, pending, options.now);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${path}: upgrading the database failed, nothing was changed (${reason}). Pending: ${pending.map((m) => m.name).join(', ')}.` +
        (backup ? ` A copy from before the upgrade is at ${backup}.` : ''),
      { cause: err },
    );
  }
  log.info(`Database ${path}: applied ${pending.length} migration(s): ${pending.map((m) => m.name).join(', ')}`);
  return pending.map((m) => m.name);
};

/**
 * Opens (creating if needed) the database at `path` (':memory:' for tests and simulations) and brings it up
 * to date. Throws if the file belongs to something else or an upgrade fails.
 */
export const openDatabase = (path: string, options: OpenDatabaseOptions = {}): ConductorDb => {
  const readOnly = options.readOnly ?? false;
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (readOnly && isFile(path) && !existsSync(path)) {
    throw new Error(`${path} does not exist yet: it is created when the conductor starts (or with npm run db:migrate)`);
  }

  let transferred: DrizzleTransferResult | undefined;
  if (isFile(path) && !readOnly) {
    recoverInterruptedTransfer(path);
    if (existsSync(path) && isDrizzleDatabase(path)) transferred = transferFromDrizzle(path, { migrationsFolder: folder, ...(options.now ? { now: options.now } : {}) });
  } else if (readOnly && isFile(path) && isDrizzleDatabase(path)) {
    throw new Error(`${path} is from the previous storage version; start the conductor (or run npm run db:migrate) once to convert it`);
  }

  const client = connect(path, { readOnly, ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}) });
  try {
    checkOwner(client, path, readOnly);
    if (readOnly) {
      const pending = pendingMigrations(client, folder);
      if (pending.length > 0) log.warn(`${path} is not up to date (${pending.length} migration(s) pending); start the conductor or run npm run db:migrate`);
    } else {
      upgrade(client, path, options);
    }
  } catch (err) {
    client.close();
    throw err;
  }

  const prisma = new PrismaClient({ adapter: new NodeSqliteAdapterFactory(client) });
  return {
    prisma,
    sqlite: client,
    ...(transferred ? { transferred } : {}),
    close: async () => {
      await prisma.$disconnect();
      if (client.isOpen) client.close();
    },
  };
};

/** The migrations in a folder (re-exported for scripts). */
export { readMigrations };
