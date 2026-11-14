import { and, asc, desc, eq, gte, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { readAudit, toJsonData, type AuditEvent, type AuditSink, type AuditType } from '../audit/audit.ts';
import { log } from '../log.ts';
import { openDatabase, type ConductorDb } from './database.ts';
import { auditEvent } from './schema.ts';

/**
 * The audit trail in SQLite. Events have the same shape as in the JSON Lines format ({ ts, type, ...data }),
 * so the report, the notifier and the JSONL tools treat both alike.
 */

/** Appends events to `audit_event`, in order (writes are synchronous). Failures are logged, never thrown. */
export class SqliteAuditLog implements AuditSink {
  readonly #db: ConductorDb;
  readonly #now: () => Date;
  readonly #serviceRunId: number | undefined;

  constructor(db: ConductorDb, options: { now?: () => Date; serviceRunId?: number } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#serviceRunId = options.serviceRunId;
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    try {
      this.#db
        .insert(auditEvent)
        .values({ ts: this.#now(), type, serviceRunId: this.#serviceRunId ?? null, data: toJsonData(data) })
        .run();
    } catch (err) {
      log.error(`Could not write audit event ${type} to the database`, err);
    }
  }
}

export interface AuditQuery {
  since?: Date;
  until?: Date;
  /** A sequence id or its beginning. */
  sequence?: string;
  serviceRunId?: number;
  /** Event types to leave out. */
  excludeTypes?: readonly AuditType[];
}

const conditions = (q: AuditQuery): SQL | undefined =>
  and(
    q.since ? gte(auditEvent.ts, q.since) : undefined,
    q.until ? lte(auditEvent.ts, q.until) : undefined,
    q.sequence ? sql`substr(${auditEvent.sequenceId}, 1, ${q.sequence.length}) = ${q.sequence}` : undefined,
    q.serviceRunId !== undefined ? eq(auditEvent.serviceRunId, q.serviceRunId) : undefined,
    q.excludeTypes?.length ? notInArray(auditEvent.type, [...q.excludeTypes]) : undefined,
  );

const toEvent = (row: { ts: Date; type: AuditType; data: Record<string, unknown> }): AuditEvent => ({ ts: row.ts.toISOString(), type: row.type, ...row.data });

/** Events in the order they were recorded. */
export const queryAuditEvents = (db: ConductorDb, q: AuditQuery = {}): AuditEvent[] =>
  db
    .select({ ts: auditEvent.ts, type: auditEvent.type, data: auditEvent.data })
    .from(auditEvent)
    .where(conditions(q))
    .orderBy(asc(auditEvent.id))
    .all()
    .map(toEvent);

/** The most recent event matching the query. */
export const lastAuditEventOf = (db: ConductorDb, q: AuditQuery = {}): AuditEvent | undefined => {
  const row = db
    .select({ ts: auditEvent.ts, type: auditEvent.type, data: auditEvent.data })
    .from(auditEvent)
    .where(conditions(q))
    .orderBy(desc(auditEvent.id))
    .limit(1)
    .get();
  return row ? toEvent(row) : undefined;
};

/**
 * Events from an audit source for `npm run audit`: a JSON Lines file (simulations, older versions) or a
 * conductor database, opened read-only so it can be read next to the running service. Time and sequence
 * filters are applied in SQL; the caller applies the rest (filterEvents).
 */
export const readAuditSource = async (
  path: string,
  q: Pick<AuditQuery, 'since' | 'until' | 'sequence'> = {},
): Promise<{ events: AuditEvent[]; skipped: number }> => {
  if (path.endsWith('.jsonl')) return readAudit(path);
  const db = openDatabase(path, { readOnly: true });
  try {
    return { events: queryAuditEvents(db, q), skipped: 0 };
  } finally {
    db.$client.close();
  }
};
