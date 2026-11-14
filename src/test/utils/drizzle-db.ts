import { copyFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_ID } from '../../db/connection.ts';

/**
 * Databases as the drizzle-based version of the conductor left them, for the conversion tests.
 *
 * - `conductor-drizzle-era.db` was written by that version's own code (its store, sessions and audit log;
 *   see make-fixture.ts.txt in the same folder): the real thing, with everything a running conductor writes.
 * - `buildDrizzleDatabase()` rebuilds one from that version's migrations (kept in the fixtures folder), at
 *   any of its three migration levels, for cases the fixture can't show.
 */

const FIXTURES = fileURLToPath(new URL('../fixtures/drizzle/', import.meta.url));

export const DRIZZLE_MIGRATIONS = ['20261114070421_init', '20261114070423_append_only_triggers', '20261114185256_views_owned_by_app'] as const;

/** Copies the database written by the drizzle-based version to `path`. */
export const copyDrizzleFixture = (path: string): string => {
  copyFileSync(join(FIXTURES, 'conductor-drizzle-era.db'), path);
  return path;
};

/** The drizzle-era database at `path`, with the first `level` migrations applied, as that version did. */
export const buildDrizzleDatabase = (path: string, level: 1 | 2 | 3 = 3): DatabaseSync => {
  const client = new DatabaseSync(path);
  client.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  client.exec('PRAGMA journal_mode = WAL');
  client.exec(`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`);
  for (const name of DRIZZLE_MIGRATIONS.slice(0, level)) {
    const sql = readFileSync(join(FIXTURES, `${name}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) client.exec(statement);
    client.prepare('INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)').run(`hash-${name}`, 0, name, '2026-11-14T07:00:00.000Z');
  }
  // At its last level the app re-created its views and triggers at every start.
  if (level === 3) {
    client.exec('DROP TRIGGER IF EXISTS zone_watering_no_update; DROP TRIGGER IF EXISTS audit_event_no_update');
    client.exec(readFileSync(join(FIXTURES, 'app-views-and-triggers.sql'), 'utf8'));
  }
  return client;
};

/** A small set of rows in every table, written the way that version wrote them. */
export const fillDrizzleDatabase = (client: DatabaseSync): void => {
  const t = (m: number) => new Date(Date.parse('2026-07-01T11:00:00.000Z') + m * 60_000).toISOString();
  client.exec('BEGIN');
  client.prepare(`INSERT INTO service_run (id, started_at, mode, dry_run, pid, config_hash, config_json, heartbeat_at) VALUES (1, ?, 'continuous', 0, 7, 'h', '{"zones":1}', ?)`).run(t(0), t(15));
  client.prepare(`INSERT INTO zone VALUES ('d:1', 'd', 1, 'Front', ?, ?)`).run(t(0), t(0));
  client.prepare(`INSERT INTO watering_sequence (id, service_run_id, device_id, soak_minutes, created_at) VALUES ('s1', 1, 'd', 20, ?)`).run(t(0));
  client.prepare(`INSERT INTO sequence_zone VALUES ('s1', 'd:1', 'Front', 22.5, ?, 30, 40, 16, 30, 0.4, '{"inches":0.4}', 'dry')`).run(t(-3));
  client.prepare(`INSERT INTO sequence_wave VALUES ('s1', 0, 'delivered', ?, ?, 'event', 0), ('s1', 1, 'sending', ?, ?, NULL, 1)`).run(t(0), t(0), t(28), t(29));
  client.exec(`INSERT INTO wave_station VALUES ('s1', 0, 1, 8), ('s1', 1, 1, 8)`);
  client.prepare(`INSERT INTO zone_watering (zone_key, started_at, minutes, sequence_id, wave_index) VALUES ('d:1', ?, 8, 's1', 0), ('d:1', ?, 5, NULL, NULL)`).run(t(0), t(-300));
  client.prepare(`INSERT INTO open_alert (alert_key, state, since) VALUES ('battery:sensor:s1', 'low', ?)`).run(t(1));
  client.prepare(`INSERT INTO zone_state VALUES ('d:1', ?, NULL, ?)`).run(t(-10), t(15));
  client.prepare(`INSERT INTO audit_event (ts, type, service_run_id, data) VALUES (?, 'service.started', 1, '{"mode":"continuous"}'), (?, 'wave.sent', 1, '{"sequence":"s1","device":"d","cycle":2}')`).run(t(0), t(29));
  client.prepare(`INSERT INTO sensor_reading VALUES ('s1', ?, ?, 22.5, 20.1, 80, 1)`).run(t(-3), t(0));
  client.exec('COMMIT');
};
