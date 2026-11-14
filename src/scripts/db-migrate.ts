/**
 * Creates the conductor database, or brings an existing one up to date (converting a database of the
 * drizzle-based version once), and lists the applied migrations. The service does the same at startup.
 *
 *   npm run db:migrate                 uses CONDUCTOR_DB (default .conductor.db)
 *   npm run db:migrate -- --file x.db  another file
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { MIGRATIONS_TABLE } from '../db/migrate.ts';

const { values } = parseArgs({ options: { file: { type: 'string' } } });
const file = values.file ?? loadConfig(['CONDUCTOR_DB']).CONDUCTOR_DB;

const db = openDatabase(file);
try {
  if (db.transferred) {
    const total = Object.values(db.transferred.rows).reduce((a, b) => a + b, 0);
    console.log(`Converted ${file} to the new storage format (${total} rows); the original is kept as ${db.transferred.backupPath}.`);
  }
  const applied = db.sqlite.prepare(`SELECT migration_name AS name, finished_at FROM "${MIGRATIONS_TABLE}" ORDER BY started_at, migration_name`).all() as {
    name: string;
    finished_at: string | null;
  }[];
  console.log(`${file} is up to date. Applied migrations:`);
  for (const m of applied) console.log(`  ${m.name}${m.finished_at ? `  (${m.finished_at})` : ''}`);
} finally {
  await db.close();
}
