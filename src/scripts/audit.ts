/**
 * Review the audit trail: watering sequences, connection outages and how they were recovered.
 *
 *   npm run audit                                  last 24 hours, everything
 *   npm run audit -- --recovery                    only failures and recoveries
 *   npm run audit -- --summary --since 7d          outages + fate of each watering sequence
 *   npm run audit -- --sequence 3f9a1c2e           one sequence, start to finish
 *   npm run audit -- --zone <deviceId>:2           one zone
 *   npm run audit -- --device <deviceId>           one B-hyve device
 *   npm run audit -- --type connection,socket      by event type (prefixes)
 *   npm run audit -- --since 2026-07-01T06:00 --until 2026-07-01T12:00
 *   npm run audit -- --sequence 3f9a1c2e           (the first characters of a sequence id are enough)
 *   npm run audit -- --json                        raw JSON lines (for jq, spreadsheets, ...)
 *   npm run audit -- --file other.db               another database (default: CONDUCTOR_DB), read-only
 *   npm run audit -- --file trail.audit.jsonl      a JSON Lines trail (simulations, versions before the database)
 *
 * Simulations stored with `npm run simulate -- --store` never show up above; ask for them:
 *   npm run audit -- --for-simulation                              every stored simulation, whole simulated time
 *   npm run audit -- --for-simulation --scenario bhyve-socket-outage --summary
 *   npm run audit -- --for-simulation --recovery --json            (each line gets "simulation": <scenario>)
 */
import { runAuditCommand } from '../audit/command.ts';
import { loadConfig } from '../config.ts';

process.exitCode = await runAuditCommand(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  now: () => new Date(),
  defaultDatabase: () => loadConfig(['CONDUCTOR_DB']).CONDUCTOR_DB,
});
