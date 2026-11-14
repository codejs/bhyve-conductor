import { DatabaseSync } from 'node:sqlite';

/** Connections to the conductor's database file, shared by database.ts and drizzle-transfer.ts. */

/** 'BHyC', stored in the file header so a conductor database can be told apart from any other SQLite file. */
export const APPLICATION_ID = 0x42487943;

const pragma = (client: DatabaseSync, name: string): unknown => {
  const row = client.prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : undefined;
};

export const isFile = (path: string): boolean => path !== '' && path !== ':memory:' && !path.startsWith('file:');

/** Refuses a file that belongs to something else; marks a new one as the conductor's. */
export const checkOwner = (client: DatabaseSync, path: string, readOnly: boolean): void => {
  const appId = pragma(client, 'application_id');
  if (appId === APPLICATION_ID) return;
  const tables = client
    .prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    .get() as { n: number };
  // A file with tables but without our id was not created here: don't add tables to someone else's database.
  if (appId !== 0 || tables.n > 0 || readOnly) {
    throw new Error(`${path} is not a bhyve-conductor database (application_id ${String(appId)}, ${tables.n} table(s))`);
  }
  client.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
};

/** Opens a connection with the conductor's pragmas (WAL, full sync, foreign keys, busy timeout). */
export const connect = (path: string, options: { readOnly?: boolean; busyTimeoutMs?: number } = {}): DatabaseSync => {
  const readOnly = options.readOnly ?? false;
  const client = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: options.busyTimeoutMs ?? 5_000, readOnly });
  if (!readOnly) {
    // Readers (`npm run audit`) never block the service. Persistent; can't be changed inside a transaction.
    client.exec('PRAGMA journal_mode = WAL');
    // The in-flight marker must be on disk before a watering command is sent ("never water twice"). With the
    // default NORMAL, a power cut can drop the last commits in WAL mode. Per connection.
    client.exec('PRAGMA synchronous = FULL');
  }
  return client;
};
