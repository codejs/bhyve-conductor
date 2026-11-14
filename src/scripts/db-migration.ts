/**
 * Writes the migration for a change to prisma/schema.prisma, like `prisma migrate dev --create-only`, but
 * offline (Prisma's schema engine in WebAssembly). Review the SQL, then commit it; the conductor applies it
 * at its next start (or run npm run db:migrate).
 *
 *   npm run db:migration -- add_sensor_notes
 */
import { readFile } from 'node:fs/promises';
import { MIGRATIONS_FOLDER, SCHEMA_PATH } from '../db/migrate.ts';
import { createMigration } from '../db/schema-engine.ts';

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: npm run db:migration -- <name>   (lowercase letters, digits and _)');
  process.exit(1);
}
const created = await createMigration(MIGRATIONS_FOLDER, await readFile(SCHEMA_PATH, 'utf8'), name);
if (!created) {
  console.log('No changes: the migrations already match prisma/schema.prisma.');
} else {
  console.log(`Wrote prisma/migrations/${created.folder}/migration.sql:\n\n${created.sql}`);
  console.log('Review it (see "Changing the schema" in docs/sqlite-storage.md), then run npm run db:generate.');
}
