import type { DatabaseSync } from 'node:sqlite';

/**
 * Views and triggers are owned by the application, not by drizzle-kit migrations. They hold no data, so
 * the app drops them before applying migrations and re-creates them afterwards from the definitions below
 * (a "repeatable migration"). This keeps drizzle-kit's generated migrations working unmodified:
 *
 *  - SQLite refuses to rename a table while a view refers to it, and drizzle-kit changes most tables by
 *    rebuilding them (create a copy, drop, rename). A view would make that fail.
 *  - Dropping a table drops its triggers, so a rebuild of `zone_watering` or `audit_event` would silently
 *    remove the append-only protection.
 *
 * To change a view or trigger, edit it here. No migration is needed; the next start applies it. A view's
 * columns must stay in step with its `.existing()` declaration in schema.ts (a test checks this), and a
 * migration that renames or drops a column a view uses must come with the view's new definition here.
 */

export interface RepeatableObject {
  type: 'view' | 'trigger';
  name: string;
  /** The CREATE statement, exactly as SQLite will store it (no IF NOT EXISTS, no trailing semicolon). */
  sql: string;
}

const PENDING_SEQUENCE = `CREATE VIEW pending_sequence AS
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
WHERE s.status = 'active'`;

const SEQUENCE_RESULT = `CREATE VIEW sequence_result AS
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
GROUP BY s.id`;

/**
 * The ledger is append-only. The one allowed update is the one SQLite makes for ON DELETE SET NULL when an
 * old sequence is purged: provenance (sequence_id, wave_index) becomes NULL and nothing else changes.
 */
const ZONE_WATERING_NO_UPDATE = `CREATE TRIGGER zone_watering_no_update BEFORE UPDATE ON zone_watering
WHEN NOT (
  NEW.sequence_id IS NULL AND NEW.wave_index IS NULL
  AND NEW.id IS OLD.id AND NEW.zone_key IS OLD.zone_key
  AND NEW.started_at IS OLD.started_at AND NEW.minutes IS OLD.minutes
)
BEGIN
  SELECT RAISE(ABORT, 'zone_watering is append-only');
END`;

const AUDIT_EVENT_NO_UPDATE = `CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END`;

export const REPEATABLE_OBJECTS: readonly RepeatableObject[] = [
  { type: 'view', name: 'pending_sequence', sql: PENDING_SEQUENCE },
  { type: 'view', name: 'sequence_result', sql: SEQUENCE_RESULT },
  { type: 'trigger', name: 'zone_watering_no_update', sql: ZONE_WATERING_NO_UPDATE },
  { type: 'trigger', name: 'audit_event_no_update', sql: AUDIT_EVENT_NO_UPDATE },
];

const DROP = { view: 'DROP VIEW IF EXISTS', trigger: 'DROP TRIGGER IF EXISTS' } as const;

const inTransaction = (client: DatabaseSync, fn: () => void): void => {
  client.exec('BEGIN IMMEDIATE');
  try {
    fn();
    client.exec('COMMIT');
  } catch (err) {
    client.exec('ROLLBACK');
    throw err;
  }
};

/** Drops every app-owned view and trigger (before migrations run). */
export const dropRepeatables = (client: DatabaseSync, objects: readonly RepeatableObject[] = REPEATABLE_OBJECTS): void => {
  inTransaction(client, () => {
    for (const o of objects) client.exec(`${DROP[o.type]} "${o.name}"`);
  });
};

/**
 * Creates each view and trigger that is missing or differs from its definition, in one transaction, so
 * readers never see one missing. Returns the names of those (re)created; usually none.
 */
export const ensureRepeatables = (client: DatabaseSync, objects: readonly RepeatableObject[] = REPEATABLE_OBJECTS): string[] => {
  const stale = objects.filter((o) => {
    const row = client.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get(o.type, o.name) as { sql: string } | undefined;
    return row?.sql !== o.sql;
  });
  if (stale.length === 0) return [];
  inTransaction(client, () => {
    for (const o of stale) {
      client.exec(`${DROP[o.type]} "${o.name}"`);
      client.exec(o.sql);
      // SQLite only checks a view when it is used: compile it now, so a definition that no longer fits the
      // schema (e.g. a renamed column) fails here, at startup, and nothing changes.
      if (o.type === 'view') client.prepare(`SELECT * FROM "${o.name}" LIMIT 0`).all();
    }
  });
  return stale.map((o) => o.name);
};
