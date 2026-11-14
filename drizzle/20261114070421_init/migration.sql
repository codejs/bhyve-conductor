CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`service_run_id` integer,
	`data` text DEFAULT '{}' NOT NULL,
	`device_id` text GENERATED ALWAYS AS (CAST(json_extract(data, '$.device') AS TEXT)) VIRTUAL,
	`zone_key` text GENERATED ALWAYS AS (CAST(json_extract(data, '$.zone') AS TEXT)) VIRTUAL,
	`sequence_id` text GENERATED ALWAYS AS (CAST(json_extract(data, '$.sequence') AS TEXT)) VIRTUAL,
	CONSTRAINT "audit_event_ts_iso" CHECK("ts" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "audit_event_data_json" CHECK(json_valid("data"))
);
--> statement-breakpoint
CREATE TABLE `open_alert` (
	`alert_key` text PRIMARY KEY,
	`kind` text GENERATED ALWAYS AS (substr(alert_key, 1, instr(alert_key, ':') - 1)) VIRTUAL,
	`state` text NOT NULL,
	`since` text NOT NULL,
	CONSTRAINT "open_alert_key_not_null" CHECK("alert_key" IS NOT NULL),
	CONSTRAINT "open_alert_kind" CHECK("kind" IN ('battery', 'moisture', 'device', 'daily-limit')),
	CONSTRAINT "open_alert_state" CHECK("state" IN ('low', 'high', 'offline', 'reached')),
	CONSTRAINT "open_alert_since_iso" CHECK("since" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `sensor_reading` (
	`sensor_id` text NOT NULL,
	`measured_at` text NOT NULL,
	`polled_at` text NOT NULL,
	`moisture_pct` real,
	`temperature_c` real,
	`battery_pct` real,
	`online` integer NOT NULL,
	CONSTRAINT `sensor_reading_pk` PRIMARY KEY(`sensor_id`, `measured_at`),
	CONSTRAINT "sensor_reading_online_bool" CHECK("online" IN (0, 1)),
	CONSTRAINT "sensor_reading_measured_at_iso" CHECK("measured_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "sensor_reading_polled_at_iso" CHECK("polled_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `sequence_wave` (
	`sequence_id` text NOT NULL,
	`wave_index` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` text,
	`sent_at` text,
	`delivery` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `sequence_wave_pk` PRIMARY KEY(`sequence_id`, `wave_index`),
	CONSTRAINT `fk_sequence_wave_sequence_id_watering_sequence_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `watering_sequence`(`id`) ON DELETE CASCADE,
	CONSTRAINT "sequence_wave_index_nonnegative" CHECK("wave_index" >= 0),
	CONSTRAINT "sequence_wave_attempts_nonnegative" CHECK("failed_attempts" >= 0),
	CONSTRAINT "sequence_wave_status" CHECK("status" IN ('pending', 'sending', 'delivered', 'skipped')),
	CONSTRAINT "sequence_wave_delivery" CHECK("delivery" IN ('event', 'status', 'unconfirmed', 'assumed')),
	CONSTRAINT "sequence_wave_unsent_state" CHECK("status" NOT IN ('pending', 'skipped') OR ("sent_at" IS NULL AND "delivery" IS NULL)),
	CONSTRAINT "sequence_wave_sending_state" CHECK("status" <> 'sending' OR ("sent_at" IS NOT NULL AND "delivery" IS NULL AND "due_at" IS NOT NULL)),
	CONSTRAINT "sequence_wave_delivered_state" CHECK("status" <> 'delivered' OR ("sent_at" IS NOT NULL AND "delivery" IS NOT NULL)),
	CONSTRAINT "sequence_wave_due_at_iso" CHECK("due_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "sequence_wave_sent_at_iso" CHECK("sent_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `sequence_zone` (
	`sequence_id` text NOT NULL,
	`zone_key` text NOT NULL,
	`zone_name` text NOT NULL,
	`moisture_pct` real,
	`reading_at` text,
	`threshold_pct` real NOT NULL,
	`target_pct` real NOT NULL,
	`requested_minutes` real NOT NULL,
	`allowance_minutes` real,
	`budget_inches` real,
	`budget_json` text,
	`detail` text NOT NULL,
	CONSTRAINT `sequence_zone_pk` PRIMARY KEY(`sequence_id`, `zone_key`),
	CONSTRAINT `fk_sequence_zone_sequence_id_watering_sequence_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `watering_sequence`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sequence_zone_zone_key_zone_zone_key_fk` FOREIGN KEY (`zone_key`) REFERENCES `zone`(`zone_key`),
	CONSTRAINT "sequence_zone_requested_positive" CHECK("requested_minutes" > 0),
	CONSTRAINT "sequence_zone_budget_json" CHECK("budget_json" IS NULL OR json_valid("budget_json")),
	CONSTRAINT "sequence_zone_reading_at_iso" CHECK("reading_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `service_run` (
	`id` integer PRIMARY KEY,
	`started_at` text NOT NULL,
	`mode` text NOT NULL,
	`dry_run` integer NOT NULL,
	`pid` integer,
	`config_hash` text NOT NULL,
	`config_json` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`stopped_at` text,
	`stop_reason` text,
	CONSTRAINT "service_run_started_at_iso" CHECK("started_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "service_run_heartbeat_at_iso" CHECK("heartbeat_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "service_run_stopped_at_iso" CHECK("stopped_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "service_run_mode" CHECK("mode" IN ('continuous', 'once')),
	CONSTRAINT "service_run_dry_run_bool" CHECK("dry_run" IN (0, 1)),
	CONSTRAINT "service_run_config_json" CHECK(json_valid("config_json")),
	CONSTRAINT "service_run_stopped_pair" CHECK(("stopped_at" IS NULL) = ("stop_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `watering_sequence` (
	`id` text PRIMARY KEY,
	`service_run_id` integer,
	`device_id` text NOT NULL,
	`soak_minutes` real NOT NULL,
	`created_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ended_at` text,
	`abandon_reason` text,
	CONSTRAINT `fk_watering_sequence_service_run_id_service_run_id_fk` FOREIGN KEY (`service_run_id`) REFERENCES `service_run`(`id`),
	CONSTRAINT "watering_sequence_id_not_null" CHECK("id" IS NOT NULL),
	CONSTRAINT "watering_sequence_soak_nonnegative" CHECK("soak_minutes" >= 0),
	CONSTRAINT "watering_sequence_status" CHECK("status" IN ('active', 'completed', 'abandoned')),
	CONSTRAINT "watering_sequence_ended_iff_not_active" CHECK(("status" = 'active') = ("ended_at" IS NULL)),
	CONSTRAINT "watering_sequence_reason_iff_abandoned" CHECK(("status" = 'abandoned') = ("abandon_reason" IS NOT NULL)),
	CONSTRAINT "watering_sequence_created_at_iso" CHECK("created_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "watering_sequence_ended_at_iso" CHECK("ended_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `wave_station` (
	`sequence_id` text NOT NULL,
	`wave_index` integer NOT NULL,
	`station` integer NOT NULL,
	`run_minutes` real NOT NULL,
	CONSTRAINT `wave_station_pk` PRIMARY KEY(`sequence_id`, `wave_index`, `station`),
	CONSTRAINT `fk_wave_station_sequence_id_wave_index_sequence_wave_sequence_id_wave_index_fk` FOREIGN KEY (`sequence_id`,`wave_index`) REFERENCES `sequence_wave`(`sequence_id`,`wave_index`) ON DELETE CASCADE,
	CONSTRAINT "wave_station_station_positive" CHECK("station" >= 1),
	CONSTRAINT "wave_station_run_minutes_range" CHECK("run_minutes" > 0 AND "run_minutes" <= 240)
);
--> statement-breakpoint
CREATE TABLE `zone` (
	`zone_key` text PRIMARY KEY,
	`device_id` text NOT NULL,
	`station` integer NOT NULL,
	`name` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `zone_device_station` UNIQUE(`device_id`,`station`),
	CONSTRAINT "zone_key_not_null" CHECK("zone_key" IS NOT NULL),
	CONSTRAINT "zone_station_positive" CHECK("station" >= 1),
	CONSTRAINT "zone_key_matches" CHECK("zone_key" = "device_id" || ':' || "station"),
	CONSTRAINT "zone_first_seen_at_iso" CHECK("first_seen_at" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "zone_last_seen_at_iso" CHECK("last_seen_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `zone_state` (
	`zone_key` text PRIMARY KEY,
	`dry_since` text,
	`no_data_since` text,
	`evaluated_at` text NOT NULL,
	CONSTRAINT `fk_zone_state_zone_key_zone_zone_key_fk` FOREIGN KEY (`zone_key`) REFERENCES `zone`(`zone_key`),
	CONSTRAINT "zone_state_key_not_null" CHECK("zone_key" IS NOT NULL),
	CONSTRAINT "zone_state_dry_since_iso" CHECK("dry_since" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "zone_state_no_data_since_iso" CHECK("no_data_since" GLOB '????-??-??T??:??:??.???Z'),
	CONSTRAINT "zone_state_evaluated_at_iso" CHECK("evaluated_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE TABLE `zone_watering` (
	`id` integer PRIMARY KEY,
	`zone_key` text NOT NULL,
	`started_at` text NOT NULL,
	`minutes` real NOT NULL,
	`sequence_id` text,
	`wave_index` integer,
	CONSTRAINT `fk_zone_watering_zone_key_zone_zone_key_fk` FOREIGN KEY (`zone_key`) REFERENCES `zone`(`zone_key`),
	CONSTRAINT `fk_zone_watering_sequence_id_wave_index_sequence_wave_sequence_id_wave_index_fk` FOREIGN KEY (`sequence_id`,`wave_index`) REFERENCES `sequence_wave`(`sequence_id`,`wave_index`) ON DELETE SET NULL,
	CONSTRAINT `zone_watering_once_per_wave` UNIQUE(`sequence_id`,`wave_index`,`zone_key`),
	CONSTRAINT "zone_watering_minutes_nonnegative" CHECK("minutes" >= 0),
	CONSTRAINT "zone_watering_provenance_pair" CHECK(("sequence_id" IS NULL) = ("wave_index" IS NULL)),
	CONSTRAINT "zone_watering_started_at_iso" CHECK("started_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `audit_event_ts` ON `audit_event` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_event_type_ts` ON `audit_event` (`type`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_event_device` ON `audit_event` (`device_id`,`ts`) WHERE "audit_event"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_event_zone` ON `audit_event` (`zone_key`,`ts`) WHERE "audit_event"."zone_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_event_sequence` ON `audit_event` (`sequence_id`,`ts`) WHERE "audit_event"."sequence_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sequence_zone_zone` ON `sequence_zone` (`zone_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `watering_sequence_one_active_per_device` ON `watering_sequence` (`device_id`) WHERE "watering_sequence"."status" = 'active';--> statement-breakpoint
CREATE INDEX `watering_sequence_created` ON `watering_sequence` (`created_at`);--> statement-breakpoint
CREATE INDEX `watering_sequence_device_created` ON `watering_sequence` (`device_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `zone_watering_zone_time` ON `zone_watering` (`zone_key`,`started_at`);--> statement-breakpoint
CREATE VIEW `pending_sequence` AS 
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
WHERE s.status = 'active';--> statement-breakpoint
CREATE VIEW `sequence_result` AS 
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
GROUP BY s.id;