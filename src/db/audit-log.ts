import { readAudit, toJsonData, type AuditEvent, type AuditSink, type AuditType } from '../audit/audit.ts';
import { log } from '../log.ts';
import { openDatabase, type ConductorDb } from './database.ts';
import type { Prisma } from './generated/client.ts';

/**
 * The audit trail in SQLite, with Prisma. Events have the same shape as in the JSON Lines format
 * ({ ts, type, ...data }), so the report, the notifier and the JSONL tools treat both alike.
 */

/**
 * A payload field as a filter column: strings as they are, anything else as text (what the drizzle-based
 * version's generated columns held, `CAST(json_extract(...) AS TEXT)`), absent as NULL.
 */
export const filterValue = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

/**
 * Appends events to `audit_event`, in the order they are recorded. `record()` returns at once (AuditSink is
 * synchronous); the inserts queue behind each other. Failures are logged, never thrown. `flush()` waits for
 * everything recorded so far.
 */
export class SqliteAuditLog implements AuditSink {
  readonly #db: ConductorDb;
  readonly #now: () => Date;
  readonly #serviceRunId: number | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(db: ConductorDb, options: { now?: () => Date; serviceRunId?: number } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#serviceRunId = options.serviceRunId;
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    let row: Prisma.AuditEventUncheckedCreateInput;
    try {
      // Taken now: the time of the event, and its data as it was (the caller may change its objects).
      const payload = toJsonData(data);
      row = {
        ts: this.#now(),
        type,
        serviceRunId: this.#serviceRunId ?? null,
        data: payload as Prisma.InputJsonValue,
        deviceId: filterValue(payload.device),
        zoneKey: filterValue(payload.zone),
        sequenceId: filterValue(payload.sequence),
      };
    } catch (err) {
      log.error(`Could not record audit event ${type}`, err);
      return;
    }
    this.#queue = this.#queue
      .then(async () => {
        await this.#db.prisma.auditEvent.create({ data: row, select: { id: true } });
      })
      .catch((err: unknown) => log.error(`Could not write audit event ${type} to the database`, err));
  }

  /** Resolves once everything recorded so far is written (or has failed). */
  flush(): Promise<void> {
    return this.#queue;
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

const whereOf = (q: AuditQuery): Prisma.AuditEventWhereInput => ({
  ...(q.since || q.until ? { ts: { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lte: q.until } : {}) } } : {}),
  ...(q.sequence ? { sequenceId: { startsWith: q.sequence } } : {}),
  ...(q.serviceRunId !== undefined ? { serviceRunId: q.serviceRunId } : {}),
  ...(q.excludeTypes?.length ? { type: { notIn: [...q.excludeTypes] } } : {}),
});

const toEvent = (row: { ts: Date; type: string; data: Prisma.JsonValue }): AuditEvent => ({
  ts: row.ts.toISOString(),
  type: row.type as AuditType,
  ...(row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {}),
});

/** Events in the order they were recorded. */
export const queryAuditEvents = async (db: ConductorDb, q: AuditQuery = {}): Promise<AuditEvent[]> =>
  (await db.prisma.auditEvent.findMany({ where: whereOf(q), orderBy: { id: 'asc' }, select: { ts: true, type: true, data: true } })).map(toEvent);

/** The most recent event matching the query. */
export const lastAuditEventOf = async (db: ConductorDb, q: AuditQuery = {}): Promise<AuditEvent | undefined> => {
  const row = await db.prisma.auditEvent.findFirst({ where: whereOf(q), orderBy: { id: 'desc' }, select: { ts: true, type: true, data: true } });
  return row ? toEvent(row) : undefined;
};

/**
 * Events from an audit source for `npm run audit`: a JSON Lines file (simulations, older versions) or a
 * conductor database, opened read-only so it can be read next to the running service. Time and sequence
 * filters are applied in the query; the caller applies the rest (filterEvents).
 */
export const readAuditSource = async (
  path: string,
  q: Pick<AuditQuery, 'since' | 'until' | 'sequence'> = {},
): Promise<{ events: AuditEvent[]; skipped: number }> => {
  if (path.endsWith('.jsonl')) return readAudit(path);
  const db = openDatabase(path, { readOnly: true });
  try {
    return { events: await queryAuditEvents(db, q), skipped: 0 };
  } finally {
    await db.close();
  }
};
