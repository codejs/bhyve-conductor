import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../audit/audit.ts';
import { runAuditCommand } from '../../audit/command.ts';
import { queryAuditEvents, SqliteAuditLog } from '../../db/audit-log.ts';
import { openDatabase } from '../../db/database.ts';
import { MIGRATIONS_FOLDER, readMigrations } from '../../db/migrate.ts';
import { log } from '../../log.ts';
import { runSimulateCommand, type SimulateCommandIo } from '../../sim/command.ts';
import { SCENARIOS } from '../../sim/scenarios.ts';
import { fetchCall, jsonResponse, mockFetch } from '../utils/fetch.ts';
import { listSimulations, simulationEvents, simulationNotifications } from '../../sim/store.ts';

/**
 * `npm run simulate`: the files it always wrote, and with --store the database — the results stored there
 * are what the files hold, and `npm run audit` shows them only with --for-simulation.
 */

const NOW = new Date('2026-08-02T12:00:00.000Z');
const LATER = new Date('2026-08-03T12:00:00.000Z');

let dir: string;
let outDir: string;
let dbPath: string;

beforeEach(async () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), 'simulate-command-'));
  outDir = join(dir, 'out');
  dbPath = join(dir, 'conductor.db');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
  /** Whether it asked for CONDUCTOR_DB. */
  askedForDb: boolean;
}

type TelegramEnv = () => { token?: string; chatId?: string };

const simulate = async (argv: string[], o: { now?: Date; telegram?: TelegramEnv } = {}): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  let askedForDb = false;
  const io: SimulateCommandIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => o.now ?? NOW,
    defaultDatabase: () => {
      askedForDb = true;
      return dbPath;
    },
    telegram: o.telegram ?? (() => ({})),
  };
  const code = await runSimulateCommand(['--out-dir', outDir, ...argv], io);
  return { code, out: out.join('\n'), err: err.join('\n'), askedForDb };
};

const readJsonl = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

/** The stored results, per scenario: events and notifications. */
const stored = async (path = dbPath) => {
  const db = openDatabase(path, { readOnly: true });
  try {
    const runs = await listSimulations(db);
    return await Promise.all(
      runs.map(async (r) => ({ scenario: r.scenario, storedAt: r.storedAt, events: await simulationEvents(db, r.id), notifications: await simulationNotifications(db, r.id) })),
    );
  } finally {
    await db.close();
  }
};

const auditOf = async (argv: string[], file = dbPath) => {
  const out: string[] = [];
  const code = await runAuditCommand(argv, { out: (t) => out.push(t), err: (t) => out.push(t), now: () => NOW, defaultDatabase: () => file });
  return { code, text: out.join('\n') };
};

// Each test plays a scenario or two: a second or so alone, longer next to the other test files.
describe('npm run simulate', { timeout: 30_000 }, () => {
  it('lists the scenarios (and mentions --store) when given none', async () => {
    for (const argv of [[], ['--list']]) {
      const r = await simulate(argv);
      expect(r.code).toBe(0);
      for (const s of SCENARIOS) expect(r.out).toContain(`  ${s.id.padEnd(22)} ${s.title}`);
      expect(r.out).toContain('add --store');
    }
    expect(existsSync(outDir)).toBe(false);
  });

  it('refuses an unknown scenario, running nothing', async () => {
    const r = await simulate(['normal-watering', 'no-such-thing']);
    expect(r).toMatchObject({ code: 1, err: 'Unknown scenario(s): no-such-thing. See: npm run simulate -- --list' });
    expect(existsSync(outDir)).toBe(false);
  });

  it('refuses an unknown option', async () => {
    const r = await simulate(['normal-watering', '--save']);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown option '--save'");
  });

  it('--db without --store is a usage error, and touches no database', async () => {
    const r = await simulate(['normal-watering', '--db', dbPath]);
    expect(r).toMatchObject({ code: 2, err: '--db says where --store puts the results; add --store', askedForDb: false });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('--telegram without credentials fails before running anything', async () => {
    const r = await simulate(['normal-watering', '--telegram', '--store']);
    expect(r).toMatchObject({ code: 1, err: '--telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.' });
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('--telegram with credentials it can’t read fails before running anything', async () => {
    const r = await simulate(['normal-watering', '--telegram'], {
      telegram: () => {
        throw new Error('Invalid environment (see .env.example)');
      },
    });
    expect(r).toMatchObject({ code: 1, err: '--telegram: Invalid environment (see .env.example)' });
    expect(existsSync(outDir)).toBe(false);
  });

  it('--telegram: sends each notification, marked as a simulation, after storing', async () => {
    const fetch = mockFetch();
    fetch.mockResolvedValue(jsonResponse({ ok: true, result: {} }));

    const r = await simulate(['rain-forecast', '--telegram', '--store', '--quiet'], { telegram: () => ({ token: '123:abc', chatId: '42' }) });

    expect(r.code).toBe(0);
    const notifications = await readJsonl<{ text: string }>(join(outDir, 'rain-forecast.notifications.jsonl'));
    expect(notifications.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.map((_, i) => fetchCall(fetch, i).body)).toEqual(
      notifications.map((n) => expect.objectContaining({ chat_id: '42', text: `🧪 <i>Simulation: rain-forecast</i>\n${n.text}` })),
    );
    expect(r.out).toContain(`Sending ${notifications.length} notification(s) to Telegram`);
    expect(r.out).toMatch(/Sent\.$/);
    expect((await stored()).map((s) => s.scenario)).toEqual(['rain-forecast']);
  });

  it('without --store: writes the files as always, and no database', async () => {
    const r = await simulate(['normal-watering']);

    expect(r).toMatchObject({ code: 0, askedForDb: false });
    expect((await readdir(outDir)).sort()).toEqual(['normal-watering.audit.jsonl', 'normal-watering.notifications.jsonl']);
    expect(existsSync(dbPath)).toBe(false);
    expect(r.out).toContain(`Saved: ${join(outDir, 'normal-watering.audit.jsonl')}\n`);
    expect(r.out).toContain(`Review: npm run audit -- --file ${join(outDir, 'normal-watering.audit.jsonl')}`);
    expect(r.out).not.toContain('--for-simulation');
    expect(r.out).not.toContain('Stored');
  });

  it('--store: keeps each result in CONDUCTOR_DB, the same as the files', async () => {
    const r = await simulate(['normal-watering', 'crash-mid-soak', '--store']);

    expect(r).toMatchObject({ code: 0, err: '', askedForDb: true });
    expect(r.out).toContain(`Stored 2 simulation result(s) in ${dbPath}`);
    expect(r.out).toContain('Review: npm run audit -- --for-simulation --scenario crash-mid-soak [--summary');
    const db = await stored();
    expect(db.map((s) => [s.scenario, s.storedAt])).toEqual([
      ['crash-mid-soak', NOW],
      ['normal-watering', NOW],
    ]);
    for (const s of db) {
      expect(s.events).toEqual(await readJsonl<AuditEvent>(join(outDir, `${s.scenario}.audit.jsonl`)));
      expect(s.notifications).toEqual(await readJsonl(join(outDir, `${s.scenario}.notifications.jsonl`)));
    }
  });

  it('--store --db <path>: stores there, and says how to review it', async () => {
    const other = join(dir, 'other.db');
    const r = await simulate(['normal-watering', '--store', '--db', other, '--quiet']);

    expect(r).toMatchObject({ code: 0, askedForDb: false });
    expect(r.out).toContain(`Review: npm run audit -- --for-simulation --file ${other}`);
    expect((await stored(other)).map((s) => s.scenario)).toEqual(['normal-watering']);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('storing a scenario again replaces its result and keeps the others', async () => {
    await simulate(['normal-watering', 'crash-mid-soak', '--store', '--quiet']);
    await simulate(['crash-mid-soak', '--store', '--quiet'], { now: LATER });

    const db = await stored();
    expect(db.map((s) => [s.scenario, s.storedAt])).toEqual([
      ['crash-mid-soak', LATER],
      ['normal-watering', NOW],
    ]);
    const client = new DatabaseSync(dbPath, { readOnly: true });
    const events = client.prepare('SELECT count(*) AS n FROM simulation_event').get() as { n: number };
    client.close();
    expect(events.n).toBe(db.reduce((n, s) => n + s.events.length, 0));
  });

  it('stores next to the conductor’s data without touching it; npm run audit keeps them apart', async () => {
    const db = openDatabase(dbPath);
    const trail = new SqliteAuditLog(db, { now: () => new Date(NOW.getTime() - 60_000) });
    trail.record('connection.lost', { service: 'tuya', error: 'timed out' });
    await trail.flush();
    const before = await queryAuditEvents(db);
    await db.close();

    expect((await simulate(['crash-mid-soak', '--store', '--quiet'])).code).toBe(0);

    const after = openDatabase(dbPath, { readOnly: true });
    expect(await queryAuditEvents(after)).toEqual(before);
    await after.close();
    const own = await auditOf(['--since', '3000d']);
    expect(own.text).toContain('tuya');
    expect(own.text).not.toContain('timer-1');
    const simulated = await auditOf(['--for-simulation']);
    expect(simulated.text).toContain('═══ crash-mid-soak: ');
    expect(simulated.text).toContain('timer-1');
    expect(simulated.text).not.toContain('tuya');
  });

  it('upgrades a database from before stored simulations first (with a copy)', async () => {
    const initOnly = join(dir, 'init-only');
    const first = readMigrations()[0];
    if (!first) throw new Error('no migrations');
    await mkdir(join(initOnly, first.name), { recursive: true });
    await cp(join(MIGRATIONS_FOLDER, first.name), join(initOnly, first.name), { recursive: true });
    const old = openDatabase(dbPath, { migrationsFolder: initOnly });
    const trail = new SqliteAuditLog(old, { now: () => NOW });
    trail.record('service.started', { mode: 'continuous', dryRun: false, zones: 2 });
    await trail.flush();
    await old.close();

    expect((await simulate(['normal-watering', '--store', '--quiet'])).code).toBe(0);

    expect((await stored()).map((s) => s.scenario)).toEqual(['normal-watering']);
    expect(existsSync(`${dbPath}.before-${readMigrations()[1]?.name}`)).toBe(true);
  });

  it('a file that is not a conductor database is an error before anything runs', async () => {
    const foreign = join(dir, 'foreign.db');
    const client = new DatabaseSync(foreign);
    client.exec('CREATE TABLE other (x); PRAGMA application_id = 1234;');
    client.close();

    const r = await simulate(['normal-watering', '--store', '--db', foreign]);

    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^--store: /);
    expect(existsSync(outDir)).toBe(false);
  });

  it('a file that is not a database at all is an error too', async () => {
    const text = join(dir, 'notes.txt');
    await writeFile(text, 'hello, this is not SQLite\n'.repeat(100));
    const r = await simulate(['normal-watering', '--store', '--db', text]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^--store: /);
    expect(await readFile(text, 'utf8')).toBe('hello, this is not SQLite\n'.repeat(100));
  });
});
