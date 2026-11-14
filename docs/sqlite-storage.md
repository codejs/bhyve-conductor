# SQLite storage

Status: in use. The conductor keeps everything in one SQLite file (`CONDUCTOR_DB`, default
`.conductor.db`): the watering history, the schedule and result of every watering sequence, pending
cycles, open alerts, dry spells, sensor readings and the audit trail. It replaced `.conductor-state.json`
(`CONDUCTOR_STATE`) and `.conductor-audit.jsonl` (`CONDUCTOR_AUDIT`), which are imported once
(see [§7](#7-migration-from-the-json-files)).

Source of truth: [`src/db/schema.ts`](../src/db/schema.ts) (drizzle-orm). DDL: the generated
[`drizzle/*/migration.sql`](../drizzle); views and triggers: [`src/db/repeatable.ts`](../src/db/repeatable.ts).
How the code uses it: [§5](#5-where-the-code-writes). Changing the schema: [§9](#changing-the-schema).

"Watering schedule" here means the conductor's own schedule: cycle-and-soak sequences, their waves
and when each is due. B-hyve's programs are not stored (see [Not stored](#deliberately-not-stored)).

## 1. What the code persisted before the database

| Data | Where it lives now | Kept for | Used for | Lost on restart? |
|---|---|---|---|---|
| Supplemental runs `{zoneKey, at, minutes}` | state file `runs` (`WateringHistory`) | pruned to max(longest cooldown, 24 h) | cooldown, rolling 24 h cap (`plan.ts evaluateZone`) | no |
| Unfinished sequences (`PendingSequence`) | state file `sequences` | deleted when completed/abandoned | crash/restart recovery (`Sequencer.resume`) | no |
| Open alert conditions | state file `alerts` (`AlertTracker`) | while open | not re-alerting after a restart | no |
| Audit events | JSONL, append-only | forever | `npm run audit`, notifications (tee), unclean-shutdown detection (last line) | no |
| Dry-spell start per zone (`Monitor #drySince`) | memory | | `waitedHours` → `maxWaitHours` in the water budget | **yes** (now saved, §6.7) |
| No-data start per zone (`#noDataSince`) | memory | | `zone.no_data` / `zone.data_restored` pairs | **yes** (now saved, §6.7) |
| Finished sequences: plan vs. delivered, per wave | audit JSON only (untyped) | | post-incident review | n/a |
| Why a zone was watered (reading, budget) | `sequence.started` payload only | | review | n/a |
| Sensor readings | nowhere | | | n/a |

Behaviour that shaped the design:

- `save()` rewrote the whole state after every Sequencer step (`Monitor #persist`, queued). The
  crash rule "mark the wave in flight, save, then send" only works if that save is on disk before the
  command leaves. The `writeFile` + `rename` never fsynced, so a power cut could still lose it.
- Dry runs must leave no trace in the state. They do write audit events.
- Sequence ids were `randomUUID().slice(0, 8)`. That was fine while ids only lived until a sequence ended,
  but they would collide eventually once kept forever.
- An unclean shutdown was detected when the audit file's last event wasn't `service.stopped`. A
  `conductor:check` run next to the live service broke this, because both appended to the same file.
- Simulations and tests run on a `VirtualClock`, so all timestamps must come from the app, not SQLite.

## 2. What is crucial, in tiers

| Tier | Table | Why |
|---|---|---|
| **1: needed to water correctly** | `zone_watering` | cooldowns and daily caps across restarts (prevents crash-loop over-watering) |
| | `watering_sequence`, `sequence_wave`, `wave_station` | resume/abandon after a crash, "never water twice"; also the permanent schedule + results |
| | `open_alert` | no duplicate alerts after restart |
| | `service_run` | unclean-shutdown detection, which config was in force |
| | `audit_event` | the review trail and "everything is on the record" |
| | `zone` | FK anchor so ledger rows can't reference a mistyped zone |
| **2: results / explanations** | `sequence_zone` | why each zone was watered (reading, threshold, forecast budget) |
| **3: behaviour** | `zone_state` | persists `#drySince` / `#noDataSince` (a behaviour change, see §6.7) |
| | `sensor_reading` | calibration, anomaly detection, water-use reports (README TODO items) |

## 3. Model

```
service_run 1──* watering_sequence 1──* sequence_wave 1──* wave_station
                        │                    │
                        │ 1──* sequence_zone *──1 zone 1──* zone_watering *──0..1 sequence_wave
                        │                           1──0..1 zone_state
open_alert    (stand-alone, current conditions only)
audit_event   (stand-alone, no FKs; device/zone/sequence extracted from the JSON payload)
sensor_reading(stand-alone)
```

`conductor.json` stays the source of truth for rules. `zone` rows are upserted from it at each start
and never deleted. `service_run.config_json` keeps the effective config of every run.

## 4. Tables (the reasons; columns are in `src/db/schema.ts`)

**`watering_sequence` / `sequence_wave` / `wave_station`**: the normalised `PendingSequence`. The wave
row is the single source of truth for progress. There are no duplicated `nextWave`/`attempts` columns to
drift. The `pending_sequence` view rebuilds exactly what `Sequencer.resume()` needs:

| `PendingSequence` field | Stored as |
|---|---|
| `id`, `deviceId`, `soakMinutes`, `createdAt` | `watering_sequence` columns |
| `waves` | `wave_station` grouped by `wave_index`, `ORDER BY station` (plan.ts sorts them) |
| `zoneNames` | `sequence_zone.zone_name` |
| `nextWave` | lowest `wave_index` with status `pending`/`sending` |
| `dueAt`, `attempts` | that wave's `due_at`, `failed_attempts` |
| `inFlight {wave, since}` | that wave if `status = 'sending'` (`sent_at`) |

Wave status: `pending → sending → delivered`. On a send failure or "idle twice" it goes
`sending → pending`. On abandon it becomes `skipped`. `delivery` is `event | status | unconfirmed | assumed`,
so "water that *probably* ran" (`wave.unconfirmed`, `wave.assumed_delivered`) can be queried. The
partial unique index `one_active_per_device` mirrors the Sequencer's in-memory rule. If memory and disk
ever disagree, the insert fails instead of a second sequence watering the same device.

**`zone_watering`** is the ledger that cooldown and the daily cap read. It is written in the same
transaction that marks a wave delivered: one row per station, `started_at` = the wave's `sent_at`
(`WateringRun.at`). It is technically derivable from delivered waves, but it is kept separate on purpose:
the safety rules then depend on one narrow, append-only, indexed table, and it survives sequence
retention. The FK to the wave is `ON DELETE SET NULL`, and the append-only trigger allows exactly that
one update: dropping the provenance and nothing else. `UNIQUE(sequence_id, wave_index, zone_key)`
makes counting a wave twice impossible. No more `prune()`: queries are bounded by time and use
`zone_watering_zone_time`.

**`open_alert`**: `AlertTracker.state` one-to-one. Keys stay opaque; `kind` is derived and checked.

**`audit_event`** holds the same events and payloads as the JSONL, so `AuditSink`, the Notifier tee and
`report.ts` keep working. `device_id`, `zone_key` and `sequence_id` are generated columns over the JSON
payload, so the writer stays generic and the `npm run audit` filters use indexes. For multi-zone
events (`sequence.started`, `wave.*`), `--zone` can now be answered exactly via
`sequence_id IN (SELECT sequence_id FROM sequence_zone WHERE zone_key = ?)`. There are deliberately no
FKs and no type CHECK beyond the timestamp format: auditing must never be refused. A trigger blocks
UPDATE; DELETE stays allowed for retention.

**`service_run`**: one row per process start, with a `heartbeat_at` updated after every poll. On start,
rows with `stopped_at IS NULL` are the unclean shutdowns, and `heartbeat_at` is when they were last
alive. Their `stop_reason` becomes `'unclean'`. The report names the crashed run's last audit event.

**Views** (`pending_sequence`, `sequence_result`) and the **append-only triggers** are owned by the app,
not by migrations (§9): they hold no data and are re-created at startup whenever they are missing or
their definition changed.

## 5. Where the code writes

The conductor talks to a persistence interface, `ConductorStore` ([`src/conductor/store.ts`](../src/conductor/store.ts)),
with one method per step; [`src/db/store.ts`](../src/db/store.ts) implements it over SQLite. Each call is
one transaction, made when the step happens (node:sqlite is synchronous, so it is on disk before the
next line of code runs).

| Code point | Store call | SQL |
|---|---|---|
| startup (`beginSession`, [`src/db/session.ts`](../src/db/session.ts)) | — | insert `service_run`; close earlier unstopped runs as `unclean` (→ `service.unclean_shutdown`); upsert `zone` from the config; load the state |
| `Sequencer.start` | `sequenceStarted` | insert the sequence, why each zone is in it (`sequence_zone`, from the decisions), all waves (the first due now) and their stations |
| `#attempt`, before `startWatering` | `waveSending` | wave `pending → sending`, `sent_at`; **committed before the command is sent** |
| send failed / device idle / deferred | `waveFailed` | wave back to `pending`, `sent_at = NULL`, `failed_attempts + 1` |
| `#recordDelivered` | `waveDelivered` | wave → `delivered` + how (`event`, `status`, `unconfirmed`); `zone_watering` rows; the next wave's `due_at` |
| `resume` finds a wave `sending` | `waveDelivered` | the same, with `delivery = 'assumed'` |
| `#complete` / `#abandon` | `sequenceCompleted` / `sequenceAbandoned` | sequence status, `ended_at`, reason; remaining waves `skipped` |
| an alert opens or closes | `saveAlerts` | replace `open_alert` |
| every poll | `recordReadings`, `saveZoneSpells` | `sensor_reading` (each reading once), `zone_state` |
| after every poll | (`heartbeat`) | `service_run.heartbeat_at` |
| `AuditSink.record` | (`SqliteAuditLog`) | insert `audit_event` (in order; errors logged, never thrown) |
| clean shutdown | (`end`) | `service_run.stopped_at`, `stop_reason` |

At startup, `loadState()` gives the Monitor its `WateringHistory` (the ledger's runs of the last
max(longest cooldown, 24 h)), the unfinished sequences (from `pending_sequence`), the open alerts and the
zone spells. `plan.ts` stays pure: cooldowns and the daily cap are answered from that in-memory history,
which the Sequencer keeps up to date as it writes the ledger.

**When saving fails.** The Monitor and Sequencer only see the store through `guardStore()`: a failure
never stops watering. A failure that can clear up (disk full, I/O error, database locked or read-only,
by SQLite result code) keeps the write, with a copy of its arguments, and replays the backlog in order
before the next write. Once storage works again, the database catches up with everything that happened
meanwhile. Without this, a missed ledger row would shorten a cooldown after the next restart. A failure
that can't clear up (a constraint, a bug) is logged and skipped. Audit: one `state.save_failed` per
outage and one `state.save_restored` at its end (both reach Telegram even if the database is the problem).
The backlog is in memory (at most 1,000 writes): a restart during an outage loses what wasn't written.

**Dry runs** write their `service_run` and audit events, nothing else. The Monitor gives the Sequencer
a store that keeps nothing, and legacy files are not imported.

## 6. Decisions and risks

1. **Durability: `synchronous = FULL` (WAL).** With `NORMAL`, a power cut can drop the last commits,
   including the `sending` marker. A wave could then be sent, lost from disk and re-sent after reboot,
   which is exactly what "never water twice" forbids. The cost is one fsync per commit, a few per poll.
   This is stronger than the old state file's un-fsynced temp-file rename.
2. **Driver: `node:sqlite` (`DatabaseSync`) through drizzle-orm's `node-sqlite` driver.** `node:sqlite` is
   built into Node (22.13+, the project's 22.21 included), so there is no native build on a Raspberry Pi
   (unlike `better-sqlite3`). It is synchronous, which suits the tiny write volume and keeps audit
   ordering. On Node 22 it prints an "experimental feature" warning at startup; that is expected.
   drizzle's `node-sqlite` driver exists only in its 1.0 line, which is still a release candidate (see §9).
3. **One file, not two.** One file lets a state change and its audit event share a transaction
   (not used yet: a crash between a step and its audit event is possible and harmless). The downside is a shared failure
   domain: on a full disk, `state.save_failed` can't be audited and falls back to the log. In practice
   that's already true, since both files are on the same disk.
4. **Timestamps are ISO-8601 TEXT** from `toISOString()`, with a GLOB check. They're readable in the
   `sqlite3` shell and sort correctly. There are no SQLite-side `now` defaults (virtual time).
5. **Sequence ids are full UUIDs.** Messages show the first 8 characters, as before; the CLI does a prefix
   match. Imported 8-char ids still fit.
6. **Dry run writes only `service_run` (`dry_run = 1`) and `audit_event`**, never the operational
   tables. Only a non-dry run may close other runs as `unclean`. Otherwise `conductor:check`
   next to the live service would flag it as crashed (the JSONL approach had this bug). Two
   non-dry instances on one DB would still be a problem, as they were with the files. A lock row or PID file is a
   separate decision.
7. **Dry spells and sensor blackouts survive a quick restart (a behaviour change).** Before, a restart
   reset `#drySince`, so a zone could wait for rain longer than `maxWaitHours` across restarts, and an
   ongoing sensor blackout was reported again. Now they are restored if saved within 2 poll intervals.
   After a longer gap, the earlier waiting says nothing about the current forecast, so they start afresh.
   `#lastReason` is not persisted on purpose: re-auditing every zone's decision after a restart is useful context.
8. **Stuck "active" sequence.** If a sequence were left `active` with no remaining wave (a crash between
   its last two writes), the one-per-device index would block that device. `loadState()` completes it
   (except in a dry run).
9. **Retention** (about 50–100 audit events a day → a few MB a year). Keep `zone_watering` and
   sequences forever (reporting). Trim `audit_event` and `sensor_reading` after N months if wanted.
   This replaces the logrotate advice in disaster-recovery.md.

## 7. Migration from the JSON files

[`src/db/legacy-import.ts`](../src/db/legacy-import.ts). On the first real (non-dry) start, if the
database has never been used and the old files exist, one transaction imports:

- state `runs` → `zone_watering` with `sequence_id = NULL` (upsert `zone` rows for unknown keys).
- state `sequences` → sequences (keep the ids). Waves before `nextWave` become `delivered`/`assumed`
  **without ledger rows**, because those minutes are already in `runs`; importing both would double-count.
  `inFlight` → wave `sending`.
- state `alerts` → `open_alert`.
- JSONL → `audit_event`, skipping torn lines as `parseAudit` does.

Then both files are renamed to `*.imported` (never overwriting an earlier one) and `storage.imported` is
audited with the counts. If the old trail's last event isn't `service.stopped`, the old version crashed:
that is reported as `service.unclean_shutdown` like any crash. Entries that can't be imported (a bad zone
key, a second sequence on one device, an unknown alert, a torn audit line) are skipped and counted.

## 8. Deliberately not stored

- **B-hyve programs and the weather forecast.** They are re-fetched when needed, and watering can't
  happen without B-hyve anyway. `sequence_zone.budget_json` keeps what the forecast meant for the decision.
- **Connection-health outage state** and the **Notifier / Telegram queue.** These are in memory. A
  restart re-detects outages, and dropped messages are audited (`notification.failed`). A notification
  outbox table can come later.
- **Every per-poll decision.** The audit records changes. With `sensor_reading` and
  `service_run.config_json`, any decision can be reconstructed.

## 9. Implementation (drizzle-orm)

| File | What |
|---|---|
| [`src/db/schema.ts`](../src/db/schema.ts) | Tables, CHECKs, indexes, view columns, row types. Timestamps are `Date` in TypeScript and ISO text in the file (`isoTimestamp`) |
| [`src/db/repeatable.ts`](../src/db/repeatable.ts) | The views and triggers, re-created by the app (see below) |
| [`src/db/relations.ts`](../src/db/relations.ts) | Relations for `db.query.*` (e.g. a sequence with its waves and stations in one call) |
| [`src/db/database.ts`](../src/db/database.ts) | `openDatabase(path)`: pragmas, ownership check, backup, migrations, views and triggers; read-only mode |
| [`src/db/store.ts`](../src/db/store.ts) | `SqliteStore`: the `ConductorStore` steps and `loadState()` |
| [`src/db/audit-log.ts`](../src/db/audit-log.ts) | `SqliteAuditLog` and the queries behind `npm run audit` |
| [`src/db/service-run.ts`](../src/db/service-run.ts), [`session.ts`](../src/db/session.ts) | Runs, heartbeats, crash detection; one run's storage, shared by the service and the simulator |
| [`src/db/legacy-import.ts`](../src/db/legacy-import.ts) | The one-time import of the JSON files |
| [`drizzle/`](../drizzle) | Migrations: `*_init`, `*_append_only_triggers`, `*_views_owned_by_app` |
| [`drizzle.config.ts`](../drizzle.config.ts) | drizzle-kit config |

Versions: `drizzle-orm` and `drizzle-kit` are pinned to exactly `1.0.0-rc.5`. The stable 0.45 line has no
`node:sqlite` driver. Release candidates can still change, so upgrade deliberately and run the tests.

`openDatabase()` does the following, in order:

1. Opens the file and checks it belongs to the conductor. It refuses files with another `application_id`,
   or with tables but no id.
2. Sets WAL, `synchronous = FULL` and `busy_timeout`.
3. If migrations are pending:
   - copies a database that already holds data to `<file>.before-<first pending migration>`
     (`VACUUM INTO`; a retry keeps the first copy);
   - drops the app-owned views and triggers;
   - applies the migrations in one transaction with foreign keys off, then runs `PRAGMA foreign_key_check`.
   A failure rolls back completely and says why, and where the copy is.
4. Re-creates any view or trigger that is missing or changed. Views are compiled on creation, so a
   definition that no longer fits the schema fails at startup.

`npm run db:migrate` does the same for `CONDUCTOR_DB`. `npm run audit` opens the file read-only, so it
never migrates or writes, and can run next to the service.

### Changes from the approved schema

1. **No `STRICT` or `WITHOUT ROWID`.** drizzle can't express them. Adding them by hand to the generated
   SQL would be silently lost the first time drizzle-kit rebuilds the table. Types are enforced by the
   TypeScript models and the CHECKs. `WITHOUT ROWID` was only a storage optimisation.
2. **Explicit `IS NOT NULL` checks on text primary keys.** SQLite lets a non-INTEGER single-column
   primary key hold NULL. drizzle-kit never writes `NOT NULL` on a primary key, and the approved SQL had
   the same gap. This affects `zone`, `watering_sequence`, `open_alert` and `zone_state`.
3. **Ledger FK `ON DELETE SET NULL` + narrower trigger.** The approved FK (no action) blocked deleting
   old sequences, which contradicted "survives retention". With `SET NULL`, the delete is carried out as
   an UPDATE of the ledger, so the trigger now allows exactly that update.
4. **No `PRAGMA user_version`.** drizzle records applied migrations in `__drizzle_migrations`.
   `application_id` and the connection pragmas are set by `openDatabase()`, since `journal_mode` can't
   change inside the migrator's transaction.
5. **Driver errors are wrapped.** drizzle throws a `DrizzleQueryError` whose `cause` is SQLite's error
   (e.g. `UNIQUE constraint failed: watering_sequence.device_id`). Code that reacts to one (the store
   guard, the upgrade error message) looks at `cause`.
6. **Views and triggers moved out of migrations** (`*_views_owned_by_app`). A table rebuild fails while a
   view refers to the table, and silently drops the table's triggers. With the app owning them, drizzle-kit's
   generated migrations work unmodified. drizzle-kit writes `CREATE VIEW … AS null` for views declared
   `.existing()` (a drizzle-kit bug), so that one migration keeps only its `DROP VIEW IF EXISTS` lines.

### Changing the schema

1. Edit `src/db/schema.ts`, then run `npm run db:generate`, which writes `drizzle/<time>_<name>/`.
2. Read the generated `migration.sql` and commit it with its `snapshot.json`. Never edit a snapshot.
   Never edit a migration that has run anywhere; write a new one instead. To redo one that never ran,
   delete its folder and generate again.
3. Run `npm test`. The migration tests fail if the models and migrations disagree, if a statement was
   skipped, or if a view or trigger is missing.

What the data survives, with drizzle-kit's migrations as generated (each kind is tested, see below):

- **Adding a column:** `ALTER TABLE ADD`. A new `NOT NULL` column needs a **default**. Without one,
  drizzle-kit writes a migration SQLite refuses; the upgrade then fails safely (nothing changes, the
  service won't start) until the migration is regenerated with a default.
- **Most other changes** (constraints, types, keys) **rebuild the table** (copy, drop, rename). Every row
  comes through, including child rows (migrations run with foreign keys off, so the drop can't cascade)
  and the views and triggers (re-created by the app). No hand edits needed.
- **Renaming a column:** drizzle-kit asks whether it's a rename (`--hints`, or answer its prompt). If a
  view uses the column, change the view in `repeatable.ts` in the same commit; a view that no longer fits
  stops the start with a clear error.
- **Dropping a column or table** loses its data, by definition; drizzle-kit asks for confirmation.
- **Views and triggers:** edit `repeatable.ts`; no migration.
- **Hand-written migrations** (`drizzle-kit generate --custom`): put drizzle's `--> statement-breakpoint`
  line between statements, and never write that marker inside a comment. The migrator splits on it as
  plain text and runs each chunk as one statement, and `node:sqlite` ignores anything after the first.

### Tests

Everything runs against real SQLite databases (in memory, or files in a temp folder).

| File | Covers |
|---|---|
| `src/test/db/model-changes.test.ts` | **Data survives model changes.** Each test edits a copy of `schema.ts`, lets the real drizzle-kit generate the migration, and applies it to a database filled by the app's own write path (completed, abandoned and crashed-mid-send sequences, ledger, audit trail, readings, alerts, spells). Cases: a nullable column, a `NOT NULL` column with a default, a rebuilt parent table, the ledger, the audit trail, several related tables in one migration, a column rename, a new table and index, and a change SQLite refuses. Every row of every table must come through, the app must load the same state, references and integrity must hold, append-only must still be enforced, and the backup must hold the pre-upgrade data. |
| `src/test/db/migrations.test.ts` | Inventory; every statement ran; models match the database; NULL keys; pragmas; foreign files; read-only; backups (incl. a retried upgrade); rebuilt parent and trigger tables; broken references; a failed upgrade rolls back with views and triggers intact; changed and broken view definitions |
| `src/test/db/store.test.ts` | Every `SqliteStore` step, its error cases (a step matching nothing, double counting, partial writes), `loadState()` |
| `src/test/db/audit-log.test.ts`, `session.test.ts`, `legacy-import.test.ts` | The audit sink and queries; runs, heartbeats and crash detection (dry runs next to the service, several unfinished runs); the import (nothing counted twice, what the next start resumes) |
| `src/test/db/schema.test.ts` | Constraints and views at the SQL level; all simulated audit trails round-trip |
| `src/test/conductor/store.test.ts` | `guardStore()`: replay in order, skipping permanent failures, one alert per outage, the backlog limit |
| `src/test/conductor/sequencer.test.ts`, `monitor.test.ts` | The conductor on a real database: the in-flight marker is on disk before the send; schedule, reasons and results saved; a storage outage mid-sequence is caught up; restarts resume from the database; spells across quick and long restarts; readings; heartbeats; dry runs write nothing |
| `src/test/sim/scenarios.test.ts` | Every simulated scenario (outages, crashes, owner interventions...) on the real storage: the database agrees with the audit trail |
