import { readFile } from 'node:fs/promises';
import { log } from '../log.ts';
import type { AuditEvent, AuditType } from './types.ts';

/**
 * Audit trail: everything that affects watering or connectivity, never rewritten, so it can be reviewed
 * after an incident with `npm run audit`. The service stores it in SQLite (db/audit-log.ts); the JSON Lines
 * format here is for simulations, exports and the trail of older versions.
 */

/** The event types and shape live in types.ts (no Node imports, shared with the web app); re-exported here. */
export type { AuditEvent, AuditType } from './types.ts';

export interface AuditSink {
  record(type: AuditType, data?: Record<string, unknown>): void;
}

/** Keeps events in memory (tests, or when no audit file is wanted). */
export class MemoryAuditLog implements AuditSink {
  readonly events: AuditEvent[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    this.events.push(JSON.parse(JSON.stringify({ ts: this.#now().toISOString(), type, ...data }, errorReplacer)) as AuditEvent);
  }

  ofType(type: AuditType): AuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** Errors don't serialize with JSON.stringify; keep their message. */
const errorReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Error ? value.message : value instanceof Date ? value.toISOString() : value;

/** An event's data as it will read back: JSON only (Errors become their message, Dates ISO strings). */
export const toJsonData = (data: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(data, errorReplacer)) as Record<string, unknown>;

/** Sends every event to several sinks (e.g. the audit file and the notifier). One failing doesn't affect the others. */
export const teeAudit = (...sinks: AuditSink[]): AuditSink => ({
  record(type, data) {
    for (const sink of sinks) {
      try {
        sink.record(type, data);
      } catch (err) {
        log.error(`Audit sink failed on ${type}`, err);
      }
    }
  },
});

/** Message of an unknown thrown value, for audit records. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Reads an audit file. Lines that aren't valid JSON events (e.g. a torn last line after a crash) are skipped. */
export const readAudit = async (path: string): Promise<{ events: AuditEvent[]; skipped: number }> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], skipped: 0 };
    throw err;
  }
  return parseAudit(text);
};

export const parseAudit = (text: string): { events: AuditEvent[]; skipped: number } => {
  const events: AuditEvent[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEvent;
      if (typeof e.ts === 'string' && typeof e.type === 'string') events.push(e);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
};
