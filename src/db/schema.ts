/**
 * Storage model (drizzle-orm, SQLite). The design and the reasons behind each table are in
 * docs/sqlite-storage.md. This file is the source of truth for the schema: migrations in drizzle/ are
 * generated from it with `npm run db:generate`.
 *
 * Conventions
 *  - Timestamps are UTC instants stored as `Date#toISOString()` text ("2026-07-01T11:00:00.000Z"). That
 *    format is fixed-width, so text order is time order and range queries use plain indexes. A CHECK rejects
 *    any other spelling, which would silently break that ordering. In TypeScript they are `Date`s
 *    (see `isoTimestamp`). They always come from the app's Clock, never from SQLite (no `now` defaults):
 *    simulations run in virtual time.
 *  - Durations are REAL minutes, as in the code (cycles can be 2.5 min).
 *  - Zone key = "<deviceId>:<station>" (conductor/config.ts zoneKey()).
 *
 * Not expressible here, so kept in a hand-written migration (drizzle/*_append_only_triggers):
 * the triggers that make `zone_watering` and `audit_event` append-only.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
  unique,
  uniqueIndex,
  type SQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import type { AuditType } from '../audit/audit.ts';
import type { WaterBudget } from '../conductor/water-budget.ts';

// ---------------------------------------------------------------------------------------------------
// Column types and constraint helpers
// ---------------------------------------------------------------------------------------------------

/** A UTC instant: `Date` in TypeScript, `toISOString()` text in the database. */
export const isoTimestamp = customType<{ data: Date; driverData: string; jsonData: string }>({
  dataType: () => 'text',
  // toISOString() throws on an invalid Date, so a NaN time can never be stored.
  toDriver: (value) => value.toISOString(),
  fromDriver: (value) => new Date(value),
  // Relational queries return nested rows as JSON.
  fromJson: (value) => new Date(value),
});

/** The only timestamp spelling accepted (what `Date#toISOString()` produces for years 0000–9999). */
export const ISO_TIMESTAMP_GLOB = '????-??-??T??:??:??.???Z';

const isoCheck = (name: string, column: SQLiteColumn): ReturnType<typeof check> =>
  check(name, sql`${column} GLOB '${sql.raw(ISO_TIMESTAMP_GLOB)}'`);

/** `column IN ('a', 'b', ...)` from a constant list (the same list types the column). */
const oneOf = (name: string, column: SQLiteColumn, values: readonly string[]): ReturnType<typeof check> =>
  check(name, sql`${column} IN (${sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '))})`);

/**
 * SQLite lets a single-column primary key that isn't INTEGER hold NULL (a historical quirk), and drizzle-kit
 * never writes NOT NULL on a primary key column. So text keys get an explicit check.
 */
const keyNotNull = (name: string, column: SQLiteColumn): ReturnType<typeof check> => check(name, sql`${column} IS NOT NULL`);

const jsonCheck = (name: string, column: SQLiteColumn): ReturnType<typeof check> => check(name, sql`json_valid(${column})`);

/** A text field extracted from a JSON payload, always as TEXT (a numeric device id must not make it a number). */
const jsonText = (column: string, path: string): SQL => sql.raw(`CAST(json_extract(${column}, '${path}') AS TEXT)`);

// ---------------------------------------------------------------------------------------------------
// Value lists (typed columns + CHECK constraints)
// ---------------------------------------------------------------------------------------------------

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
const MAX_RUN_MINUTES = 240;

// ---------------------------------------------------------------------------------------------------
// 1. Service runs: one row per process start. Replaces "read the tail of the audit file" for
//    unclean-shutdown detection, and records which configuration was in force.
// ---------------------------------------------------------------------------------------------------

export const serviceRun = sqliteTable(
  'service_run',
  {
    id: integer('id').primaryKey(),
    startedAt: isoTimestamp('started_at').notNull(),
    mode: text('mode', { enum: RUN_MODES }).notNull(),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
    pid: integer('pid'),
    configHash: text('config_hash').notNull(),
    /** The effective (defaults-applied) ConductorConfig. */
    config: text('config_json', { mode: 'json' }).$type<unknown>().notNull(),
    /** Updated after every poll: the best estimate of when a crashed run died. */
    heartbeatAt: isoTimestamp('heartbeat_at').notNull(),
    stoppedAt: isoTimestamp('stopped_at'),
    /** 'SIGTERM' | 'SIGINT' | 'once' for clean stops; 'unclean' when a later run found it never stopped. */
    stopReason: text('stop_reason'),
  },
  (t) => [
    isoCheck('service_run_started_at_iso', t.startedAt),
    isoCheck('service_run_heartbeat_at_iso', t.heartbeatAt),
    isoCheck('service_run_stopped_at_iso', t.stoppedAt),
    oneOf('service_run_mode', t.mode, RUN_MODES),
    check('service_run_dry_run_bool', sql`${t.dryRun} IN (0, 1)`),
    jsonCheck('service_run_config_json', t.config),
    check('service_run_stopped_pair', sql`(${t.stoppedAt} IS NULL) = (${t.stopReason} IS NULL)`),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 2. Zone registry: FK anchor for history. conductor.json stays the source of truth for the rules;
//    rows are upserted from it at every start and never deleted (history outlives config changes).
// ---------------------------------------------------------------------------------------------------

export const zone = sqliteTable(
  'zone',
  {
    zoneKey: text('zone_key').primaryKey(),
    deviceId: text('device_id').notNull(),
    station: integer('station').notNull(),
    name: text('name').notNull(),
    firstSeenAt: isoTimestamp('first_seen_at').notNull(),
    lastSeenAt: isoTimestamp('last_seen_at').notNull(),
  },
  (t) => [
    keyNotNull('zone_key_not_null', t.zoneKey),
    unique('zone_device_station').on(t.deviceId, t.station),
    check('zone_station_positive', sql`${t.station} >= 1`),
    check('zone_key_matches', sql`${t.zoneKey} = ${t.deviceId} || ':' || ${t.station}`),
    isoCheck('zone_first_seen_at_iso', t.firstSeenAt),
    isoCheck('zone_last_seen_at_iso', t.lastSeenAt),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 3. Watering sequences: the conductor's watering schedule and its results (PendingSequence, kept
//    after it finishes). sequence -> waves (cycles with a soak between) -> stations in each wave.
// ---------------------------------------------------------------------------------------------------

export const wateringSequence = sqliteTable(
  'watering_sequence',
  {
    /** Full randomUUID(); messages and the CLI show the first 8 characters. Imported rows keep 8-char ids. */
    id: text('id').primaryKey(),
    /** NULL for rows imported from .conductor-state.json. */
    serviceRunId: integer('service_run_id').references(() => serviceRun.id),
    deviceId: text('device_id').notNull(),
    soakMinutes: real('soak_minutes').notNull(),
    createdAt: isoTimestamp('created_at').notNull(),
    status: text('status', { enum: SEQUENCE_STATUSES }).notNull().default('active'),
    endedAt: isoTimestamp('ended_at'),
    abandonReason: text('abandon_reason'),
  },
  (t) => [
    // The Sequencer never runs two sequences on one device (#active is keyed by deviceId). Enforced here
    // too: if memory and disk ever disagree, starting a second one fails instead of watering twice.
    keyNotNull('watering_sequence_id_not_null', t.id),
    uniqueIndex('watering_sequence_one_active_per_device').on(t.deviceId).where(sql`${t.status} = 'active'`),
    index('watering_sequence_created').on(t.createdAt),
    index('watering_sequence_device_created').on(t.deviceId, t.createdAt),
    check('watering_sequence_soak_nonnegative', sql`${t.soakMinutes} >= 0`),
    oneOf('watering_sequence_status', t.status, SEQUENCE_STATUSES),
    check('watering_sequence_ended_iff_not_active', sql`(${t.status} = 'active') = (${t.endedAt} IS NULL)`),
    check('watering_sequence_reason_iff_abandoned', sql`(${t.status} = 'abandoned') = (${t.abandonReason} IS NOT NULL)`),
    isoCheck('watering_sequence_created_at_iso', t.createdAt),
    isoCheck('watering_sequence_ended_at_iso', t.endedAt),
  ],
);

/**
 * Why each zone was watered: a snapshot of the ZoneDecision that led to the sequence (config and names
 * can change afterwards).
 */
export const sequenceZone = sqliteTable(
  'sequence_zone',
  {
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => wateringSequence.id, { onDelete: 'cascade' }),
    zoneKey: text('zone_key')
      .notNull()
      .references(() => zone.zoneKey),
    zoneName: text('zone_name').notNull(),
    /** The aggregated reading that drove the decision. */
    moisturePct: real('moisture_pct'),
    readingAt: isoTimestamp('reading_at'),
    thresholdPct: real('threshold_pct').notNull(),
    targetPct: real('target_pct').notNull(),
    /** ZoneDecision.runMinutes */
    requestedMinutes: real('requested_minutes').notNull(),
    /** What the daily cap still allowed. */
    allowanceMinutes: real('allowance_minutes'),
    /** WaterBudget.inches, when the forecast was used. */
    budgetInches: real('budget_inches'),
    budget: text('budget_json', { mode: 'json' }).$type<WaterBudget>(),
    detail: text('detail').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sequenceId, t.zoneKey] }),
    index('sequence_zone_zone').on(t.zoneKey),
    check('sequence_zone_requested_positive', sql`${t.requestedMinutes} > 0`),
    check('sequence_zone_budget_json', sql`${t.budget} IS NULL OR json_valid(${t.budget})`),
    isoCheck('sequence_zone_reading_at_iso', t.readingAt),
  ],
);

/**
 * One row per wave (cycle). The wave row is the authority for the sequence's progress (see the
 * pendingSequence view):
 *   PendingSequence.nextWave = lowest waveIndex still 'pending' or 'sending'
 *   PendingSequence.dueAt    = that wave's dueAt
 *   PendingSequence.attempts = that wave's failedAttempts
 *   PendingSequence.inFlight = that wave, if status = 'sending' ({ wave: waveIndex, since: sentAt })
 */
export const sequenceWave = sqliteTable(
  'sequence_wave',
  {
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => wateringSequence.id, { onDelete: 'cascade' }),
    /** 0-based; messages say "cycle waveIndex + 1". */
    waveIndex: integer('wave_index').notNull(),
    status: text('status', { enum: WAVE_STATUSES }).notNull().default('pending'),
    /**
     * When the wave is due: createdAt for the first, previous sentAt + its minutes + soak for later ones.
     * NULL until the previous wave is delivered. Retries keep it (the retry window is measured from it).
     */
    dueAt: isoTimestamp('due_at'),
    /**
     * 'sending': when the send started. 'delivered': when the send that counted started (the
     * WateringRun.at that cooldowns are measured from).
     */
    sentAt: isoTimestamp('sent_at'),
    delivery: text('delivery', { enum: WAVE_DELIVERIES }),
    /** Failed attempts (send failed, not started, deferred) before it was delivered or given up. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.sequenceId, t.waveIndex] }),
    check('sequence_wave_index_nonnegative', sql`${t.waveIndex} >= 0`),
    check('sequence_wave_attempts_nonnegative', sql`${t.failedAttempts} >= 0`),
    oneOf('sequence_wave_status', t.status, WAVE_STATUSES),
    // delivery may be NULL: in SQLite `NULL IN (...)` is NULL, which a CHECK accepts.
    oneOf('sequence_wave_delivery', t.delivery, WAVE_DELIVERIES),
    check(
      'sequence_wave_unsent_state',
      sql`${t.status} NOT IN ('pending', 'skipped') OR (${t.sentAt} IS NULL AND ${t.delivery} IS NULL)`,
    ),
    check(
      'sequence_wave_sending_state',
      sql`${t.status} <> 'sending' OR (${t.sentAt} IS NOT NULL AND ${t.delivery} IS NULL AND ${t.dueAt} IS NOT NULL)`,
    ),
    check('sequence_wave_delivered_state', sql`${t.status} <> 'delivered' OR (${t.sentAt} IS NOT NULL AND ${t.delivery} IS NOT NULL)`),
    isoCheck('sequence_wave_due_at_iso', t.dueAt),
    isoCheck('sequence_wave_sent_at_iso', t.sentAt),
  ],
);

/**
 * Stations in a wave. B-hyve runs them back to back in station order (plan.ts sorts them), so ordering by
 * station rebuilds the exact StationRun[] that was planned.
 */
export const waveStation = sqliteTable(
  'wave_station',
  {
    sequenceId: text('sequence_id').notNull(),
    waveIndex: integer('wave_index').notNull(),
    station: integer('station').notNull(),
    runMinutes: real('run_minutes').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sequenceId, t.waveIndex, t.station] }),
    foreignKey({ columns: [t.sequenceId, t.waveIndex], foreignColumns: [sequenceWave.sequenceId, sequenceWave.waveIndex] }).onDelete(
      'cascade',
    ),
    check('wave_station_station_positive', sql`${t.station} >= 1`),
    check('wave_station_run_minutes_range', sql`${t.runMinutes} > 0 AND ${t.runMinutes} <= ${sql.raw(String(MAX_RUN_MINUTES))}`),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 4. Watering ledger (replaces WateringHistory): drives the cooldown and the rolling 24 h cap. One row
//    per station of every delivered wave, written in the same transaction that marks the wave delivered.
//    Append-only (trigger). Deleting old sequences keeps their ledger rows (provenance set to NULL).
// ---------------------------------------------------------------------------------------------------

export const zoneWatering = sqliteTable(
  'zone_watering',
  {
    id: integer('id').primaryKey(),
    zoneKey: text('zone_key')
      .notNull()
      .references(() => zone.zoneKey),
    /** WateringRun.at: when the send that counted started. */
    startedAt: isoTimestamp('started_at').notNull(),
    minutes: real('minutes').notNull(),
    /** Where it came from; NULL for runs imported from .conductor-state.json or whose sequence was purged. */
    sequenceId: text('sequence_id'),
    waveIndex: integer('wave_index'),
  },
  (t) => [
    index('zone_watering_zone_time').on(t.zoneKey, t.startedAt),
    foreignKey({ columns: [t.sequenceId, t.waveIndex], foreignColumns: [sequenceWave.sequenceId, sequenceWave.waveIndex] }).onDelete(
      'set null',
    ),
    // A wave can never be counted twice.
    unique('zone_watering_once_per_wave').on(t.sequenceId, t.waveIndex, t.zoneKey),
    check('zone_watering_minutes_nonnegative', sql`${t.minutes} >= 0`),
    check('zone_watering_provenance_pair', sql`(${t.sequenceId} IS NULL) = (${t.waveIndex} IS NULL)`),
    isoCheck('zone_watering_started_at_iso', t.startedAt),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 5. Open alert conditions (AlertTracker.state), so a restart doesn't report them all again.
//    Closed conditions are only in the audit trail.
// ---------------------------------------------------------------------------------------------------

export const openAlert = sqliteTable(
  'open_alert',
  {
    /** "battery:sensor:<id>", "battery:device:<id>", "moisture:<zoneKey>:<sensorId>", "device:<id>", "daily-limit:<zoneKey>" */
    alertKey: text('alert_key').primaryKey(),
    kind: text('kind', { enum: ALERT_KINDS }).generatedAlwaysAs(sql.raw(`substr(alert_key, 1, instr(alert_key, ':') - 1)`), {
      mode: 'virtual',
    }),
    state: text('state', { enum: ALERT_STATES }).notNull(),
    since: isoTimestamp('since').notNull(),
  },
  (t) => [
    keyNotNull('open_alert_key_not_null', t.alertKey),
    check('open_alert_kind', sql`${t.kind} IN (${sql.raw(ALERT_KINDS.map((k) => `'${k}'`).join(', '))})`),
    oneOf('open_alert_state', t.state, ALERT_STATES),
    isoCheck('open_alert_since_iso', t.since),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 6. Per-zone monitor state that is in memory today (Monitor #drySince, #noDataSince).
//    OPTIONAL and a behaviour change: see "zone_state" in docs/sqlite-storage.md before using it.
// ---------------------------------------------------------------------------------------------------

export const zoneState = sqliteTable(
  'zone_state',
  {
    zoneKey: text('zone_key')
      .primaryKey()
      .references(() => zone.zoneKey),
    /** Start of the current below-threshold spell; counts against maxWaitHours. */
    drySince: isoTimestamp('dry_since'),
    /** Start of the current sensor blackout (zone.no_data emitted, zone.data_restored pending). */
    noDataSince: isoTimestamp('no_data_since'),
    /** Last poll that evaluated the zone; lets a restart discard spells that went stale while it was down. */
    evaluatedAt: isoTimestamp('evaluated_at').notNull(),
  },
  (t) => [
    keyNotNull('zone_state_key_not_null', t.zoneKey),
    isoCheck('zone_state_dry_since_iso', t.drySince),
    isoCheck('zone_state_no_data_since_iso', t.noDataSince),
    isoCheck('zone_state_evaluated_at_iso', t.evaluatedAt),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 7. Audit trail (replaces .conductor-audit.jsonl): same events, same payloads. Deliberately no foreign
//    keys, because auditing must never be refused. Append-only (trigger); DELETE allowed for retention.
// ---------------------------------------------------------------------------------------------------

export const auditEvent = sqliteTable(
  'audit_event',
  {
    /** AUTOINCREMENT: ids are never reused after retention deletes. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: isoTimestamp('ts').notNull(),
    type: text('type').$type<AuditType>().notNull(),
    /** NULL for imported and simulated events. */
    serviceRunId: integer('service_run_id'),
    /** The event minus ts/type, exactly what AuditSink.record() received. */
    data: text('data', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    // Filter columns derived from the payload, so the writer stays generic (record(type, data)).
    deviceId: text('device_id').generatedAlwaysAs(jsonText('data', '$.device'), { mode: 'virtual' }),
    zoneKey: text('zone_key').generatedAlwaysAs(jsonText('data', '$.zone'), { mode: 'virtual' }),
    sequenceId: text('sequence_id').generatedAlwaysAs(jsonText('data', '$.sequence'), { mode: 'virtual' }),
  },
  (t) => [
    index('audit_event_ts').on(t.ts),
    index('audit_event_type_ts').on(t.type, t.ts),
    index('audit_event_device').on(t.deviceId, t.ts).where(sql`${t.deviceId} IS NOT NULL`),
    index('audit_event_zone').on(t.zoneKey, t.ts).where(sql`${t.zoneKey} IS NOT NULL`),
    index('audit_event_sequence').on(t.sequenceId, t.ts).where(sql`${t.sequenceId} IS NOT NULL`),
    isoCheck('audit_event_ts_iso', t.ts),
    jsonCheck('audit_event_data_json', t.data),
  ],
);

// ---------------------------------------------------------------------------------------------------
// 8. Sensor readings. OPTIONAL: not needed to water correctly, but cheap and the input for calibration,
//    anomaly detection and water-use reports.
// ---------------------------------------------------------------------------------------------------

export const sensorReading = sqliteTable(
  'sensor_reading',
  {
    sensorId: text('sensor_id').notNull(),
    /** MoistureReading.at. Tuya returns the same reading until the sensor reports again: insert with onConflictDoNothing(). */
    measuredAt: isoTimestamp('measured_at').notNull(),
    /** The first poll that saw it. */
    polledAt: isoTimestamp('polled_at').notNull(),
    /** Raw, not range-checked: bad values are evidence of a bad sensor. */
    moisturePct: real('moisture_pct'),
    temperatureC: real('temperature_c'),
    batteryPct: real('battery_pct'),
    online: integer('online', { mode: 'boolean' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sensorId, t.measuredAt] }),
    check('sensor_reading_online_bool', sql`${t.online} IN (0, 1)`),
    isoCheck('sensor_reading_measured_at_iso', t.measuredAt),
    isoCheck('sensor_reading_polled_at_iso', t.polledAt),
  ],
);

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

/**
 * Everything needed to rebuild PendingSequence[] at startup (waves come from wave_station).
 * nextWave = waveCount means every wave is delivered but the sequence was never closed; the loader must
 * complete it, or the one-active-per-device index would block its device.
 */
export const pendingSequence = sqliteView('pending_sequence', {
  id: text('id').notNull(),
  deviceId: text('device_id').notNull(),
  soakMinutes: real('soak_minutes').notNull(),
  createdAt: isoTimestamp('created_at').notNull(),
  waveCount: integer('wave_count').notNull(),
  nextWave: integer('next_wave').notNull(),
  dueAt: isoTimestamp('due_at'),
  attempts: integer('attempts').notNull(),
  inFlightWave: integer('in_flight_wave'),
  inFlightSince: isoTimestamp('in_flight_since'),
  zoneNames: text('zone_names', { mode: 'json' }).$type<string[]>().notNull(),
}).as(sql`
SELECT s.id,
       s.device_id,
       s.soak_minutes,
       s.created_at,
       (SELECT count(*) FROM sequence_wave c WHERE c.sequence_id = s.id) AS wave_count,
       coalesce(w.wave_index, (SELECT count(*) FROM sequence_wave c WHERE c.sequence_id = s.id)) AS next_wave,
       w.due_at,
       coalesce(w.failed_attempts, 0) AS attempts,
       CASE WHEN w.status = 'sending' THEN w.wave_index END AS in_flight_wave,
       CASE WHEN w.status = 'sending' THEN w.sent_at END AS in_flight_since,
       (SELECT json_group_array(z.zone_name) FROM sequence_zone z WHERE z.sequence_id = s.id) AS zone_names
FROM watering_sequence s
LEFT JOIN sequence_wave w
       ON w.sequence_id = s.id
      AND w.wave_index = (SELECT min(x.wave_index) FROM sequence_wave x
                          WHERE x.sequence_id = s.id AND x.status IN ('pending', 'sending'))
WHERE s.status = 'active'`);

/** One line per sequence: what was planned vs. what happened (`npm run audit:summary`, reports). */
export const sequenceResult = sqliteView('sequence_result', {
  id: text('id').notNull(),
  deviceId: text('device_id').notNull(),
  createdAt: isoTimestamp('created_at').notNull(),
  status: text('status', { enum: SEQUENCE_STATUSES }).notNull(),
  endedAt: isoTimestamp('ended_at'),
  abandonReason: text('abandon_reason'),
  cycles: integer('cycles').notNull(),
  cyclesDelivered: integer('cycles_delivered').notNull(),
  plannedMinutes: real('planned_minutes').notNull(),
  deliveredMinutes: real('delivered_minutes').notNull(),
  /** Station runs counted as delivered without confirmation ('unconfirmed' or 'assumed'). */
  uncertainStationRuns: integer('uncertain_station_runs').notNull(),
  failedAttempts: integer('failed_attempts').notNull(),
  /** When the water went off (the code's `sequence.finished`, which isn't persisted otherwise). */
  waterOffAt: isoTimestamp('water_off_at'),
}).as(sql`
SELECT s.id,
       s.device_id,
       s.created_at,
       s.status,
       s.ended_at,
       s.abandon_reason,
       count(DISTINCT w.wave_index) AS cycles,
       count(DISTINCT CASE WHEN w.status = 'delivered' THEN w.wave_index END) AS cycles_delivered,
       round(sum(st.run_minutes), 1) AS planned_minutes,
       round(coalesce(sum(CASE WHEN w.status = 'delivered' THEN st.run_minutes END), 0), 1) AS delivered_minutes,
       sum(CASE WHEN w.delivery IN ('unconfirmed', 'assumed') THEN 1 ELSE 0 END) AS uncertain_station_runs,
       (SELECT sum(r.failed_attempts) FROM sequence_wave r WHERE r.sequence_id = s.id) AS failed_attempts,
       (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(d.sent_at) + m.minutes / 1440.0))
          FROM sequence_wave d
          JOIN (SELECT ws.wave_index, sum(ws.run_minutes) AS minutes FROM wave_station ws
                WHERE ws.sequence_id = s.id GROUP BY ws.wave_index) m ON m.wave_index = d.wave_index
         WHERE d.sequence_id = s.id AND d.status = 'delivered') AS water_off_at
FROM watering_sequence s
JOIN sequence_wave w ON w.sequence_id = s.id
JOIN wave_station st ON st.sequence_id = w.sequence_id AND st.wave_index = w.wave_index
GROUP BY s.id`);

// ---------------------------------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------------------------------

export type ServiceRun = typeof serviceRun.$inferSelect;
export type NewServiceRun = typeof serviceRun.$inferInsert;
export type Zone = typeof zone.$inferSelect;
export type NewZone = typeof zone.$inferInsert;
export type WateringSequence = typeof wateringSequence.$inferSelect;
export type NewWateringSequence = typeof wateringSequence.$inferInsert;
export type SequenceZone = typeof sequenceZone.$inferSelect;
export type NewSequenceZone = typeof sequenceZone.$inferInsert;
export type SequenceWave = typeof sequenceWave.$inferSelect;
export type NewSequenceWave = typeof sequenceWave.$inferInsert;
export type WaveStation = typeof waveStation.$inferSelect;
export type NewWaveStation = typeof waveStation.$inferInsert;
export type ZoneWatering = typeof zoneWatering.$inferSelect;
export type NewZoneWatering = typeof zoneWatering.$inferInsert;
export type OpenAlert = typeof openAlert.$inferSelect;
export type NewOpenAlert = typeof openAlert.$inferInsert;
export type ZoneState = typeof zoneState.$inferSelect;
export type NewZoneState = typeof zoneState.$inferInsert;
export type AuditEventRow = typeof auditEvent.$inferSelect;
export type NewAuditEventRow = typeof auditEvent.$inferInsert;
export type SensorReading = typeof sensorReading.$inferSelect;
export type NewSensorReading = typeof sensorReading.$inferInsert;
export type PendingSequenceRow = typeof pendingSequence.$inferSelect;
export type SequenceResultRow = typeof sequenceResult.$inferSelect;
