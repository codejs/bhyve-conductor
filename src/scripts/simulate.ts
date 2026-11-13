/**
 * Plays scenarios (normal watering, outages, crashes, dead batteries, storms...) against the real
 * conductor code in virtual time, and writes an audit trail per scenario for review.
 *
 *   npm run simulate -- --list                       what scenarios there are
 *   npm run simulate -- bhyve-socket-outage          run one (or several) and show the audit trail + notifications
 *   npm run simulate -- --all                        run all of them, with a summary table
 *   npm run simulate -- --all --quiet                only the summary table
 *   npm run simulate -- tuya-outage --telegram       also send its notifications to your Telegram chat (as a preview)
 *
 * Options: --out-dir <dir> (default: simulations), --tz <zone> (default: America/Chicago), --verbose (service logs)
 * Each scenario's trail is saved as <out-dir>/<scenario>.audit.jsonl, so the audit tools work on it too:
 *   npm run audit -- --file simulations/bhyve-socket-outage.audit.jsonl --summary --since 2026-01-01
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { formatEvent, formatSummary, formatTime, summarize, RECOVERY_TYPES } from '../audit/report.ts';
import { log } from '../log.ts';
import { DeliveryQueue } from '../notify/queue.ts';
import { TelegramClient } from '../notify/telegram.ts';
import { runScenario, type SimResult } from '../sim/runner.ts';
import { SCENARIOS, scenarioById } from '../sim/scenarios.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    telegram: { type: 'boolean', default: false },
    'out-dir': { type: 'string', default: 'simulations' },
    tz: { type: 'string' },
  },
});

if (values.list || (!values.all && positionals.length === 0)) {
  console.log('Scenarios (run with: npm run simulate -- <id> [<id>...] | --all):\n');
  for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(22)} ${s.title}`);
  process.exit(0);
}

const unknown = positionals.filter((id) => !scenarioById(id));
if (unknown.length > 0) {
  console.error(`Unknown scenario(s): ${unknown.join(', ')}. See: npm run simulate -- --list`);
  process.exit(1);
}
const chosen = values.all ? SCENARIOS : positionals.map((id) => scenarioById(id)).filter((s) => s !== undefined);

// The service logs real wall-clock times, which only confuse a simulated timeline.
if (!values.verbose) {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) log[level] = () => {};
}

const plain = (html: string): string =>
  html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const rule = (title: string) => `\n${'═'.repeat(3)} ${title} ${'═'.repeat(Math.max(3, 100 - title.length))}`;

const outDir = values['out-dir'];
await mkdir(outDir, { recursive: true });
const results: SimResult[] = [];

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
  if (values.quiet) continue;

  console.log(rule(`${scenario.id}: ${scenario.title}`));
  console.log(scenario.story);
  console.log(`\nAudit trail (${tz}; ! = failure or recovery):`);
  for (const e of result.events) console.log(`  ${formatEvent(e, tz)}`);
  console.log(`\nTelegram notifications (${result.notifications.length}), at the time they would be sent:`);
  if (result.notifications.length === 0) console.log('  none');
  for (const n of result.notifications) {
    const [first, ...rest] = plain(n.text).split('\n');
    console.log(`  ${formatTime(n.sentAt, tz).slice(11, 16)}  ${n.severity.toUpperCase().padEnd(8)} ${first}`);
    for (const line of rest) console.log(`  ${' '.repeat(16)}${line}`);
  }
  console.log('\nSummary:');
  console.log(formatSummary(summarize(result.events), tz).replace(/^/gm, '  '));
  console.log('\nWhat to look for:');
  for (const item of scenario.lookFor) console.log(`  • ${item}`);
  console.log(`\nSaved: ${file}`);
  console.log(`Review: npm run audit -- --file ${file} --since 2026-01-01 --tz ${tz} [--summary | --recovery | --sequence <id>]`);
}

if (chosen.length > 1 || values.quiet) {
  console.log(rule('All scenarios'));
  console.log(`  ${'scenario'.padEnd(22)} ${'events'.padStart(6)} ${'!'.padStart(4)}  notifications (crit/warn/info)  watering sequences`);
  for (const r of results) {
    const s = summarize(r.events);
    const count = (sev: string) => r.notifications.filter((n) => n.severity === sev).length;
    const seqs = s.sequences.map((q) => q.status).join(', ') || '—';
    console.log(
      `  ${r.scenario.id.padEnd(22)} ${String(r.events.length).padStart(6)} ${String(r.events.filter((e) => RECOVERY_TYPES.has(e.type)).length).padStart(4)}` +
        `  ${`${count('critical')}/${count('warning')}/${count('info')}`.padEnd(30)}  ${seqs}`,
    );
  }
  console.log(`\n  Audit trails and notifications saved in ${outDir}/`);
}

if (values.telegram) {
  const { loadConfig } = await import('../config.ts');
  const env = loadConfig(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('\n--telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.');
    process.exit(1);
  }
  const failures: string[] = [];
  const queue = new DeliveryQueue(
    new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }),
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
  console.log(`\nSending ${total} notification(s) to Telegram (about one per second)...`);
  await queue.flush();
  console.log(failures.length ? `Failed: ${failures[0]}` : 'Sent.');
}
