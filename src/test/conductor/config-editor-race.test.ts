import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConductorConfig } from '../../conductor/config.ts';
import { ConfigEditor } from '../../conductor/config-editor.ts';
import { log } from '../../log.ts';

/** Lets a test do something right after the editor has read the file (it checks the permissions next). */
const hook = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: vi.fn(async (...args: Parameters<typeof real.stat>) => {
      const run = hook.afterRead;
      hook.afterRead = undefined;
      await run?.();
      return real.stat(...args);
    }),
  };
});

const FILE = { zones: [{ name: 'Front lawn', deviceId: 'dev1', station: 1, sensorIds: ['s1'] }] };

describe('ConfigEditor while someone else edits the file', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-race-'));
    path = join(dir, 'conductor.json');
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    hook.afterRead = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('does not overwrite an edit saved while the change was being written, and changes nothing', async () => {
    await writeFile(path, JSON.stringify(FILE));
    const config = parseConductorConfig(FILE);
    const editor = new ConfigEditor({ path, config });
    const edited = JSON.stringify({ ...FILE, pollIntervalMinutes: 5 });
    hook.afterRead = () => writeFile(path, edited);

    const result = await editor.apply('dev1:1', { runMinutes: 12 }, 'x');

    expect(result).toMatchObject({ ok: false, reason: 'conflict', problems: [expect.stringContaining('was changed while saving')] });
    expect(await readFile(path, 'utf8')).toBe(edited);
    expect(config.zones[0]?.runMinutes).toBe(10);
  });
});
