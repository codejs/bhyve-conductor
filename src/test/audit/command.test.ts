import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../audit/audit.ts';
import { runAuditCommand, type AuditCommandIo } from '../../audit/command.ts';
import { formatEvent, formatSummary, RECOVERY_TYPES, summarize } from '../../audit/report.ts';
import type { ConductorConfig } from '../../conductor/config.ts';
import { openDatabase } from '../../db/database.ts';
import { MIGRATIONS_FOLDER, readMigrations } from '../../db/migrate.ts';
import { beginSession } from '../../db/session.ts';
import { log } from '../../log.ts';
import { runScenario, type SimResult } from '../../sim/runner.ts';
import { scenarioById } from '../../sim/scenarios.ts';
import { storeSimulation } from '../../sim/store.ts';
import { zone } from '../utils/conductor.ts';

/**
 * `npm run audit`: the conductor's own trail by default — never a stored simulation, whatever the filters —
 * and the stored simulations only with --for-simulation.
 */

/** Real time: a month after the simulated summer day. */
const NOW = new Date('2026-08-02T12:00:00.000Z');
const minutesAgo = (min: number): Date => new Date(NOW.getTime() - min * 60_000);
const STORED_AT = new Date('2026-08-01T15:00:00.000Z');
const config: ConductorConfig = {
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones: [zone({ name: 'Front' }), zone({ station: 2, name: 'Back' })],
};

const SCENARIO_IDS = ['crash-mid-soak', 'bhyve-socket-outage'] as const;
const results = new Map<string, SimResult>();
const sim = (id: string): SimResult => {
  const r = results.get(id);
  if (!r) throw new Error(`scenario ${id} did not run`);
  return r;
};

let dir: string;
/** The conductor's own events (two days ago, and in the last hour) and both simulations. */
let full: string;
/** Only the conductor's own events. */
let realOnly: string;
/** Only simulations. */
let simsOnly: string;
/** Neither. */
let empty: string;
/** A database at the first migration (before simulation tables). */
let old: string;

/** What the running conductor recorded: in the last day, and older. */
const REAL: { ts: Date; type: AuditEvent['type']; data: Record<string, unknown> }[] = [
  { ts: minutesAgo(2 * 24 * 60), type: 'service.started', data: { mode: 'continuous', dryRun: false, zones: 2 } },
  { ts: minutesAgo(60), type: 'connection.lost', data: { service: 'tuya', error: 'timed out after 20s' } },
  { ts: minutesAgo(30), type: 'connection.restored', data: { service: 'tuya', downSince: minutesAgo(60).toISOString(), outageMinutes: 30, failures: 2, lastError: 'timed out' } },
  { ts: minutesAgo(10), type: 'zone.decision', data: { zone: 'dev1:1', name: 'Front', reason: 'moist', detail: 'at 35%' } },
];

const fill = async (path: string, { real, sims }: { real: boolean; sims: boolean }): Promise<void> => {
  const db = openDatabase(path);
  if (real) {
    let at = REAL[0]?.ts ?? NOW;
    const session = await beginSession(db, { config, mode: 'continuous', now: () => at });
    for (const e of REAL) {
      at = e.ts;
      session.audit.record(e.type, e.data);
    }
    await session.end('test');
  }
  if (sims) for (const id of SCENARIO_IDS) await storeSimulation(db, sim(id), STORED_AT);
  await db.close();
};

beforeAll(async () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  for (const id of SCENARIO_IDS) {
    const scenario = scenarioById(id);
    if (!scenario) throw new Error(`no scenario ${id}`);
    results.set(id, await runScenario(scenario));
  }
  dir = await mkdtemp(join(tmpdir(), 'audit-command-'));
  full = join(dir, 'full.db');
  realOnly = join(dir, 'real.db');
  simsOnly = join(dir, 'sims.db');
  empty = join(dir, 'empty.db');
  old = join(dir, 'old.db');
  await fill(full, { real: true, sims: true });
  await fill(realOnly, { real: true, sims: false });
  await fill(simsOnly, { real: false, sims: true });
  await fill(empty, { real: false, sims: false });
  const initOnly = join(dir, 'init-only');
  const first = readMigrations()[0];
  if (!first) throw new Error('no migrations');
  await mkdir(join(initOnly, first.name), { recursive: true });
  await cp(join(MIGRATIONS_FOLDER, first.name), join(initOnly, first.name), { recursive: true });
  const before = openDatabase(old, { migrationsFolder: initOnly });
  await before.close();
  vi.restoreAllMocks();
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Read-only opens of the old database warn that it is not up to date.
  vi.spyOn(log, 'warn').mockImplementation(() => {});
});

interface Run {
  code: number;
  out: string[];
  err: string[];
  /** Everything written to stdout, one line per line. */
  lines: string[];
}

const audit = async (argv: string[], file: string | undefined = full): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const io: AuditCommandIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => NOW,
    defaultDatabase: () => {
      if (file === undefined) throw new Error('CONDUCTOR_DB was asked for');
      return file;
    },
  };
  const code = await runAuditCommand(argv, io);
  return { code, out, err, lines: out.join('\n').split('\n') };
};

const TZ = 'America/Chicago';
const realLine = (i: number, tz?: string) => {
  const e = REAL[i];
  if (!e) throw new Error(`no event ${i}`);
  return formatEvent({ ts: e.ts.toISOString(), type: e.type, ...e.data }, tz);
};
const simLines = (id: string, events: (e: AuditEvent) => boolean = () => true, tz = TZ) => sim(id).events.filter(events).map((e) => formatEvent(e, tz));
const allSimEventText = () => SCENARIO_IDS.flatMap((id) => simLines(id));

describe('npm run audit (the conductor’s own trail)', () => {
  it('shows the last 24 hours of the conductor’s events, and no simulation', async () => {
    const r = await audit(['--tz', TZ]);

    expect(r.code).toBe(0);
    expect(r.out).toEqual([realLine(1, TZ), realLine(2, TZ), realLine(3, TZ)]);
  });

  it.each([
    [['--since', '3000d']],
    [['--since', '2000-01-01', '--until', '2100-01-01']],
    [['--type', 'simulation,service,wave,sequence']],
    [['--recovery', '--since', '3000d']],
    [['--device', 'timer-1', '--since', '3000d']],
    [['--zone', 'timer-1:1', '--since', '3000d']],
  ])('never shows a stored simulation, whatever the filter: %j', async (argv) => {
    const r = await audit(['--tz', TZ, ...argv]);

    expect(r.code).toBe(0);
    for (const line of r.out) expect(allSimEventText()).not.toContain(line);
    expect(r.out.join('\n')).not.toMatch(/timer-1|simulation\.note|▶/);
  });

  it('shows everything of its own with a wide window', async () => {
    const r = await audit(['--since', '3000d', '--tz', TZ]);
    expect(r.out).toEqual(REAL.map((_, i) => realLine(i, TZ)));
  });

  it('finds no simulated sequence by its id', async () => {
    const sequence = String(sim('crash-mid-soak').events.find((e) => e.type === 'sequence.started')?.sequence);
    const r = await audit(['--sequence', sequence.slice(0, 8)]);
    expect(r.out).toEqual([`No matching events in ${full}.`]);
  });

  it('--json: only the conductor’s events, as JSON lines', async () => {
    const r = await audit(['--json', '--since', '3000d']);
    expect(r.out.map((line) => JSON.parse(line) as AuditEvent)).toEqual(REAL.map((e) => ({ ts: e.ts.toISOString(), type: e.type, ...e.data })));
  });

  it('--summary: the conductor’s outages, not the simulated ones', async () => {
    const r = await audit(['--summary', '--since', '3000d', '--tz', TZ]);
    const events = REAL.map((e) => ({ ts: e.ts.toISOString(), type: e.type, ...e.data }));
    expect(r.out).toEqual([formatSummary(summarize(events), TZ)]);
    expect(r.out[0]).toContain('tuya');
    expect(r.out[0]).not.toContain('bhyve');
  });

  it('says there is nothing when only simulations are stored', async () => {
    expect((await audit(['--since', '3000d'], simsOnly)).out).toEqual([`No matching events in ${simsOnly}.`]);
  });

  it('reads another database given with --file, without asking for CONDUCTOR_DB', async () => {
    const r = await audit(['--file', realOnly, '--since', '3000d', '--tz', TZ], undefined);
    expect(r.out).toEqual(REAL.map((_, i) => realLine(i, TZ)));
  });

  it('reads a JSON Lines trail, e.g. a simulation saved as a file', async () => {
    const file = join(dir, 'crash.audit.jsonl');
    await writeFile(file, sim('crash-mid-soak').events.map((e) => JSON.stringify(e)).join('\n') + '\n{"cut short\n');
    const r = await audit(['--file', file, '--since', '2026-01-01', '--tz', TZ]);

    expect(r.out).toEqual(simLines('crash-mid-soak'));
    expect(r.err).toEqual([`(1 unreadable line(s) in ${file} skipped — e.g. a line cut short by a crash)`]);
  });

  it('--scenario without --for-simulation is a usage error', async () => {
    const r = await audit(['--scenario', 'crash-mid-soak']);
    expect(r).toMatchObject({ code: 2, out: [], err: ['--scenario picks stored simulations; add --for-simulation'] });
  });

  it('an unknown option is a usage error that shows the usage', async () => {
    const r = await audit(['--simulation']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain("Unknown option '--simulation'");
    expect(r.err.join('\n')).toContain('--for-simulation');
  });

  it('--help shows the usage', async () => {
    const r = await audit(['--help'], undefined);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/^Usage: npm run audit/);
  });

  it('a time it can’t read is an error', async () => {
    const r = await audit(['--since', 'yesterday']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('use e.g. 24h, 7d');
  });

  it('a database that doesn’t exist is an error', async () => {
    const r = await audit([], join(dir, 'nope.db'));
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('does not exist yet');
  });
});

describe('npm run audit -- --for-simulation', () => {
  const headerOf = (id: string) => `═══ ${id}: ${sim(id).scenario.title} `;

  it('shows every stored simulation, whole, under a header, in its own time zone', async () => {
    const r = await audit(['--for-simulation']);

    expect(r.code).toBe(0);
    // By scenario id: bhyve-socket-outage, then crash-mid-soak.
    const [a, b] = ['bhyve-socket-outage', 'crash-mid-soak'];
    if (!a || !b) throw new Error('unreachable');
    const start = r.lines.findIndex((l) => l.startsWith(headerOf(a)));
    const second = r.lines.findIndex((l) => l.startsWith(headerOf(b)));
    expect(start).toBe(0);
    expect(r.lines[1]).toBe(
      `Simulated 2026-07-01 06:00 (${TZ}) for ${sim(a).scenario.hours} h; stored ${formatTimeLocal(STORED_AT)}; ${sim(a).events.length} events, ${sim(a).notifications.length} notification(s)`,
    );
    expect(r.lines.slice(2, second - 1)).toEqual(simLines(a));
    expect(r.lines[second - 1]).toBe('');
    expect(r.lines.slice(second + 2)).toEqual(simLines(b));
  });

  it('never shows the conductor’s own events', async () => {
    const r = await audit(['--for-simulation', '--since', '2000-01-01']);
    for (const i of REAL.keys()) expect(r.lines).not.toContain(realLine(i, TZ));
    expect(r.out.join('\n')).not.toContain('dev1:1');
  });

  it('--scenario: only that one (or a comma-separated few)', async () => {
    const one = await audit(['--for-simulation', '--scenario', 'crash-mid-soak']);
    expect(one.lines[0]?.startsWith(headerOf('crash-mid-soak'))).toBe(true);
    expect(one.lines.slice(2)).toEqual(simLines('crash-mid-soak'));

    const both = await audit(['--for-simulation', '--scenario', 'crash-mid-soak, bhyve-socket-outage']);
    expect(both.out).toEqual((await audit(['--for-simulation'])).out);
  });

  it('--recovery and --type filter inside each simulation', async () => {
    const r = await audit(['--for-simulation', '--recovery']);
    const shown = r.lines.filter((l) => !l.startsWith('═══') && !l.startsWith('Simulated') && l !== '');
    expect(shown).toEqual([
      ...simLines('bhyve-socket-outage', (e) => RECOVERY_TYPES.has(e.type)),
      ...simLines('crash-mid-soak', (e) => RECOVERY_TYPES.has(e.type)),
    ]);

    const notes = await audit(['--for-simulation', '--scenario', 'crash-mid-soak', '--type', 'simulation']);
    expect(notes.lines.slice(2)).toEqual(simLines('crash-mid-soak', (e) => e.type === 'simulation.note'));
  });

  it('--sequence: one simulated sequence, and only the simulation that has it', async () => {
    const sequence = String(sim('crash-mid-soak').events.find((e) => e.type === 'sequence.started')?.sequence);
    const r = await audit(['--for-simulation', '--sequence', sequence.slice(0, 8)]);

    expect(r.lines[0]?.startsWith(headerOf('crash-mid-soak'))).toBe(true);
    expect(r.lines.slice(2)).toEqual(simLines('crash-mid-soak', (e) => e.sequence === sequence));
  });

  it('--since/--until in simulated time apply; the default 24-hour window does not', async () => {
    const r = await audit(['--for-simulation', '--scenario', 'crash-mid-soak', '--since', '2026-07-01T06:30-05:00', '--until', '2026-07-01T07:00-05:00']);
    const inWindow = (e: AuditEvent) => Date.parse(e.ts) >= Date.parse('2026-07-01T11:30:00Z') && Date.parse(e.ts) <= Date.parse('2026-07-01T12:00:00Z');

    expect(r.lines.slice(2)).toEqual(simLines('crash-mid-soak', inWindow));
    expect(r.lines.length).toBeGreaterThan(3);
  });

  it('a relative --since counts back from now, which is after the simulated day: nothing', async () => {
    const r = await audit(['--for-simulation', '--since', '24h']);
    expect(r).toMatchObject({ code: 0, out: [`No matching events in the 2 stored simulation(s) in ${full}.`] });
  });

  it('--tz shows the times in another zone', async () => {
    const r = await audit(['--for-simulation', '--scenario', 'crash-mid-soak', '--tz', 'UTC']);
    expect(r.lines[1]).toMatch(/^Simulated 2026-07-01 11:00 \(UTC\)/);
    expect(r.lines.slice(2)).toEqual(simLines('crash-mid-soak', () => true, 'UTC'));
  });

  it('--json: each event once, tagged with its simulation', async () => {
    const r = await audit(['--for-simulation', '--json']);

    expect(r.out.map((line) => JSON.parse(line) as unknown)).toEqual([
      ...sim('bhyve-socket-outage').events.map((e) => ({ simulation: 'bhyve-socket-outage', ...e })),
      ...sim('crash-mid-soak').events.map((e) => ({ simulation: 'crash-mid-soak', ...e })),
    ]);
  });

  it('--summary: one per simulation, under its header', async () => {
    const r = await audit(['--for-simulation', '--summary']);

    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    for (const id of SCENARIO_IDS) {
      expect(text).toContain(headerOf(id));
      expect(text).toContain(formatSummary(summarize(sim(id).events), TZ));
    }
    expect(text).toContain('Unclean shutdowns (crash/kill/power loss): 1');
  });

  it('an unknown scenario is an error that lists the stored ones', async () => {
    const r = await audit(['--for-simulation', '--scenario', 'crash-mid-soak,no-such-thing']);
    expect(r).toMatchObject({ code: 1, out: [], err: [`No stored simulation of no-such-thing in ${full}. Stored: bhyve-socket-outage, crash-mid-soak`] });
  });

  it('says how to store some when there are none', async () => {
    for (const file of [realOnly, empty]) {
      const r = await audit(['--for-simulation'], file);
      expect(r).toMatchObject({ code: 0, out: [`No simulation results stored in ${file}. Store some with: npm run simulate -- --all --store`] });
    }
    const r = await audit(['--for-simulation', '--scenario', 'crash-mid-soak'], empty);
    expect(r).toMatchObject({ code: 1, err: [`No stored simulation of crash-mid-soak in ${empty}. Store some with: npm run simulate -- --all --store`] });
  });

  it('explains a database from before stored simulations, without changing it', async () => {
    const r = await audit(['--for-simulation'], old);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^No simulation results in .*old\.db: the database is older than stored simulations \(start the conductor or run npm run db:migrate\)/);

    const still = openDatabase(old, { readOnly: true });
    try {
      expect(still.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'simulation%'").get()).toEqual({ n: 0 });
    } finally {
      await still.close();
    }
  });

  it('does not read JSON Lines files: those hold no stored simulations', async () => {
    const r = await audit(['--for-simulation', '--file', 'simulations/crash-mid-soak.audit.jsonl']);
    expect(r).toMatchObject({ code: 2, err: ['--for-simulation reads the simulations stored in a database; read simulations/crash-mid-soak.audit.jsonl without it'] });
  });
});

/** "YYYY-MM-DD HH:MM" in the machine's time zone (how the header shows when a result was stored). */
function formatTimeLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
