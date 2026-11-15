import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The real `npm run simulate` and `npm run audit` scripts, as separate processes: CONDUCTOR_DB, exit codes,
 * stdout/stderr. (The commands themselves are tested in src/test/sim/command.test.ts and
 * src/test/audit/command.test.ts.)
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let dir: string;
let db: string;

const run = (script: 'simulate' | 'audit', args: string[]) => {
  const r = spawnSync(process.execPath, [tsx, join(root, 'src', 'scripts', `${script}.ts`), ...args], {
    cwd: dir, // no .env here: only what this test sets
    env: { PATH: process.env.PATH ?? '', CONDUCTOR_DB: db, TZ: 'UTC', NODE_OPTIONS: '--no-warnings' }, // (node:sqlite is "experimental")
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scripts-'));
  db = join(dir, 'conductor.db');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the simulate and audit scripts', { timeout: 120_000 }, () => {
  it('simulate --store puts the result in CONDUCTOR_DB; audit shows it only with --for-simulation', () => {
    const sim = run('simulate', ['crash-mid-soak', '--store', '--quiet', '--out-dir', join(dir, 'out')]);
    expect(sim).toMatchObject({ code: 0, err: '' });
    expect(sim.out).toContain(`Stored 1 simulation result(s) in ${db}`);
    expect(existsSync(join(dir, 'out', 'crash-mid-soak.audit.jsonl'))).toBe(true);

    const own = run('audit', ['--since', '3000d']);
    expect(own).toMatchObject({ code: 0, out: `No matching events in ${db}.\n`, err: '' });

    const simulated = run('audit', ['--for-simulation', '--scenario', 'crash-mid-soak', '--recovery']);
    expect(simulated.code).toBe(0);
    expect(simulated.out).toMatch(/^═══ crash-mid-soak: /);
    expect(simulated.out).toContain('service.unclean_shutdown');
  });

  it('exit codes: usage errors 2, unknown scenarios 1', () => {
    expect(run('audit', ['--scenario', 'crash-mid-soak'])).toMatchObject({ code: 2, out: '' });
    expect(run('audit', ['--for-simulation', '--scenario', 'nope']).code).toBe(1);
    expect(run('simulate', ['nope']).code).toBe(1);
    expect(run('simulate', ['crash-mid-soak', '--db', db]).code).toBe(2);
  });
});
