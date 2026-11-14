-- Custom SQL migration: what drizzle-orm can't express in src/db/schema.ts.
--
-- The watering ledger and the audit trail are append-only: rows can be inserted (and deleted, for
-- retention), never changed. The one exception is the ledger's ON DELETE SET NULL: purging an old sequence
-- detaches its ledger rows (sequence_id and wave_index become NULL), which SQLite carries out as an UPDATE.
-- That update is allowed; the zone, time and minutes that cooldowns and daily caps depend on never change.
--
-- Separate statements with drizzle's breakpoint marker line (see the end of the first trigger), and never
-- write that marker inside a comment: the migrator splits the file on it as plain text, runs each chunk as a
-- single prepared statement, and node:sqlite silently ignores everything after the first statement.
--
-- drizzle-kit doesn't know about these triggers. If a future migration rebuilds `zone_watering` or
-- `audit_event` (SQLite's copy/drop/rename for most ALTERs), the DROP TABLE drops the trigger too: re-create
-- it in that migration. src/test/db/migrations.test.ts fails if one is missing.

CREATE TRIGGER `zone_watering_no_update` BEFORE UPDATE ON `zone_watering`
WHEN NOT (
  NEW.sequence_id IS NULL AND NEW.wave_index IS NULL
  AND NEW.id IS OLD.id AND NEW.zone_key IS OLD.zone_key
  AND NEW.started_at IS OLD.started_at AND NEW.minutes IS OLD.minutes
)
BEGIN
  SELECT RAISE(ABORT, 'zone_watering is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_event_no_update` BEFORE UPDATE ON `audit_event`
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
