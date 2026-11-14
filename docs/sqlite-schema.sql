-- bhyve-conductor SQLite storage, schema version 1.
-- Design notes and the reasoning behind each table: docs/sqlite-storage.md
--
-- Conventions
--   * Timestamps are UTC ISO-8601 strings exactly as produced by Date.prototype.toISOString()
--     ("2026-07-01T11:00:00.000Z"). Fixed width, so text order = time order and range queries work
--     on plain indexes. The CHECKs reject other formats ("...Z" without millis, "+00:00"), which
--     would silently break that ordering.
--   * Timestamps are always supplied by the application's Clock, never by SQLite (no
--     CURRENT_TIMESTAMP defaults): simulations run in virtual time and tests use a fixed NOW.
--   * Durations are REAL minutes, as in the code (cycles can be 2.5 min).
--   * Zone key = "<deviceId>:<station>" (conductor/config.ts zoneKey()).
--
-- Every connection must run:
--   PRAGMA foreign_keys = ON;     -- off by default in SQLite
--   PRAGMA synchronous = FULL;    -- see "Durability" in the design doc: the in-flight marker must be on
--                                 -- disk before a watering command is sent
--   PRAGMA busy_timeout = 5000;   -- `npm run audit` may read while the service writes

PRAGMA journal_mode = WAL;        -- persistent; readers never block the writer
PRAGMA application_id = 0x42487943; -- 'BHyC': lets tools recognise the file
PRAGMA user_version = 1;          -- schema version, for migrations

-- =====================================================================================================
-- 1. Service runs: replaces "read the tail of the audit file" for unclean-shutdown detection
-- =====================================================================================================
CREATE TABLE service_run (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT    NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.???Z'),
  mode          TEXT    NOT NULL CHECK (mode IN ('continuous', 'once')),
  dry_run       INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  pid           INTEGER,
  -- The effective (defaults-applied) ConductorConfig, so "which rules were in force?" can be answered later.
  config_hash   TEXT    NOT NULL,
  config_json   TEXT    NOT NULL CHECK (json_valid(config_json)),
  -- Updated after every poll; the best estimate of when a crashed run died.
  heartbeat_at  TEXT    NOT NULL CHECK (heartbeat_at GLOB '????-??-??T??:??:??.???Z'),
  stopped_at    TEXT             CHECK (stopped_at GLOB '????-??-??T??:??:??.???Z'),
  -- 'SIGTERM' | 'SIGINT' | 'once' for clean stops; 'unclean' when a later run found it never stopped.
  stop_reason   TEXT,
  CHECK ((stopped_at IS NULL) = (stop_reason IS NULL))
) STRICT;

-- =====================================================================================================
-- 2. Zone registry: FK anchor for history. conductor.json stays the source of truth for the rules;
--    rows are upserted from it at every start and never deleted (history outlives config changes).
-- =====================================================================================================
CREATE TABLE zone (
  zone_key       TEXT    PRIMARY KEY,
  device_id      TEXT    NOT NULL,
  station        INTEGER NOT NULL CHECK (station >= 1),
  name           TEXT    NOT NULL,
  first_seen_at  TEXT    NOT NULL CHECK (first_seen_at GLOB '????-??-??T??:??:??.???Z'),
  last_seen_at   TEXT    NOT NULL CHECK (last_seen_at  GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (device_id, station),
  CHECK (zone_key = device_id || ':' || station)
) STRICT;

-- =====================================================================================================
-- 3. Watering sequences: the conductor's watering schedule and its results.
--    Replaces `sequences` in .conductor-state.json, but rows are kept after they finish.
--    sequence -> waves (cycles, sent one after another with a soak between) -> stations in each wave.
-- =====================================================================================================
CREATE TABLE watering_sequence (
  -- Full randomUUID(). Messages/CLI keep showing the first 8 characters (prefix lookup).
  -- Rows imported from the old state file keep their 8-character ids.
  id              TEXT    PRIMARY KEY,
  service_run_id  INTEGER REFERENCES service_run (id),      -- NULL for imported rows
  device_id       TEXT    NOT NULL,
  soak_minutes    REAL    NOT NULL CHECK (soak_minutes >= 0),
  created_at      TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  ended_at        TEXT             CHECK (ended_at GLOB '????-??-??T??:??:??.???Z'),
  abandon_reason  TEXT,
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK ((status = 'abandoned') = (abandon_reason IS NOT NULL))
) STRICT;

-- The Sequencer never runs two sequences on one device (it keys #active by deviceId). Enforced here too:
-- if memory and disk ever disagree, starting a second one fails instead of watering twice.
CREATE UNIQUE INDEX watering_sequence_one_active_per_device ON watering_sequence (device_id) WHERE status = 'active';
CREATE INDEX watering_sequence_created ON watering_sequence (created_at);
CREATE INDEX watering_sequence_device_created ON watering_sequence (device_id, created_at);

-- Why each zone was watered: the ZoneDecision that led to the sequence (a snapshot, since config and
-- names can change afterwards).
CREATE TABLE sequence_zone (
  sequence_id        TEXT NOT NULL REFERENCES watering_sequence (id) ON DELETE CASCADE,
  zone_key           TEXT NOT NULL REFERENCES zone (zone_key),
  zone_name          TEXT NOT NULL,
  moisture_pct       REAL,          -- aggregated reading that drove the decision
  reading_at         TEXT CHECK (reading_at GLOB '????-??-??T??:??:??.???Z'),
  threshold_pct      REAL NOT NULL,
  target_pct         REAL NOT NULL,
  requested_minutes  REAL NOT NULL CHECK (requested_minutes > 0),   -- ZoneDecision.runMinutes
  allowance_minutes  REAL,                                          -- what the daily cap still allowed
  budget_inches      REAL,          -- WaterBudget.inches, when the forecast was used
  budget_json        TEXT CHECK (budget_json IS NULL OR json_valid(budget_json)),  -- full WaterBudget
  detail             TEXT NOT NULL,
  PRIMARY KEY (sequence_id, zone_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX sequence_zone_zone ON sequence_zone (zone_key);

-- One row per wave (cycle). This row is the authority for the sequence's progress:
--   PendingSequence.nextWave = lowest wave_index still 'pending' or 'sending'
--   PendingSequence.dueAt    = that wave's due_at
--   PendingSequence.attempts = that wave's failed_attempts
--   PendingSequence.inFlight = that wave, if status = 'sending' ({ wave: wave_index, since: sent_at })
-- (see the pending_sequence view below).
CREATE TABLE sequence_wave (
  sequence_id      TEXT    NOT NULL REFERENCES watering_sequence (id) ON DELETE CASCADE,
  wave_index       INTEGER NOT NULL CHECK (wave_index >= 0),     -- 0-based; messages say "cycle wave_index+1"
  -- pending:   not sent yet (or sent and provably not started: it will be retried)
  -- sending:   marked just before the command went out; still 'sending' after a restart = crashed mid-send
  -- delivered: counted as delivered (see `delivery`); its minutes are in zone_watering
  -- skipped:   never sent because the sequence was abandoned
  status           TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'sending', 'delivered', 'skipped')),
  -- When the wave is due: created_at for the first, previous sent_at + its minutes + soak for later ones.
  -- NULL until the previous wave is delivered. Retries keep it (the retry window is measured from it).
  due_at           TEXT    CHECK (due_at GLOB '????-??-??T??:??:??.???Z'),
  -- 'sending': when the send started. 'delivered': when the send that counted started
  -- (this is the WateringRun.at that cooldowns are measured from).
  sent_at          TEXT    CHECK (sent_at GLOB '????-??-??T??:??:??.???Z'),
  -- How delivery was established: B-hyve event, device status, unconfirmed (assumed so it's never sent
  -- twice), or assumed after being found in flight at restart.
  delivery         TEXT    CHECK (delivery IN ('event', 'status', 'unconfirmed', 'assumed')),
  -- Failed attempts (send failed, not started, deferred) before it was delivered or given up.
  failed_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  PRIMARY KEY (sequence_id, wave_index),
  CHECK (status NOT IN ('pending', 'skipped') OR (sent_at IS NULL AND delivery IS NULL)),
  CHECK (status <> 'sending'   OR (sent_at IS NOT NULL AND delivery IS NULL AND due_at IS NOT NULL)),
  CHECK (status <> 'delivered' OR (sent_at IS NOT NULL AND delivery IS NOT NULL))
) STRICT, WITHOUT ROWID;

-- Stations in a wave. B-hyve runs them back to back in station order (plan.ts sorts them), so
-- ORDER BY station rebuilds the exact StationRun[] that was planned.
CREATE TABLE wave_station (
  sequence_id  TEXT    NOT NULL,
  wave_index   INTEGER NOT NULL,
  station      INTEGER NOT NULL CHECK (station >= 1),
  run_minutes  REAL    NOT NULL CHECK (run_minutes > 0 AND run_minutes <= 240),   -- B-hyve's manual-run limit
  PRIMARY KEY (sequence_id, wave_index, station),
  FOREIGN KEY (sequence_id, wave_index) REFERENCES sequence_wave (sequence_id, wave_index) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- =====================================================================================================
-- 4. Watering ledger: replaces `runs` in the state file (WateringHistory). It drives the cooldown and
--    the rolling 24 h cap, so it is kept narrow, append-only and independent of sequence retention.
--    One row per station of every delivered wave, written in the same transaction that marks the wave
--    delivered. No pruning needed: queries are bounded by time.
-- =====================================================================================================
CREATE TABLE zone_watering (
  id           INTEGER PRIMARY KEY,
  zone_key     TEXT    NOT NULL REFERENCES zone (zone_key),
  started_at   TEXT    NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.???Z'),
  minutes      REAL    NOT NULL CHECK (minutes >= 0),
  -- Where it came from; NULL only for runs imported from .conductor-state.json.
  sequence_id  TEXT,
  wave_index   INTEGER,
  FOREIGN KEY (sequence_id, wave_index) REFERENCES sequence_wave (sequence_id, wave_index),
  CHECK ((sequence_id IS NULL) = (wave_index IS NULL)),
  UNIQUE (sequence_id, wave_index, zone_key)        -- a wave can never be counted twice
) STRICT;

CREATE INDEX zone_watering_zone_time ON zone_watering (zone_key, started_at);

CREATE TRIGGER zone_watering_no_update BEFORE UPDATE ON zone_watering
BEGIN SELECT RAISE(ABORT, 'zone_watering is append-only'); END;

-- =====================================================================================================
-- 5. Open alert conditions: replaces `alerts` in the state file (AlertTracker), so a restart doesn't
--    report every low battery again. Closed conditions are only in the audit trail.
-- =====================================================================================================
CREATE TABLE open_alert (
  -- "battery:sensor:<id>", "battery:device:<id>", "moisture:<zoneKey>:<sensorId>", "device:<id>",
  -- "daily-limit:<zoneKey>"
  alert_key  TEXT PRIMARY KEY,
  kind       TEXT GENERATED ALWAYS AS (substr(alert_key, 1, instr(alert_key, ':') - 1)) VIRTUAL
             CHECK (kind IN ('battery', 'moisture', 'device', 'daily-limit')),
  state      TEXT NOT NULL CHECK (state IN ('low', 'high', 'offline', 'reached')),
  since      TEXT NOT NULL CHECK (since GLOB '????-??-??T??:??:??.???Z')
) STRICT;

-- =====================================================================================================
-- 6. Per-zone monitor state that is in memory today (Monitor #drySince, #noDataSince).
--    OPTIONAL, and a behaviour change: see "zone_state" in the design doc before adopting it.
-- =====================================================================================================
CREATE TABLE zone_state (
  zone_key       TEXT PRIMARY KEY REFERENCES zone (zone_key),
  -- Start of the current below-threshold spell; counts against maxWaitHours.
  dry_since      TEXT CHECK (dry_since GLOB '????-??-??T??:??:??.???Z'),
  -- Start of the current sensor blackout (zone.no_data emitted, zone.data_restored pending).
  no_data_since  TEXT CHECK (no_data_since GLOB '????-??-??T??:??:??.???Z'),
  -- Last poll that evaluated the zone; lets a restart discard spells that went stale while it was down.
  evaluated_at   TEXT NOT NULL CHECK (evaluated_at GLOB '????-??-??T??:??:??.???Z')
) STRICT, WITHOUT ROWID;

-- =====================================================================================================
-- 7. Audit trail: replaces .conductor-audit.jsonl. Same events, same payloads (AuditSink unchanged).
--    Deliberately no foreign keys: the audit must accept every event, including ones about rows that
--    were never stored or have been purged. Append-only; old rows may be deleted by retention.
-- =====================================================================================================
CREATE TABLE audit_event (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- AUTOINCREMENT: ids never reused after retention
  ts              TEXT    NOT NULL CHECK (ts GLOB '????-??-??T??:??:??.???Z'),
  type            TEXT    NOT NULL,                   -- AuditType ('wave.sent', ...)
  service_run_id  INTEGER,                            -- NULL for imported / simulation rows
  data            TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(data)),   -- the event minus ts/type
  -- Filter columns derived from the payload so the writer stays generic (record(type, data)).
  device_id       TEXT GENERATED ALWAYS AS (CAST(json_extract(data, '$.device')   AS TEXT)) VIRTUAL,
  zone_key        TEXT GENERATED ALWAYS AS (CAST(json_extract(data, '$.zone')     AS TEXT)) VIRTUAL,
  sequence_id     TEXT GENERATED ALWAYS AS (CAST(json_extract(data, '$.sequence') AS TEXT)) VIRTUAL
) STRICT;

CREATE INDEX audit_event_ts       ON audit_event (ts);
CREATE INDEX audit_event_type_ts  ON audit_event (type, ts);
CREATE INDEX audit_event_device   ON audit_event (device_id, ts)   WHERE device_id   IS NOT NULL;
CREATE INDEX audit_event_zone     ON audit_event (zone_key, ts)    WHERE zone_key    IS NOT NULL;
CREATE INDEX audit_event_sequence ON audit_event (sequence_id, ts) WHERE sequence_id IS NOT NULL;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

-- =====================================================================================================
-- 8. Sensor readings. OPTIONAL: not needed to water correctly, but cheap (sensors x 96 polls/day) and
--    the input for the README's calibration / "jumps without rain" / water-use reporting items.
-- =====================================================================================================
CREATE TABLE sensor_reading (
  sensor_id      TEXT    NOT NULL,
  measured_at    TEXT    NOT NULL CHECK (measured_at GLOB '????-??-??T??:??:??.???Z'),  -- MoistureReading.at
  polled_at      TEXT    NOT NULL CHECK (polled_at   GLOB '????-??-??T??:??:??.???Z'),  -- first poll that saw it
  moisture_pct   REAL,                -- raw, not range-checked: bad values are evidence of a bad sensor
  temperature_c  REAL,
  battery_pct    REAL,
  online         INTEGER NOT NULL CHECK (online IN (0, 1)),
  -- Tuya returns the same reading until the sensor reports again: INSERT OR IGNORE dedupes on this key.
  PRIMARY KEY (sensor_id, measured_at)
) STRICT, WITHOUT ROWID;

-- =====================================================================================================
-- Views
-- =====================================================================================================

-- Everything needed to rebuild PendingSequence[] at startup (plus wave_station for the waves).
-- next_wave = wave_count means every wave is delivered but the sequence was never closed; the loader
-- must complete it, or the partial unique index above would block its device.
CREATE VIEW pending_sequence AS
SELECT s.id,
       s.device_id,
       s.soak_minutes,
       s.created_at,
       (SELECT count(*) FROM sequence_wave c WHERE c.sequence_id = s.id)                 AS wave_count,
       coalesce(w.wave_index, (SELECT count(*) FROM sequence_wave c WHERE c.sequence_id = s.id)) AS next_wave,
       w.due_at,
       coalesce(w.failed_attempts, 0)                                                  AS attempts,
       CASE WHEN w.status = 'sending' THEN w.wave_index END                           AS in_flight_wave,
       CASE WHEN w.status = 'sending' THEN w.sent_at END                              AS in_flight_since,
       (SELECT json_group_array(zone_name) FROM sequence_zone z WHERE z.sequence_id = s.id) AS zone_names
FROM watering_sequence s
LEFT JOIN sequence_wave w
       ON w.sequence_id = s.id
      AND w.wave_index = (SELECT min(x.wave_index) FROM sequence_wave x
                          WHERE x.sequence_id = s.id AND x.status IN ('pending', 'sending'))
WHERE s.status = 'active';

-- One line per sequence: what was planned vs. what happened (`npm run audit:summary`, reports).
CREATE VIEW sequence_result AS
SELECT s.id,
       s.device_id,
       s.created_at,
       s.status,
       s.ended_at,
       s.abandon_reason,
       count(DISTINCT w.wave_index)                                                  AS cycles,
       count(DISTINCT CASE WHEN w.status = 'delivered' THEN w.wave_index END)       AS cycles_delivered,
       round(sum(st.run_minutes), 1)                                                 AS planned_minutes,
       round(coalesce(sum(CASE WHEN w.status = 'delivered' THEN st.run_minutes END), 0), 1) AS delivered_minutes,
       sum(CASE WHEN w.delivery IN ('unconfirmed', 'assumed') THEN 1 ELSE 0 END)    AS uncertain_station_runs,
       (SELECT sum(failed_attempts) FROM sequence_wave r WHERE r.sequence_id = s.id) AS failed_attempts,
       -- When the water went off (the code's `sequence.finished`, which isn't persisted today).
       (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(d.sent_at) + m.minutes / 1440.0))
          FROM sequence_wave d
          JOIN (SELECT wave_index, sum(run_minutes) AS minutes FROM wave_station
                WHERE sequence_id = s.id GROUP BY wave_index) m ON m.wave_index = d.wave_index
         WHERE d.sequence_id = s.id AND d.status = 'delivered')                       AS water_off_at
FROM watering_sequence s
JOIN sequence_wave w  ON w.sequence_id = s.id
JOIN wave_station  st ON st.sequence_id = w.sequence_id AND st.wave_index = w.wave_index
GROUP BY s.id;
