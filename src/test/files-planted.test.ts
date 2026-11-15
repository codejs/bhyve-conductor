import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Make the "unpredictable" temporary name predictable, as if an attacker had guessed it.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return { ...real, randomBytes: (n: number) => Buffer.alloc(n, 0xab) };
});
const { writeFileAtomic } = await import('../files.ts');

describe('writeFileAtomic with a planted temporary file', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-planted-'));
    path = join(dir, 'conductor.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to write through a symlink planted at the temporary name (exclusive create), leaving everything alone', async () => {
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'IMPORTANT');
    await writeFile(path, 'old');
    await symlink(victim, `${path}.${'ab'.repeat(8)}.tmp`);

    await expect(writeFileAtomic(path, 'new')).rejects.toThrow(/EEXIST/);

    expect(await readFile(victim, 'utf8')).toBe('IMPORTANT');
    expect(await readFile(path, 'utf8')).toBe('old');
    expect((await readdir(dir)).sort()).toEqual(['conductor.json', `conductor.json.${'ab'.repeat(8)}.tmp`, 'victim.txt']);
  });
});
