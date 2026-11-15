import { parseArgs } from 'node:util';
import { readAuditSource } from '../db/audit-log.ts';
import { openDatabase } from '../db/database.ts';
import { hasSimulationTables, listSimulations, simulationEvents, type StoredSimulation } from '../sim/store.ts';
import type { AuditEvent } from './audit.ts';
import { filterEvents, formatEvent, formatSummary, formatTime, parseSince, summarize, type AuditFilter } from './report.ts';

/**
 * `npm run audit`: the audit trail of the conductor (default), or with --for-simulation the simulations
 * stored by `npm run simulate -- --store`. The two never mix: simulated events are in their own tables and
 * only show up when asked for.
 */

export interface AuditCommandIo {
  out(text: string): void;
  err(text: string): void;
  now(): Date;
  /** The database to read when there's no --file (CONDUCTOR_DB); only asked for then. */
  defaultDatabase(): string;
}

export const AUDIT_USAGE = `Usage: npm run audit -- [options]
  --since <24h|7d|ISO time>   from (default: 24h ago; stored simulations: their whole simulated time)
  --until <...>               to
  --type <prefix,...>         event types, e.g. wave,sequence.abandoned
  --device <id>  --zone <device:station>  --sequence <id or its first characters>
  --recovery                  only failures and recoveries
  --summary                   outages and the fate of each watering sequence
  --json                      raw JSON lines
  --tz <zone>                 time zone to show times in
  --file <path>               another database, or a .jsonl trail
  --for-simulation            the simulations stored with npm run simulate -- --store (not the conductor's trail)
  --scenario <id,...>         with --for-simulation: only these scenarios`;

const SIMULATE_HINT = 'Store some with: npm run simulate -- --all --store';

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      type: { type: 'string' },
      device: { type: 'string' },
      zone: { type: 'string' },
      sequence: { type: 'string' },
      recovery: { type: 'boolean', default: false },
      summary: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      file: { type: 'string' },
      tz: { type: 'string' },
      'for-simulation': { type: 'boolean', default: false },
      scenario: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  }).values;

type Options = ReturnType<typeof parse>;

const list = (text: string | undefined): string[] | undefined => {
  const items = text?.split(',').map((s) => s.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
};

/** The filter from the options; `defaultSince` applies when there's no --since (and no --sequence). */
const filterOf = (values: Options, now: Date, defaultSince: string | undefined): AuditFilter => {
  const since = values.since ?? defaultSince;
  const types = list(values.type);
  return {
    // A sequence id is specific enough on its own; don't hide its early events behind the default window.
    ...(since !== undefined && (values.since !== undefined || !values.sequence) ? { since: parseSince(since, now) } : {}),
    ...(values.until ? { until: parseSince(values.until, now) } : {}),
    ...(types ? { types } : {}),
    ...(values.device ? { device: values.device } : {}),
    ...(values.zone ? { zone: values.zone } : {}),
    ...(values.sequence ? { sequence: values.sequence } : {}),
    recovery: values.recovery,
  };
};

/** Runs the command; returns the exit code (0 ok, 1 failed or nothing to show for what was asked, 2 usage). */
export const runAuditCommand = async (argv: readonly string[], io: AuditCommandIo): Promise<number> => {
  let values: Options;
  try {
    values = parse(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n${AUDIT_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(AUDIT_USAGE);
    return 0;
  }
  if (values.scenario !== undefined && !values['for-simulation']) {
    io.err('--scenario picks stored simulations; add --for-simulation');
    return 2;
  }
  try {
    const now = io.now();
    const file = values.file ?? io.defaultDatabase();
    return values['for-simulation'] ? await showSimulations(values, file, now, io) : await showTrail(values, file, now, io);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
};

const print = (events: readonly AuditEvent[], values: Options, timeZone: string | undefined, io: AuditCommandIo, extra: Record<string, unknown> = {}): void => {
  if (values.json) {
    for (const e of events) io.out(JSON.stringify({ ...extra, ...e }));
  } else if (values.summary) {
    io.out(formatSummary(summarize(events), timeZone));
  } else {
    for (const e of events) io.out(formatEvent(e, timeZone));
  }
};

/** The conductor's own trail: a database (audit_event only) or a JSON Lines file. */
const showTrail = async (values: Options, file: string, now: Date, io: AuditCommandIo): Promise<number> => {
  const filter = filterOf(values, now, '24h');
  const { events, skipped } = await readAuditSource(file, filter);
  const selected = filterEvents(events, filter);
  if (selected.length === 0 && !values.json && !values.summary) io.out(`No matching events in ${file}.`);
  else print(selected, values, values.tz, io);
  if (skipped > 0) io.err(`(${skipped} unreadable line(s) in ${file} skipped — e.g. a line cut short by a crash)`);
  return 0;
};

const header = (run: StoredSimulation, timeZone: string): string => {
  const title = `${run.scenario}: ${run.title}`;
  return (
    `${'═'.repeat(3)} ${title} ${'═'.repeat(Math.max(3, 100 - title.length))}\n` +
    `Simulated ${formatTime(run.startedAt.toISOString(), timeZone).slice(0, 16)} (${timeZone}) for ${run.hours} h; ` +
    `stored ${formatTime(run.storedAt.toISOString()).slice(0, 16)}; ${run.events} events, ${run.notifications} notification(s)`
  );
};

/**
 * Stored simulations, one after the other. Their times are virtual (a simulated summer day), so the default
 * "last 24 hours" doesn't apply; --since and --until do. Times show in each simulation's time zone unless --tz.
 */
const showSimulations = async (values: Options, file: string, now: Date, io: AuditCommandIo): Promise<number> => {
  if (file.endsWith('.jsonl')) {
    io.err(`--for-simulation reads the simulations stored in a database; read ${file} without it`);
    return 2;
  }
  const scenarios = list(values.scenario);
  const filter = filterOf(values, now, undefined);
  const db = openDatabase(file, { readOnly: true });
  try {
    if (!hasSimulationTables(db)) {
      io.out(`No simulation results in ${file}: the database is older than stored simulations (start the conductor or run npm run db:migrate). ${SIMULATE_HINT}`);
      return scenarios ? 1 : 0;
    }
    const runs = await listSimulations(db, scenarios ? { scenarios } : {});
    if (scenarios) {
      const missing = scenarios.filter((s) => !runs.some((r) => r.scenario === s));
      if (missing.length > 0) {
        const stored = (await listSimulations(db)).map((r) => r.scenario);
        io.err(`No stored simulation of ${missing.join(', ')} in ${file}. ${stored.length ? `Stored: ${stored.join(', ')}` : SIMULATE_HINT}`);
        return 1;
      }
    }
    if (runs.length === 0) {
      io.out(`No simulation results stored in ${file}. ${SIMULATE_HINT}`);
      return 0;
    }
    let shown = 0;
    for (const run of runs) {
      const selected = filterEvents(await simulationEvents(db, run.id, filter), filter);
      if (selected.length === 0) continue;
      shown++;
      const timeZone = values.tz ?? run.timeZone;
      if (values.json) {
        print(selected, values, timeZone, io, { simulation: run.scenario });
        continue;
      }
      io.out(`${shown > 1 ? '\n' : ''}${header(run, timeZone)}`);
      print(selected, values, timeZone, io);
    }
    if (shown === 0 && !values.json) io.out(`No matching events in the ${runs.length} stored simulation(s) in ${file}.`);
    return 0;
  } finally {
    await db.close();
  }
};
