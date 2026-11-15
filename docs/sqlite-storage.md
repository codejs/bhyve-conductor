# SQLite storage

Status: in use. The conductor keeps everything in one SQLite file (`CONDUCTOR_DB`, default
`.conductor.db`): the watering history, the schedule and result of every watering sequence, pending
cycles, open alerts, dry spells, sensor readings and the audit trail. It replaced `.conductor-state.json`
(`CONDUCTOR_STATE`) and `.conductor-audit.jsonl` (`CONDUCTOR_AUDIT`), which are imported once
(see [§7](#7-migration-from-the-json-files)).

ORM: [Prisma](https://www.prisma.io/) 7. Source of truth: [`prisma/schema.prisma`](../prisma/schema.prisma).
DDL: [`prisma/migrations/*/migration.sql`](../prisma/migrations), written by Prisma's schema engine. How
the code uses it: [§5](#5-where-the-code-writes). Changing the schema: [§9](#changing-the-schema). A
database of the earlier drizzle-based version is converted on the first start: [§7](#converting-a-database-of-the-drizzle-based-version).

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
| **4: review only** | `simulation_run` + `simulation_event`, `simulation_notification`, `simulation_sequence`, `simulation_watering` | simulation results kept with `npm run simulate -- --store`; only `npm run audit -- --for-simulation` reads them (§4) |

## 3. Model

```
service_run 1──* watering_sequence 1──* sequence_wave 1──* wave_station
                        │                    │
                        │ 1──* sequence_zone *──1 zone 1──* zone_watering *──0..1 sequence_wave
                        │                           1──0..1 zone_state
open_alert    (stand-alone, current conditions only)
audit_event   (stand-alone, no FKs; device/zone/sequence extracted from the JSON payload)
sensor_reading(stand-alone)

simulation_run 1──* simulation_event          (kept apart: no reference to or from the tables above)
               1──* simulation_notification
               1──* simulation_sequence
               1──* simulation_watering
```

`conductor.json` stays the source of truth for rules. `zone` rows are upserted from it at each start
and never deleted. `service_run.config_json` keeps the effective config of every run.

## 4. Tables (the reasons; columns are in `prisma/schema.prisma`)

**`watering_sequence` / `sequence_wave` / `wave_station`**: the normalised `PendingSequence`. The wave
row is the single source of truth for progress. There are no duplicated `nextWave`/`attempts` columns to
drift. `SqliteStore.loadState()` rebuilds exactly what `Sequencer.resume()` needs:

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
so "water that *probably* ran" (`wave.unconfirmed`, `wave.assumed_delivered`) can be queried. At most
one sequence per device is `active`, mirroring the Sequencer's in-memory rule: the store checks it in the
transaction that starts a sequence. If memory and disk ever disagree, the start is refused instead of a
second sequence watering the same device.

**`zone_watering`** is the ledger that cooldown and the daily cap read. It is written in the same
transaction that marks a wave delivered: one row per station, `started_at` = the wave's `sent_at`
(`WateringRun.at`). It is technically derivable from delivered waves, but it is kept separate on purpose:
the safety rules then depend on one narrow, indexed table that is only ever inserted into, and it
survives sequence retention: the FK to the wave is `ON DELETE SET NULL`. `UNIQUE(sequence_id, wave_index,
zone_key)` makes counting a wave twice impossible. No more `prune()`: queries are bounded by time and
use `zone_watering_zone_time`.

**`open_alert`**: `AlertTracker.state` one-to-one. Keys stay opaque; `kind` (the key's prefix) is
stored next to it and checked.

**`audit_event`** holds the same events and payloads as the JSONL, so `AuditSink`, the Notifier tee and
`report.ts` keep working. `device_id`, `zone_key` and `sequence_id` are copied from the payload when an
event is recorded, so the writer stays generic and the `npm run audit` filters use indexes. For multi-zone
events (`sequence.started`, `wave.*`), `--zone` can be answered exactly via `sequence_zone`. There are
deliberately no FKs: auditing must never be refused. Events are only ever inserted; old ones may be
deleted for retention.

**`service_run`**: one row per process start, with a `heartbeat_at` updated after every poll. On start,
rows with `stopped_at IS NULL` are the unclean shutdowns, and `heartbeat_at` is when they were last
alive. Their `stop_reason` becomes `'unclean'`. The report names the crashed run's last audit event.

**`simulation_run` and its children** hold the results of `npm run simulate -- --store`: per scenario its
audit trail (`simulation_event`, the same shape and filter columns as `audit_event`), the Telegram messages
it would have sent, each simulated sequence's outcome (`SqliteStore.sequenceResults()` at the end of the
run) and its watering ledger. They are **separate tables, not a flag on the conductor's own**: simulated
events carry virtual times (a summer day in 2026) and made-up devices, and nothing that runs the garden may
ever see them. Crash detection reads the last `audit_event`, cooldowns and daily caps read
`zone_watering`, the import of the JSON files checks that the database is unused, and `npm run audit`
shows the last 24 hours; none of them look at `simulation_*`, so no query can forget a filter. The
children reference their run with `ON DELETE CASCADE` and nothing else: no `zone` rows are created for
the simulated garden. `scenario` is unique: storing a scenario again replaces its previous result, in
one transaction (a failure keeps the previous one).

**No views, triggers, generated columns or CHECK constraints.** The database holds tables and indexes
only, all of them in `schema.prisma`. What the earlier version did with those objects now lives in code:
the views' queries in `SqliteStore.loadState()` / `sequenceResults()`, the value checks in
[`src/db/model.ts`](../src/db/model.ts) (called by the store before every write), and "append-only" in the
store having no operation that changes a ledger row or an audit event. See §9.

## 5. Where the code writes

The conductor talks to a persistence interface, `ConductorStore` ([`src/conductor/store.ts`](../src/conductor/store.ts)),
with one method per step; [`src/db/store.ts`](../src/db/store.ts) implements it with Prisma. Each call is
one transaction, made when the step happens, and awaited: in particular the in-flight marker is on disk
before the watering command is sent.

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
max(longest cooldown, 24 h)), the unfinished sequences, the open alerts and the zone spells. `plan.ts` stays pure: cooldowns and the daily cap are answered from that in-memory history,
which the Sequencer keeps up to date as it writes the ledger.

**When saving fails.** The Monitor and Sequencer only see the store through `guardStore()`, which also
writes in call order: a failure never stops watering. A failure that can clear up (disk full, I/O error, database locked or read-only,
by SQLite's result code, found in Prisma's error) keeps the write, with a copy of its arguments, and replays the backlog in order
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
2. **Prisma over Node's built-in `node:sqlite`, through the app's own driver adapter.** Prisma 7 runs
   without its native query engine, through a driver adapter. The official SQLite ones need native modules
   (`better-sqlite3`, `libsql`); [`src/db/adapter.ts`](../src/db/adapter.ts) uses `node:sqlite`, built into
   Node (22.13+), so there is nothing to compile on a Raspberry Pi and no engine to download. One connection
   serves everything; queries from outside a transaction wait while one is open (the official adapters let
   them run inside it). On Node 22 `node:sqlite` prints an "experimental feature" warning at startup; that
   is expected.
3. **One file, not two.** One file lets a state change and its audit event share a transaction
   (not used yet: a crash between a step and its audit event is possible and harmless). The downside is a shared failure
   domain: on a full disk, `state.save_failed` can't be audited and falls back to the log. In practice
   that's already true, since both files are on the same disk.
4. **Timestamps are ISO-8601 TEXT** from `toISOString()` ("…000Z"), written by the adapter. They're readable
   in the `sqlite3` shell and sort correctly. (The official Prisma adapters write "…000+00:00"; mixing the
   two would break text comparisons at equal instants, so keep this adapter or convert the data.) There
   are no database-side `now()` defaults (virtual time).
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
   its last two writes), the one-per-device rule would block that device. `loadState()` completes it
   (except in a dry run).
9. **Retention** (about 50–100 audit events a day → a few MB a year). Keep `zone_watering` and
   sequences forever (reporting). Trim `audit_event` and `sensor_reading` after N months if wanted.
   This replaces the logrotate advice in disaster-recovery.md.

## 7. Migration from earlier versions

### Converting a database of the drizzle-based version

[`src/db/drizzle-transfer.ts`](../src/db/drizzle-transfer.ts). The version before this one kept the same
tables and columns, managed with drizzle-orm: its file has a `__drizzle_migrations` table, CHECK
constraints, generated columns, views and triggers. On the first start of this version (or
`npm run db:migrate`), `openDatabase()` converts it. Rather than altering the old file in place, it copies
every row into a new one built from the Prisma migrations:

1. The old file is checkpointed (its WAL folded in). If another process still has it open (the old service
   still running), nothing happens and the start fails with that reason: renaming a file under a running
   process would lose its later writes. Stop the old version first.
2. `<file>.prisma-transfer` is built from the migrations, and all rows of all tables are copied in one
   transaction. Former generated columns become plain values, and the audit id counter carries over (deleted
   ids are never reused). Row counts and contents are compared table by table, both ways, and
   `PRAGMA foreign_key_check` must be clean, or nothing is committed and the old file stays as it was.
3. The old file becomes `<file>.drizzle-backup`, and the new one takes its name. `storage.transferred` is
   audited with the row counts.

A crash during the conversion leaves the old file in place (the half-built one is removed at the next
start), or, between the two renames, the finished new file next to the backup (the next start completes
the swap). A run of the old version that never stopped is reported as a crash, as usual; a sequence it left
mid-send is resumed. `npm run audit` refuses an unconverted file and says to start the conductor once.

### The JSON files of the version before the database

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

## 9. Implementation (Prisma ORM)

| File | What |
|---|---|
| [`prisma/schema.prisma`](../prisma/schema.prisma) | The data model: tables, columns, relations, indexes |
| [`prisma/migrations/`](../prisma/migrations) | Migrations, as Prisma's schema engine writes them |
| [`prisma.config.ts`](../prisma.config.ts) | Prisma CLI configuration |
| [`src/db/generated/`](../src/db/generated) | The Prisma client, generated (`npm run db:generate`); committed, so neither the Pi nor an offline machine needs the Prisma CLI |
| [`src/db/adapter.ts`](../src/db/adapter.ts) | The node:sqlite driver adapter |
| [`src/db/database.ts`](../src/db/database.ts), [`connection.ts`](../src/db/connection.ts) | `openDatabase(path)`: pragmas, ownership, conversion, backup, migrations; read-only mode |
| [`src/db/migrate.ts`](../src/db/migrate.ts) | Applies the migrations (see below) |
| [`src/db/drizzle-transfer.ts`](../src/db/drizzle-transfer.ts) | The one-time conversion of a drizzle-era file |
| [`src/db/model.ts`](../src/db/model.ts) | Value lists and the checks the store makes before writing |
| [`src/db/store.ts`](../src/db/store.ts) | `SqliteStore`: the `ConductorStore` steps, `loadState()`, `sequenceResults()` |
| [`src/db/audit-log.ts`](../src/db/audit-log.ts) | `SqliteAuditLog` and the queries behind `npm run audit` |
| [`src/db/service-run.ts`](../src/db/service-run.ts), [`session.ts`](../src/db/session.ts) | Runs, heartbeats, crash detection; one run's storage, shared by the service and the simulator |
| [`src/db/legacy-import.ts`](../src/db/legacy-import.ts) | The one-time import of the JSON files |
| [`src/sim/store.ts`](../src/sim/store.ts) | Stored simulation results: `storeSimulation()` (replacing), `listSimulations()`, `simulationEvents()`... |
| [`src/sim/command.ts`](../src/sim/command.ts), [`src/audit/command.ts`](../src/audit/command.ts) | `npm run simulate` (`--store`) and `npm run audit` (`--for-simulation`); the scripts in `src/scripts/` only wire them to the console and `.env` |
| [`src/db/schema-engine.ts`](../src/db/schema-engine.ts) | Development only: Prisma's schema engine (WebAssembly) behind `npm run db:migration` / `db:check` and the tests |

Versions are pinned exactly: `prisma`, `@prisma/client` and `@prisma/driver-adapter-utils` 7.10.0, and
`@prisma/schema-engine-wasm` at the build of that release's engine. Upgrade them together and run the tests.

**Applying migrations.** `openDatabase()` applies pending migrations itself ([`migrate.ts`](../src/db/migrate.ts)):
Prisma's `migrate deploy` needs Prisma's native engine, which isn't on the Pi, and on SQLite it runs each
migration without a transaction, so a failure halfway leaves a half-migrated database. The runner instead:

1. copies a database that already holds data to `<file>.before-<first pending migration>` (VACUUM INTO; a
   retry keeps the first copy);
2. applies all pending migrations in one transaction **with foreign keys off**. Prisma changes most SQLite
   tables by rebuilding them ("RedefineTables": copy, `DROP TABLE`, rename). With foreign keys on, that DROP
   deletes the rows first and `ON DELETE CASCADE` empties the child tables: rebuilding `watering_sequence`
   would wipe every wave, station and reason. The `PRAGMA foreign_keys=OFF` Prisma writes into the migration
   does nothing inside a transaction, so it is set out here. (This is SQLite's behaviour, not an ORM bug: the
   drizzle-based version had the same protection, and the tests show the cascade without it.);
3. requires `PRAGMA foreign_key_check` to be clean before COMMIT; otherwise everything rolls back, and the
   service refuses to start, saying why and where the copy is.

It keeps Prisma's bookkeeping (`_prisma_migrations`: the same table, names and SHA-256 checksums), so Prisma
sees the same history: `prisma migrate status` shows the database up to date, and a test checks this with
Prisma's engine. A migration edited after it was applied is reported in the log; one a Prisma tool left
unfinished stops the start (resolve it with `prisma migrate resolve`).

### Changing the schema

1. Edit `prisma/schema.prisma`.
2. `npm run db:migration -- <name>` writes `prisma/migrations/<time>_<name>/migration.sql`. It runs
   Prisma's schema engine offline and writes what `prisma migrate dev --create-only` would; on a machine that
   can download Prisma's engine, that command works too.
3. Read the SQL (see below), then `npm run db:generate` (the client) and `npm test`. The tests fail if the
   migrations don't produce the schema (`npm run db:check` checks this too), or if the client is stale.
4. Commit the migration and the client. The conductor applies the migration at its next start.

Never edit a migration that has run anywhere; write a new one. To redo one that never ran, delete its
folder and generate again.

What the data survives, with Prisma's migrations as generated (each kind is tested, see below):

- **Adding a column**: an `ALTER TABLE ADD COLUMN`, or a rebuild. A new required column needs a
  **default**. Without one, the copy fails on the existing rows; the upgrade then rolls back safely (nothing
  changes, and the service won't start) until the migration is regenerated with a default.
- **Most other changes** (defaults, types, relations, keys) **rebuild the table**. Every row comes through,
  including child rows. No hand edits are needed.
- **Renaming a field's column** (`@map`): Prisma can't tell a rename from drop-and-add, and its migration
  would lose the values. Replace that migration's SQL with
  `ALTER TABLE "<table>" RENAME COLUMN "<old>" TO "<new>";` (a test shows the result then matches the
  schema, with the data).
- **Dropping a column or table** loses its data, by definition. Prisma warns about it.

### Tests

Everything runs against real SQLite databases (in memory, or files in a temp folder).

| File | Covers |
|---|---|
| `src/test/db/model-changes.test.ts` | **Data survives model changes.** Each test edits a copy of `schema.prisma`, lets Prisma's schema engine write the migration, and applies it to a database filled by the app's own write path (completed, abandoned and crashed-mid-send sequences, ledger, audit trail, readings, alerts, spells). Cases: a nullable column, a required column with a default, a rebuilt parent table (the cascade case), the ledger, the audit trail, several related tables in one migration, a new table with a relation, a rename, and a change the data can't take. Every row must come through, the database must then match the new schema, references and integrity must hold, the app must load the same state, and the backup must hold the pre-upgrade data. |
| `src/test/db/drizzle-transfer.test.ts` | **The transition from the drizzle-based version.** A database written by that version's own code (`src/test/fixtures/drizzle/`), and ones rebuilt at each of its migration levels. Every row kept, the backup, nothing of drizzle left. The conductor carries on: the same state, the crash reported, the mid-send sequence resumed. Audit ids keep counting up. The old service still running, a failed copy, crashes during the conversion, read-only access. |
| `src/test/db/migrations.test.ts` | The migrations produce exactly `schema.prisma`; Prisma recognises the history; the client is current. Inventory (tables and indexes only); pragmas; foreign files; read-only; backups (incl. a retried upgrade); a RedefineTables keeps child rows; broken references; rollback of a failed upgrade; edited and unfinished migrations |
| `src/test/db/adapter.test.ts` | The driver adapter: types, arguments (time format), errors as Prisma reads them, transactions, savepoints, never leaving the connection in a transaction, outside queries waiting for a transaction; and through Prisma |
| `src/test/db/store.test.ts`, `model.test.ts` | Every store step and its error cases, the checks that replaced CHECK constraints, `loadState()`, `sequenceResults()`; the ledger answering like `WateringHistory`; all simulated audit trails round-trip |
| `src/test/db/audit-log.test.ts`, `session.test.ts`, `legacy-import.test.ts`, `schema-engine.test.ts` | The audit sink and queries; runs, heartbeats and crash detection; the JSON import; the migration tool |
| `src/test/conductor/store.test.ts` | `guardStore()`: call order, replay in order, skipping permanent failures, one alert per outage, the backlog limit, finding SQLite's result code in Prisma's errors |
| `src/test/conductor/sequencer.test.ts`, `monitor.test.ts` | The conductor on a real database: the in-flight marker is on disk before the send; schedule, reasons and results saved; a storage outage mid-sequence is caught up; restarts resume from the database; spells across quick and long restarts; readings; heartbeats; dry runs write nothing |
| `src/test/sim/scenarios.test.ts` | Every simulated scenario (outages, crashes, owner interventions...) on the real storage: the database agrees with the audit trail |
| `src/test/sim/store.test.ts` | Stored simulations come back exactly as simulated (events, notifications, sequences, ledger); filter columns; replacing a scenario (children too) while keeping the others; all-or-nothing; and that they stay out of the conductor's tables, its audit trail, watering history, crash detection and the JSON import; a database from before them (read-only, upgraded with a copy) |
| `src/test/audit/command.test.ts`, `src/test/sim/command.test.ts`, `src/test/scripts/simulate-audit.test.ts` | `npm run audit` never shows a stored simulation, whatever the filters (time, type, device, zone, sequence, `--json`, `--summary`); `--for-simulation` with its filters, time zones, headers, errors and old databases; `npm run simulate` with and without `--store`, `--db`, replacing, next to the conductor's data, foreign files, `--telegram`; the real scripts as processes (CONDUCTOR_DB, exit codes) |
