-- CreateTable
CREATE TABLE "simulation_run" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scenario" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stored_at" DATETIME NOT NULL,
    "started_at" DATETIME NOT NULL,
    "hours" REAL NOT NULL,
    "time_zone" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "simulation_event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "simulation_run_id" INTEGER NOT NULL,
    "ts" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "device_id" TEXT,
    "zone_key" TEXT,
    "sequence_id" TEXT,
    CONSTRAINT "simulation_event_simulation_run_id_fkey" FOREIGN KEY ("simulation_run_id") REFERENCES "simulation_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "simulation_notification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "simulation_run_id" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "sent_at" DATETIME NOT NULL,
    CONSTRAINT "simulation_notification_simulation_run_id_fkey" FOREIGN KEY ("simulation_run_id") REFERENCES "simulation_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "simulation_sequence" (
    "simulation_run_id" INTEGER NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "ended_at" DATETIME,
    "abandon_reason" TEXT,
    "cycles" INTEGER NOT NULL,
    "cycles_delivered" INTEGER NOT NULL,
    "planned_minutes" REAL NOT NULL,
    "delivered_minutes" REAL NOT NULL,
    "uncertain_station_runs" INTEGER NOT NULL,
    "failed_attempts" INTEGER NOT NULL,
    "water_off_at" DATETIME,

    PRIMARY KEY ("simulation_run_id", "sequence_id"),
    CONSTRAINT "simulation_sequence_simulation_run_id_fkey" FOREIGN KEY ("simulation_run_id") REFERENCES "simulation_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "simulation_watering" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "simulation_run_id" INTEGER NOT NULL,
    "zone_key" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "minutes" REAL NOT NULL,
    "sequence_id" TEXT,
    CONSTRAINT "simulation_watering_simulation_run_id_fkey" FOREIGN KEY ("simulation_run_id") REFERENCES "simulation_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE UNIQUE INDEX "simulation_run_scenario" ON "simulation_run"("scenario");

-- CreateIndex
CREATE INDEX "simulation_event_run" ON "simulation_event"("simulation_run_id", "id");

-- CreateIndex
CREATE INDEX "simulation_notification_run" ON "simulation_notification"("simulation_run_id", "id");

-- CreateIndex
CREATE INDEX "simulation_watering_run" ON "simulation_watering"("simulation_run_id");
