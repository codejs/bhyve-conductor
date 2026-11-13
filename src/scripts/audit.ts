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
 *   npm run audit -- --json                        raw JSON lines (for jq, spreadsheets, ...)
 *   npm run audit -- --file /path/to/audit.jsonl   another file (default: CONDUCTOR_AUDIT)
 */
import { parseArgs } from 'node:util';
import { readAudit } from '../audit/audit.ts';
import { filterEvents, formatEvent, formatSummary, parseSince, summarize, type AuditFilter } from '../audit/report.ts';
import { loadConfig } from '../config.ts';

const { values } = parseArgs({
  options: {
    since: { type: 'string', default: '24h' },
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
  },
});

const now = new Date();
const file = values.file ?? loadConfig(['CONDUCTOR_AUDIT']).CONDUCTOR_AUDIT;
const { events, skipped } = await readAudit(file);

const filter: AuditFilter = {
  // A sequence id is specific enough on its own; don't hide its early events behind --since.
  ...(values.sequence ? {} : { since: parseSince(values.since, now) }),
  ...(values.until ? { until: parseSince(values.until, now) } : {}),
  ...(values.type ? { types: values.type.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  ...(values.device ? { device: values.device } : {}),
  ...(values.zone ? { zone: values.zone } : {}),
  ...(values.sequence ? { sequence: values.sequence } : {}),
  recovery: values.recovery,
};
const selected = filterEvents(events, filter);

if (values.json) {
  for (const e of selected) console.log(JSON.stringify(e));
} else if (values.summary) {
  console.log(formatSummary(summarize(selected), values.tz));
} else {
  if (selected.length === 0) console.log(`No matching events in ${file}.`);
  for (const e of selected) console.log(formatEvent(e, values.tz));
}
if (skipped > 0) console.error(`(${skipped} unreadable line(s) in ${file} skipped — e.g. a line cut short by a crash)`);
