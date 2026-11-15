import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { formatEvent, formatSummary, formatTime, summarize, RECOVERY_TYPES } from '../audit/report.ts';
import { openDatabase, type ConductorDb } from '../db/database.ts';
import { DeliveryQueue } from '../notify/queue.ts';
import { TelegramClient } from '../notify/telegram.ts';
import { runScenario, type SimResult } from './runner.ts';
import { SCENARIOS, scenarioById } from './scenarios.ts';
import { storeSimulation } from './store.ts';

/**
 * `npm run simulate`: plays scenarios against the real conductor code in virtual time, prints their audit
 * trails and notifications, saves them as JSON Lines files and, with --store, in the database (see
 * store.ts) for `npm run audit -- --for-simulation`.
 */

export interface SimulateCommandIo {
  out(text: string): void;
  err(text: string): void;
  now(): Date;
  /** The database for --store when there's no --db (CONDUCTOR_DB); only asked for then. */
  defaultDatabase(): string;
  /** Telegram credentials for --telegram (from .env); only asked for then. */
  telegram(): { token?: string | undefined; chatId?: string | undefined };
}

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      list: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      telegram: { type: 'boolean', default: false },
      store: { type: 'boolean', default: false },
      db: { type: 'string' },
      'out-dir': { type: 'string', default: 'simulations' },
      tz: { type: 'string' },
    },
  });

const plain = (html: string): string =>
  html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const rule = (title: string) => `\n${'═'.repeat(3)} ${title} ${'═'.repeat(Math.max(3, 100 - title.length))}`;

/** Runs the command; returns the exit code. `--verbose` is the caller's business (service logs). */
export const runSimulateCommand = async (argv: readonly string[], io: SimulateCommandIo): Promise<number> => {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}. See: npm run simulate -- --list`);
    return 2;
  }
  const { values, positionals } = parsed;
  const say = (text: string) => io.out(text);

  if (values.list || (!values.all && positionals.length === 0)) {
    say('Scenarios (run with: npm run simulate -- <id> [<id>...] | --all; add --store to keep the results in the database):\n');
    for (const s of SCENARIOS) say(`  ${s.id.padEnd(22)} ${s.title}`);
    return 0;
  }
  if (values.db !== undefined && !values.store) {
    io.err('--db says where --store puts the results; add --store');
    return 2;
  }

  const unknown = positionals.filter((id) => !scenarioById(id));
  if (unknown.length > 0) {
    io.err(`Unknown scenario(s): ${unknown.join(', ')}. See: npm run simulate -- --list`);
    return 1;
  }
  const chosen = values.all ? SCENARIOS : positionals.map((id) => scenarioById(id)).filter((s) => s !== undefined);

  let telegram: { token: string; chatId: string } | undefined;
  if (values.telegram) {
    let token: string | undefined;
    let chatId: string | undefined;
    try {
      ({ token, chatId } = io.telegram());
    } catch (err) {
      io.err(`--telegram: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!token || !chatId) {
      io.err('--telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.');
      return 1;
    }
    telegram = { token, chatId };
  }

  // Opened (and brought up to date) before anything runs, so a database problem shows at once.
  let dbPath: string | undefined;
  let db: ConductorDb | undefined;
  if (values.store) {
    try {
      dbPath = values.db ?? io.defaultDatabase();
      db = openDatabase(dbPath);
    } catch (err) {
      io.err(`--store: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const results: SimResult[] = [];
  try {
    const outDir = values['out-dir'];
    await mkdir(outDir, { recursive: true });

    for (const scenario of chosen) {
      const result = await runScenario(scenario);
      results.push(result);
      const tz = values.tz ?? result.timeZone;
      const file = join(outDir, `${scenario.id}.audit.jsonl`);
      await writeFile(file, result.events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      await writeFile(
        join(outDir, `${scenario.id}.notifications.jsonl`),
        result.notifications.map((n) => JSON.stringify(n)).join('\n') + (result.notifications.length ? '\n' : ''),
        'utf8',
      );
      if (db) await storeSimulation(db, result, io.now());
      if (values.quiet) continue;

      say(rule(`${scenario.id}: ${scenario.title}`));
      say(scenario.story);
      say(`\nAudit trail (${tz}; ! = failure or recovery):`);
      for (const e of result.events) say(`  ${formatEvent(e, tz)}`);
      say(`\nTelegram notifications (${result.notifications.length}), at the time they would be sent:`);
      if (result.notifications.length === 0) say('  none');
      for (const n of result.notifications) {
        const [first, ...rest] = plain(n.text).split('\n');
        say(`  ${formatTime(n.sentAt, tz).slice(11, 16)}  ${n.severity.toUpperCase().padEnd(8)} ${first}`);
        for (const line of rest) say(`  ${' '.repeat(16)}${line}`);
      }
      say('\nSummary:');
      say(formatSummary(summarize(result.events), tz).replace(/^/gm, '  '));
      say('\nWhat to look for:');
      for (const item of scenario.lookFor) say(`  • ${item}`);
      say(`\nSaved: ${file}${db ? ` and in ${dbPath}` : ''}`);
      say(
        db
          ? `Review: npm run audit -- --for-simulation --scenario ${scenario.id}${values.db !== undefined ? ` --file ${dbPath}` : ''} [--summary | --recovery | --sequence <id>]`
          : `Review: npm run audit -- --file ${file} --since 2026-01-01 --tz ${tz} [--summary | --recovery | --sequence <id>]`,
      );
    }

    if (chosen.length > 1 || values.quiet) {
      say(rule('All scenarios'));
      say(`  ${'scenario'.padEnd(22)} ${'events'.padStart(6)} ${'!'.padStart(4)}  notifications (crit/warn/info)  watering sequences`);
      for (const r of results) {
        const s = summarize(r.events);
        const count = (sev: string) => r.notifications.filter((n) => n.severity === sev).length;
        const seqs = s.sequences.map((q) => q.status).join(', ') || '—';
        say(
          `  ${r.scenario.id.padEnd(22)} ${String(r.events.length).padStart(6)} ${String(r.events.filter((e) => RECOVERY_TYPES.has(e.type)).length).padStart(4)}` +
            `  ${`${count('critical')}/${count('warning')}/${count('info')}`.padEnd(30)}  ${seqs}`,
        );
      }
      say(`\n  Audit trails and notifications saved in ${outDir}/`);
    }
    if (db) {
      say(
        `\nStored ${results.length} simulation result(s) in ${dbPath} (replacing earlier results of the same scenarios).` +
          `\nReview: npm run audit -- --for-simulation${values.db !== undefined ? ` --file ${dbPath}` : ''} [--scenario <id>] [--summary]`,
      );
    }
  } finally {
    await db?.close();
  }

  if (telegram) {
    const failures: string[] = [];
    const queue = new DeliveryQueue(
      new TelegramClient(telegram),
      { maxBatchChars: 0 }, // one message per notification, as the real service would send them one by one
      (d) => failures.push(d.error),
    );
    let total = 0;
    for (const r of results) {
      for (const n of r.notifications) {
        queue.enqueue(`🧪 <i>Simulation: ${r.scenario.id}</i>\n${n.text}`);
        total++;
      }
    }
    say(`\nSending ${total} notification(s) to Telegram (about one per second)...`);
    await queue.flush();
    say(failures.length ? `Failed: ${failures[0]}` : 'Sent.');
  }
  return 0;
};
