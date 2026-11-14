/**
 * Creates the conductor database, or brings an existing one up to date, and lists the applied migrations.
 *
 *   npm run db:migrate                 uses CONDUCTOR_DB (default .conductor.db)
 *   npm run db:migrate -- --file x.db  another file
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';

const { values } = parseArgs({ options: { file: { type: 'string' } } });
const file = values.file ?? loadConfig(['CONDUCTOR_DB']).CONDUCTOR_DB;

const db = openDatabase(file);
try {
  const applied = db.$client.prepare('SELECT name, applied_at FROM __drizzle_migrations ORDER BY id').all() as {
    name: string;
    applied_at: string | null;
  }[];
  console.log(`${file} is up to date. Applied migrations:`);
  for (const m of applied) console.log(`  ${m.name}${m.applied_at ? `  (${m.applied_at})` : ''}`);
} finally {
  db.$client.close();
}
