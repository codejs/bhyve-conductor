import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, SCHEMA_PATH } from '../../db/migrate.ts';
import { createMigration, diffMigrationsToSchema, migrationFolderName, readMigrationList } from '../../db/schema-engine.ts';

/** The development tool behind npm run db:migration / db:check (Prisma's schema engine, offline). */

const SCHEMA = await readFile(SCHEMA_PATH, 'utf8');

describe('migrationFolderName', () => {
  it('names folders like Prisma: UTC time, then the name', () => {
    expect(migrationFolderName([], 'add_notes', new Date('2026-11-15T09:30:05.900Z'))).toBe('20261115093005_add_notes');
  });

  it('always sorts after the existing migrations, even with a clock behind them', () => {
    expect(migrationFolderName(['20261115093005_a', '20261115093007_b'], 'c', new Date('2026-11-15T09:30:00.000Z'))).toBe('20261115093008_c');
  });
});

describe('with a copy of the migrations', { timeout: 30_000 }, () => {
  let dir: string;
  let folder: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-engine-'));
    folder = join(dir, 'migrations');
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes no migration when the schema has not changed', async () => {
    expect(await createMigration(folder, SCHEMA, 'nothing')).toBeUndefined();
  });

  it('writes a migration for a change, and then the migrations match the schema again', async () => {
    const changed = SCHEMA.replace('  abandonReason String?   @map("abandon_reason")', '  abandonReason String?   @map("abandon_reason")\n  note          String?');
    expect(await diffMigrationsToSchema(folder, changed)).toContain('ALTER TABLE "watering_sequence" ADD COLUMN "note" TEXT');

    const created = await createMigration(folder, changed, 'add_note', new Date('2099-01-01T00:00:00.000Z'));

    expect(created?.folder).toBe('20990101000000_add_note');
    expect(await readFile(join(folder, '20990101000000_add_note', 'migration.sql'), 'utf8')).toBe(created?.sql);
    expect(await diffMigrationsToSchema(folder, changed)).toBe('');
  });

  it('starts a migrations folder from nothing, with Prisma\'s lock file', async () => {
    const empty = join(dir, 'new');

    const created = await createMigration(empty, SCHEMA, 'init');

    expect(created?.sql).toContain('CREATE TABLE "watering_sequence"');
    expect(await readFile(join(empty, 'migration_lock.toml'), 'utf8')).toContain('provider = "sqlite"');
  });

  it('reads the folder as Prisma\'s engine takes it, including a folder without migration.sql', async () => {
    await mkdir(join(folder, '29990101000000_broken'));

    const list = await readMigrationList(folder);

    expect(list.lockfile.content).toContain('provider = "sqlite"');
    expect(list.migrationDirectories.at(-1)).toEqual({ path: '29990101000000_broken', migrationFile: { path: 'migration.sql', content: { tag: 'error', value: 'missing migration.sql' } } });
    expect(await readMigrationList(join(dir, 'missing'))).toMatchObject({ lockfile: { content: null }, migrationDirectories: [] });
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });
});
