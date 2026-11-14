# SQLite storage: design

Status: proposal. DDL: [sqlite-schema.sql](sqlite-schema.sql).

Replaces `.conductor-state.json` (`CONDUCTOR_STATE`) and `.conductor-audit.jsonl` (`CONDUCTOR_AUDIT`)
with one SQLite file (e.g. `CONDUCTOR_DB`, default `.conductor.db`). Adds a permanent record of every
watering sequence the conductor planned and what became of it.

"Watering schedule" here means the conductor's own schedule: cycle-and-soak sequences, their waves
and when each is due. B-hyve's programs are not stored (see [Not stored](#deliberately-not-stored)).

## 1. What the code persists today

| Data | Where it lives now | Kept for | Used for | Lost on restart? |
|---|---|---|---|---|
| Supplemental runs `{zoneKey, at, minutes}` | state file `runs` (`WateringHistory`) | pruned to max(longest cooldown, 24 h) | cooldown, rolling 24 h cap (`plan.ts evaluateZone`) | no |
| Unfinished sequences (`PendingSequence`) | state file `sequences` | deleted when completed/abandoned | crash/restart recovery (`Sequencer.resume`) | no |
| Open alert conditions | state file `alerts` (`AlertTracker`) | while open | not re-alerting after a restart | no |
| Audit events | JSONL, append-only | forever | `npm run audit`, notifications (tee), unclean-shutdown detection (last line) | no |
| Dry-spell start per zone (`Monitor #drySince`) | memory | | `waitedHours` → `maxWaitHours` in the water budget | **yes** |
| No-data start per zone (`#noDataSince`) | memory | | `zone.no_data` / `zone.data_restored` pairs | **yes** |
| Finished sequences: plan vs. delivered, per wave | audit JSON only (untyped) | | post-incident review | n/a |
| Why a zone was watered (reading, budget) | `sequence.started` payload only | | review | n/a |
| Sensor readings | nowhere | | | n/a |

Behaviour worth knowing before changing storage:

- `save()` rewrites the whole state after every Sequencer step (`Monitor #persist`, queued). The
  crash rule "mark the wave in flight, save, then send" only works if that save is on disk before the
  command leaves. Today's `writeFile` + `rename` never fsyncs, so a power cut can still lose it.
- Dry runs must leave no trace in the state (`#persist` returns early). They do write audit events.
- Sequence ids are `randomUUID().slice(0, 8)`. That's fine while ids only live until a sequence ends,
  but they will collide eventually once kept forever.
- An unclean shutdown is detected when the audit file's last event isn't `service.stopped`. A
  `conductor:check` run next to the live service breaks this today, because both append to the same file.
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
| **3: optional** | `zone_state` | persists `#drySince` / `#noDataSince` (a behaviour change, see §6) |
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

## 4. Tables (the reasons; columns are in the SQL)

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
(today's `WateringRun.at`). It is technically derivable from delivered waves, but it is kept separate on purpose:
the safety rules then depend on one narrow, append-only, indexed table, and it survives sequence
retention. `UNIQUE(sequence_id, wave_index, zone_key)` makes counting a wave twice impossible. No
more `prune()`: queries are bounded by time and use `zone_watering_zone_time`.

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
alive. Their `stop_reason` becomes `'unclean'`.

## 5. Where the code writes (implementation map)

Each line below is one transaction.

| Code point | SQL |
|---|---|
| `index.ts` startup | insert `service_run`; close earlier unstopped runs as `unclean` (+ `service.unclean_shutdown`); upsert `zone` from config |
| `Sequencer.start` | insert sequence, `sequence_zone`s, all waves (wave 0 `due_at = now`), `wave_station`s |
| `#attempt`, before `startWatering` | wave `pending → sending`, `sent_at = now`; **committed before the command is sent** |
| send failed / `idle` / `wave.deferred` | wave back to `pending`, `sent_at = NULL`, `failed_attempts + 1` |
| `#recordDelivered` | wave → `delivered` + `delivery`; insert `zone_watering` rows; set next wave `due_at`; if none left → sequence `completed` |
| `resume` finds `sending` | same as delivered with `delivery = 'assumed'` |
| `#abandon` | sequence `abandoned` + reason; remaining waves `skipped` |
| `AlertTracker #set` / delete | upsert / delete `open_alert` |
| `AuditSink.record` | insert `audit_event` (sync with `node:sqlite`, so order is preserved and the write queue and `flush()` go away; errors are still caught and logged, never thrown) |
| after each poll | `service_run.heartbeat_at`; optionally `zone_state`, `sensor_reading` |
| shutdown | `service_run.stopped_at`, `stop_reason` |

`Monitor #persist()` / `StateStore.save(state)` become unnecessary; writes are incremental. `plan.ts`
can stay pure. Either load a `WateringHistory` from `zone_watering` for the last
max(longest cooldown, 24 h) and write through on `record()`, or implement `WateringHistoryView` with these
two queries (they match `history.ts` exactly, including `at > now − 24h`):

```sql
-- lastRun(zoneKey)
SELECT started_at, minutes FROM zone_watering WHERE zone_key = ? ORDER BY started_at DESC, id DESC LIMIT 1;
-- minutesInLastDay(zoneKey, now)
SELECT coalesce(sum(minutes), 0) FROM zone_watering WHERE zone_key = :k AND started_at > :now_minus_24h AND started_at <= :now;
```

## 6. Decisions and risks

1. **Durability: `synchronous = FULL` (WAL).** With `NORMAL`, a power cut can drop the last commits,
   including the `sending` marker. A wave could then be sent, lost from disk and re-sent after reboot,
   which is exactly what "never water twice" forbids. The cost is one fsync per commit, a few per poll.
   This is stronger than today's un-fsynced temp-file rename.
2. **Driver: `node:sqlite` (`DatabaseSync`).** Built into Node 26, so no native build on a Raspberry Pi
   (unlike `better-sqlite3`). It is synchronous, which suits the tiny write volume and keeps audit ordering.
3. **One file, not two.** One file lets a state change and its audit event share a transaction
   (optional; today a crash between them is possible and harmless). The downside is a shared failure
   domain: on a full disk, `state.save_failed` can't be audited and falls back to the log. In practice
   that's already true, since both files are on the same disk.
4. **Timestamps are ISO-8601 TEXT** from `toISOString()`, with a GLOB check. They're readable in the
   `sqlite3` shell and sort correctly. There are no SQLite-side `now` defaults (virtual time).
5. **Sequence ids become full UUIDs.** Show the first 8 characters as today; the CLI does a prefix
   match. Imported 8-char ids still fit.
6. **Dry run writes only `service_run` (`dry_run = 1`) and `audit_event`**, never the operational
   tables, as today. Only a non-dry run may close other runs as `unclean`. Otherwise `conductor:check`
   next to the live service would flag it as crashed (the JSONL approach has this bug today). Two
   non-dry instances on one DB would still be a problem, as they are now. A lock row or PID file is a
   separate decision.
7. **`zone_state` is a behaviour change.** Today a restart resets `#drySince`, so a zone can wait for
   rain longer than `maxWaitHours` across restarts (the README's "persisted dry-spell tracking" item).
   If adopted, discard a spell whose `evaluated_at` is older than about 2 poll intervals: after a long
   outage, earlier waiting says nothing about the current forecast. I have not persisted
   `#lastReason` on purpose, because re-auditing every zone's decision after a restart is useful context.
8. **Stuck "active" sequence.** If a sequence were left `active` with no remaining wave, the
   one-per-device index would block that device. `pending_sequence` shows it (`next_wave = wave_count`)
   and the loader must complete it. Today's resume logic already closes or resumes every loaded sequence.
9. **Retention** (about 50–100 audit events a day → a few MB a year). Keep `zone_watering` and
   sequences forever (reporting). Trim `audit_event` and `sensor_reading` after N months if wanted.
   This replaces the logrotate advice in disaster-recovery.md.

## 7. Migration from the JSON files

On first start, if the DB is empty and the old files exist, run one transaction:

- state `runs` → `zone_watering` with `sequence_id = NULL` (upsert `zone` rows for unknown keys).
- state `sequences` → sequences (keep the ids). Waves before `nextWave` become `delivered`/`assumed`
  **without ledger rows**, because those minutes are already in `runs`; importing both would double-count.
  `inFlight` → wave `sending`.
- state `alerts` → `open_alert`.
- JSONL → `audit_event`, skipping torn lines as `parseAudit` does.

Then rename both files to `*.imported`.

## 8. Deliberately not stored

- **B-hyve programs and the weather forecast.** They are re-fetched when needed, and watering can't
  happen without B-hyve anyway. `sequence_zone.budget_json` keeps what the forecast meant for the decision.
- **Connection-health outage state** and the **Notifier / Telegram queue.** These are in memory. A
  restart re-detects outages, and dropped messages are audited (`notification.failed`). A notification
  outbox table can come later.
- **Every per-poll decision.** The audit records changes. With `sensor_reading` and
  `service_run.config_json`, any decision can be reconstructed.

## 9. Validation done

The DDL was loaded on SQLite 3.50 (`node:sqlite`) and 3.45. A scratch script checked the following:

- All 283 simulated audit events in `simulations/*.audit.jsonl` import and round-trip unchanged.
- The `crash-mid-soak` sequence replayed through the write points above. `pending_sequence` returns the
  `PendingSequence` the Sequencer expects, including the in-flight wave and the retry count.
- Cooldown and 24 h-cap queries match `history.ts`, including the exact-24 h boundary, and use the index.
- Each constraint rejects what it should: a second active sequence per device, double-counting, bad
  timestamps, edits to the ledger or audit, and invalid wave states.
