import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../files.ts';

describe('writeFileAtomic', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-'));
    path = join(dir, 'file.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates or replaces the file, leaving nothing else behind', async () => {
    await writeFileAtomic(path, 'one');
    await writeFileAtomic(path, 'two');

    expect(await readFile(path, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['file.json']);
  });

  it('sets the given permissions', async () => {
    await writeFileAtomic(path, 'x', { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('replaces a symlink at the target instead of writing through it', async () => {
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'IMPORTANT');
    await symlink(victim, path);

    await writeFileAtomic(path, 'new');

    expect(await readFile(victim, 'utf8')).toBe('IMPORTANT');
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it('uses a temporary name nobody can predict (so it cannot be planted in advance)', async () => {
    const names = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await writeFileAtomic(path, 'x', {
        beforeReplace: async () => {
          for (const f of await readdir(dir)) if (f.endsWith('.tmp')) names.add(f);
        },
      });
    }
    expect(names.size).toBe(5);
    for (const n of names) expect(n).toMatch(/^file\.json\.[0-9a-f]{16}\.tmp$/);
  });

  it('leaves the target untouched, and no temporary file, when aborted before replacing', async () => {
    await writeFile(path, 'old');

    await expect(writeFileAtomic(path, 'new', { beforeReplace: async () => Promise.reject(new Error('changed meanwhile')) })).rejects.toThrow('changed meanwhile');

    expect(await readFile(path, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['file.json']);
  });

  it('cleans up when the target cannot be replaced', async () => {
    await mkdir(path); // a folder is in the way

    await expect(writeFileAtomic(path, 'new')).rejects.toThrow();

    expect(await readdir(dir)).toEqual(['file.json']);
  });

  it('fails (and writes nothing) when the folder does not exist', async () => {
    await expect(writeFileAtomic(join(dir, 'missing', 'file.json'), 'x')).rejects.toThrow(/ENOENT/);
  });
});
