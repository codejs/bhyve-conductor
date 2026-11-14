/**
 * The vocabulary of the data model (prisma/schema.prisma) and the checks the store makes before it writes.
 *
 * SQLite constraints that Prisma's schema language can't express (value lists, ranges, "one active sequence
 * per device") are checked here instead: every write goes through SqliteStore, which calls these.
 */

export const RUN_MODES = ['continuous', 'once'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const SEQUENCE_STATUSES = ['active', 'completed', 'abandoned'] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

/**
 * pending:   not sent yet, or sent and provably not started (it will be retried)
 * sending:   marked just before the command went out; still 'sending' after a restart = crashed mid-send
 * delivered: counted as delivered (see WAVE_DELIVERIES); its minutes are in zone_watering
 * skipped:   never sent because the sequence was abandoned
 */
export const WAVE_STATUSES = ['pending', 'sending', 'delivered', 'skipped'] as const;
export type WaveStatus = (typeof WAVE_STATUSES)[number];

/**
 * How delivery was established: a B-hyve event, the device status, unconfirmed (counted so it is never
 * sent twice), or assumed after being found in flight at a restart.
 */
export const WAVE_DELIVERIES = ['event', 'status', 'unconfirmed', 'assumed'] as const;
export type WaveDelivery = (typeof WAVE_DELIVERIES)[number];

/** Prefix of an alert key (see conductor/alerts.ts). */
export const ALERT_KINDS = ['battery', 'moisture', 'device', 'daily-limit'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_STATES = ['low', 'high', 'offline', 'reached'] as const;
export type AlertConditionState = (typeof ALERT_STATES)[number];

/** Longest manual run B-hyve accepts (plan.ts MAX_RUN_MINUTES). */
export const MAX_RUN_MINUTES = 240;

/** A value the store refuses to write (what a CHECK constraint used to catch). */
export class InvalidDataError extends Error {
  override readonly name = 'InvalidDataError';
}

export const assertOneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new InvalidDataError(`${what} must be one of ${allowed.join(', ')} (got "${value}")`);
  return value as T;
};

/** The kind of an AlertTracker key ("battery:sensor:s1" → "battery"). */
export const alertKindOf = (key: string): AlertKind => assertOneOf(key.slice(0, Math.max(0, key.indexOf(':'))), ALERT_KINDS, `the kind of alert "${key}"`);

/** "<deviceId>:<station>" → its parts (device ids may contain ':'; the station is after the last one). */
export const parseZoneKey = (key: string): { deviceId: string; station: number } => {
  const sep = key.lastIndexOf(':');
  const station = Number(key.slice(sep + 1));
  if (sep <= 0 || !Number.isInteger(station) || station < 1) throw new InvalidDataError(`not a zone key: "${key}"`);
  return { deviceId: key.slice(0, sep), station };
};

/** A run B-hyve would accept on a real station. */
export const assertStationRun = (station: number, minutes: number): void => {
  if (!Number.isInteger(station) || station < 1) throw new InvalidDataError(`station must be a positive whole number (got ${station})`);
  if (!(minutes > 0 && minutes <= MAX_RUN_MINUTES)) throw new InvalidDataError(`a run must last more than 0 and at most ${MAX_RUN_MINUTES} min (got ${minutes})`);
};

/** A point in time that can be stored (an invalid Date would become "Invalid Date"). */
export const assertTime = (at: Date, what: string): void => {
  if (!Number.isFinite(at.getTime())) throw new InvalidDataError(`${what} is not a valid time`);
};

/** One line per sequence: what was planned vs. what happened (the simulator, reports). */
export interface SequenceResult {
  id: string;
  deviceId: string;
  createdAt: Date;
  status: SequenceStatus;
  endedAt: Date | null;
  abandonReason: string | null;
  cycles: number;
  cyclesDelivered: number;
  plannedMinutes: number;
  deliveredMinutes: number;
  /** Station runs counted as delivered without confirmation ('unconfirmed' or 'assumed'). */
  uncertainStationRuns: number;
  failedAttempts: number;
  /** When the water went off (the code's `sequence.finished`, which isn't persisted otherwise). */
  waterOffAt: Date | null;
}
