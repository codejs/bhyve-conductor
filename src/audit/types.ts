/**
 * The shape of an audit event and the kinds there are. No Node imports: the web app shows the trail with the
 * same types (and audit/report.ts, which describes events, stays usable in a browser).
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
  /** Saving state (the database) started failing / works again. Transitions only. */
  | 'state.save_failed'
  | 'state.save_restored'
  /** The JSON state file and JSONL audit trail of an older version were imported into the database. */
  | 'storage.imported'
  /** A database of the drizzle-based version was converted to the current (Prisma) format. */
  | 'storage.transferred'
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
