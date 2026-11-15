/**
 * Plays scenarios (normal watering, outages, crashes, dead batteries, storms...) against the real
 * conductor code in virtual time, and writes an audit trail per scenario for review.
 *
 *   npm run simulate -- --list                       what scenarios there are
 *   npm run simulate -- bhyve-socket-outage          run one (or several) and show the audit trail + notifications
 *   npm run simulate -- --all                        run all of them, with a summary table
 *   npm run simulate -- --all --quiet                only the summary table
 *   npm run simulate -- --all --store                also keep the results in the database (CONDUCTOR_DB)
 *   npm run simulate -- tuya-outage --telegram       also send its notifications to your Telegram chat (as a preview)
 *
 * Options: --out-dir <dir> (default: simulations), --tz <zone> (default: America/Chicago), --verbose (service logs),
 *          --store [--db <path>] (default: CONDUCTOR_DB; storing a scenario again replaces its earlier result)
 * Each scenario's trail is saved as <out-dir>/<scenario>.audit.jsonl, so the audit tools work on it too:
 *   npm run audit -- --file simulations/bhyve-socket-outage.audit.jsonl --summary --since 2026-01-01
 * Stored results are kept apart from the conductor's own trail and only shown when asked for:
 *   npm run audit -- --for-simulation [--scenario bhyve-socket-outage] [--summary]
 */
import { loadConfig } from '../config.ts';
import { log } from '../log.ts';
import { runSimulateCommand } from '../sim/command.ts';

const argv = process.argv.slice(2);
// The service logs real wall-clock times, which only confuse a simulated timeline.
if (!argv.includes('--verbose')) {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) log[level] = () => {};
}

process.exitCode = await runSimulateCommand(argv, {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  now: () => new Date(),
  defaultDatabase: () => loadConfig(['CONDUCTOR_DB']).CONDUCTOR_DB,
  telegram: () => {
    const env = loadConfig(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
    return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  },
});
