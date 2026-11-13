import { appendFile, open, readFile } from 'node:fs/promises';
import { log } from '../log.ts';

/**
 * Append-only audit trail (JSON Lines): one event per line, never rewritten, so it can be reviewed
 * after an incident with `npm run audit`. Everything that affects watering or connectivity goes here.
 */

export type AuditType =
  | 'service.started'
  | 'service.stopped'
  /** The previous run ended without `service.stopped` (crash, kill -9, power loss). */
  | 'service.unclean_shutdown'
  | 'poll.failed'
  /** A remote service stopped answering / started answering again (transitions only). */
  | 'connection.lost'
  | 'connection.restored'
  /** The B-hyve command socket. */
  | 'socket.connected'
  | 'socket.disconnected'
  /** A zone has no usable sensor reading / has one again. */
  | 'zone.no_data'
  | 'zone.data_restored'
  | 'sequence.started'
  | 'sequence.resumed'
  | 'sequence.completed'
  | 'sequence.abandoned'
  | 'wave.sent'
  | 'wave.confirmed'
  /** Sent, but neither an event nor the device status confirmed it; assumed delivered (never re-sent). */
  | 'wave.unconfirmed'
  /** Sent, but B-hyve reports the device idle: it didn't start, so it will be retried. */
  | 'wave.not_started'
  | 'wave.send_failed'
  /** The device couldn't take the wave yet (offline, busy, status unknown). */
  | 'wave.deferred'
  | 'wave.retry_scheduled'
  /** Found in flight after a restart: we can't know if it ran, so it's counted as delivered. */
  | 'wave.assumed_delivered'
  | 'state.save_failed'
  /** All cycles were sent and the last one's run time has elapsed: the water is off. */
  | 'sequence.finished'
  | 'battery.low'
  | 'battery.ok'
  /** A fresh sensor reading is outside the zone's critical limits / back inside them. */
  | 'moisture.critical_low'
  | 'moisture.critical_high'
  | 'moisture.normal'
  /** A B-hyve controller lost / regained its connection to the B-hyve cloud. */
  | 'device.offline'
  | 'device.online'
  /** A zone used its whole daily allowance and is still below its threshold. */
  | 'zone.daily_limit_reached'
  /** A notification could not be delivered (written to the audit file only). */
  | 'notification.failed'
  /** A zone's decision changed (e.g. moist → dry → waiting for rain). Only changes are recorded. */
  | 'zone.decision'
  /** Marks what a simulation did (fault injected, time of day...); only in simulated trails. */
  | 'simulation.note';

export interface AuditEvent {
  ts: string;
  type: AuditType;
  [key: string]: unknown;
}

export interface AuditSink {
  record(type: AuditType, data?: Record<string, unknown>): void;
}

/** Appends to a JSONL file. Writes are queued so events keep their order; failures are logged, never thrown. */
export class FileAuditLog implements AuditSink {
  readonly #path: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = path;
    this.#now = now;
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({ ts: this.#now().toISOString(), type, ...data }, errorReplacer)}\n`;
    this.#queue = this.#queue
      .then(() => appendFile(this.#path, line, 'utf8'))
      .catch((err: unknown) => log.error(`Could not write audit event ${type} to ${this.#path}`, err));
  }

  /** Resolves once everything recorded so far is on disk. */
  flush(): Promise<void> {
    return this.#queue;
  }
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

/** The last complete event in the file, reading only its tail (the file grows forever). */
export const lastAuditEvent = async (path: string, tailBytes = 64 * 1024): Promise<AuditEvent | undefined> => {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return parseAudit(buf.toString('utf8')).events.at(-1);
  } finally {
    await handle.close();
  }
};
