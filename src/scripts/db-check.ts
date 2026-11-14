/**
 * Checks that the migrations in prisma/migrations produce exactly prisma/schema.prisma (exit code 1 if not).
 *
 *   npm run db:check
 */
import { readFile } from 'node:fs/promises';
import { MIGRATIONS_FOLDER, SCHEMA_PATH } from '../db/migrate.ts';
import { diffMigrationsToSchema } from '../db/schema-engine.ts';

const missing = await diffMigrationsToSchema(MIGRATIONS_FOLDER, await readFile(SCHEMA_PATH, 'utf8'));
if (missing) {
  console.error(`prisma/schema.prisma has changes no migration covers. Run npm run db:migration -- <name>. Missing:\n\n${missing}`);
  process.exit(1);
}
console.log('The migrations match prisma/schema.prisma.');
