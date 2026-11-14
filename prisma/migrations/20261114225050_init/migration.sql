-- CreateTable
CREATE TABLE "service_run" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "started_at" DATETIME NOT NULL,
    "mode" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL,
    "pid" INTEGER,
    "config_hash" TEXT NOT NULL,
    "config_json" JSONB NOT NULL,
    "heartbeat_at" DATETIME NOT NULL,
    "stopped_at" DATETIME,
    "stop_reason" TEXT
);

-- CreateTable
CREATE TABLE "zone" (
    "zone_key" TEXT NOT NULL PRIMARY KEY,
    "device_id" TEXT NOT NULL,
    "station" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "first_seen_at" DATETIME NOT NULL,
    "last_seen_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "watering_sequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service_run_id" INTEGER,
    "device_id" TEXT NOT NULL,
    "soak_minutes" REAL NOT NULL,
    "created_at" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ended_at" DATETIME,
    "abandon_reason" TEXT,
    CONSTRAINT "watering_sequence_service_run_id_fkey" FOREIGN KEY ("service_run_id") REFERENCES "service_run" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "sequence_zone" (
    "sequence_id" TEXT NOT NULL,
    "zone_key" TEXT NOT NULL,
    "zone_name" TEXT NOT NULL,
    "moisture_pct" REAL,
    "reading_at" DATETIME,
    "threshold_pct" REAL NOT NULL,
    "target_pct" REAL NOT NULL,
    "requested_minutes" REAL NOT NULL,
    "allowance_minutes" REAL,
    "budget_inches" REAL,
    "budget_json" JSONB,
    "detail" TEXT NOT NULL,

    PRIMARY KEY ("sequence_id", "zone_key"),
    CONSTRAINT "sequence_zone_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "watering_sequence" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "sequence_zone_zone_key_fkey" FOREIGN KEY ("zone_key") REFERENCES "zone" ("zone_key") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "sequence_wave" (
    "sequence_id" TEXT NOT NULL,
    "wave_index" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "due_at" DATETIME,
    "sent_at" DATETIME,
    "delivery" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("sequence_id", "wave_index"),
    CONSTRAINT "sequence_wave_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "watering_sequence" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "wave_station" (
    "sequence_id" TEXT NOT NULL,
    "wave_index" INTEGER NOT NULL,
    "station" INTEGER NOT NULL,
    "run_minutes" REAL NOT NULL,

    PRIMARY KEY ("sequence_id", "wave_index", "station"),
    CONSTRAINT "wave_station_sequence_id_wave_index_fkey" FOREIGN KEY ("sequence_id", "wave_index") REFERENCES "sequence_wave" ("sequence_id", "wave_index") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "zone_watering" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "zone_key" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "minutes" REAL NOT NULL,
    "sequence_id" TEXT,
    "wave_index" INTEGER,
    CONSTRAINT "zone_watering_zone_key_fkey" FOREIGN KEY ("zone_key") REFERENCES "zone" ("zone_key") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "zone_watering_sequence_id_wave_index_fkey" FOREIGN KEY ("sequence_id", "wave_index") REFERENCES "sequence_wave" ("sequence_id", "wave_index") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "open_alert" (
    "alert_key" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "since" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "zone_state" (
    "zone_key" TEXT NOT NULL PRIMARY KEY,
    "dry_since" DATETIME,
    "no_data_since" DATETIME,
    "evaluated_at" DATETIME NOT NULL,
    CONSTRAINT "zone_state_zone_key_fkey" FOREIGN KEY ("zone_key") REFERENCES "zone" ("zone_key") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "service_run_id" INTEGER,
    "data" JSONB NOT NULL,
    "device_id" TEXT,
    "zone_key" TEXT,
    "sequence_id" TEXT
);

-- CreateTable
CREATE TABLE "sensor_reading" (
    "sensor_id" TEXT NOT NULL,
    "measured_at" DATETIME NOT NULL,
    "polled_at" DATETIME NOT NULL,
    "moisture_pct" REAL,
    "temperature_c" REAL,
    "battery_pct" REAL,
    "online" BOOLEAN NOT NULL,

    PRIMARY KEY ("sensor_id", "measured_at")
);

-- CreateIndex
CREATE UNIQUE INDEX "zone_device_station" ON "zone"("device_id", "station");

-- CreateIndex
CREATE INDEX "watering_sequence_created" ON "watering_sequence"("created_at");

-- CreateIndex
CREATE INDEX "watering_sequence_device_created" ON "watering_sequence"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "watering_sequence_device_status" ON "watering_sequence"("device_id", "status");

-- CreateIndex
CREATE INDEX "sequence_zone_zone" ON "sequence_zone"("zone_key");

-- CreateIndex
CREATE INDEX "zone_watering_zone_time" ON "zone_watering"("zone_key", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "zone_watering_once_per_wave" ON "zone_watering"("sequence_id", "wave_index", "zone_key");

-- CreateIndex
CREATE INDEX "audit_event_ts" ON "audit_event"("ts");

-- CreateIndex
CREATE INDEX "audit_event_type_ts" ON "audit_event"("type", "ts");

-- CreateIndex
CREATE INDEX "audit_event_device" ON "audit_event"("device_id", "ts");

-- CreateIndex
CREATE INDEX "audit_event_zone" ON "audit_event"("zone_key", "ts");

-- CreateIndex
CREATE INDEX "audit_event_sequence" ON "audit_event"("sequence_id", "ts");
