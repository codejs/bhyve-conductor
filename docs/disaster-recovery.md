# Disaster recovery: connection failures during watering

The conductor talks to three cloud services: **Tuya** (soil sensors), **B-hyve** (REST API for device
status and programs, plus a WebSocket that carries watering commands) and **Open-Meteo** (forecast).
Any of them can fail at any moment, including in the middle of a cycle-and-soak sequence. This page
lists what can go wrong, what the conductor does about it automatically, and how to review it afterwards.

## Guiding rules

1. **Never water twice.** A command that *might* have reached the controller is counted as delivered.
   A command is re-sent only when it provably didn't start: the send itself failed, or B-hyve reported
   the controller idle on two checks, with no start event in between, while the run would still be going.
2. **When in doubt, don't water.** No fresh sensor data means no supplemental watering. An unreadable
   device status means the next cycle waits rather than being sent blind.
3. **The owner wins.** If the controller is switched off or given a rain delay mid-sequence, the rest of
   the sequence is abandoned.
4. **Nothing hangs.** Every request has a timeout (20 s, socket connect 15 s), and each poll has a
   10-minute watchdog, so one stuck connection can't stop monitoring.
5. **Everything is on the record.** Each failure and recovery goes to the audit trail
   (`.conductor-audit.jsonl`, set by `CONDUCTOR_AUDIT`).

The controller itself runs a manual run to completion on its own. Losing the connection *while
water is flowing* doesn't stop or extend the watering. The risky moments are when a command is being
sent, and the soak gaps between cycles.

## Scenarios

| # | What happens | Automatic response | Audit events | You need to |
|---|---|---|---|---|
| 1 | **Tuya unreachable** (cloud down, token errors, timeouts) | Zones without usable readings are not watered (`no-data`); polling continues. The regular B-hyve schedule is unaffected. | `connection.lost` (service `tuya`), `zone.no_data` → `connection.restored`, `zone.data_restored` (with durations) | Nothing for short outages. For long ones, check the Tuya project/subscription; the lawn only gets its regular schedule meanwhile. |
| 2 | **A sensor goes offline or stale** (battery, Zigbee gateway) while Tuya answers | That zone is treated as `no-data`. Other sensors in the zone are still used. | `zone.no_data` (detail says `offline` / `stale (N min old)`) → `zone.data_restored` | Replace the battery or check the gateway. |
| 3 | **B-hyve REST unreachable** when planning | The poll fails; nothing is started. Next poll tries again. | `connection.lost` (`bhyve`), `poll.failed` → `connection.restored` | Nothing. |
| 4 | **Command socket down** when a cycle is due | Retried after 1, 2, 5, 10, 10… min, until `retryWindowMinutes` (default 30) after it was due; the last attempt is at the end of the window. Then the rest of the sequence is abandoned, and the zone is re-evaluated from its sensors after the cooldown. | `wave.send_failed`, `wave.retry_scheduled`, `connection.lost`/`restored` (`bhyve-commands`); finally `sequence.completed` or `sequence.abandoned` | Check `npm run audit:summary` for abandoned sequences. |
| 5 | **Command sent, but no acknowledgement** (socket dropped right after sending) | Waits `confirmTimeoutSeconds` (20) for the device event, then checks the device status twice. Watering → confirmed. Idle twice → not started → retried as in #4. Status unreadable, or the cycle is too short to tell → counted as delivered, never re-sent. | `wave.confirmed` (`via: event/status`), `wave.not_started`, or `wave.unconfirmed` | Review `wave.unconfirmed` entries: that water *probably* ran. If the lawn shows it didn't, there's no harm; the next dry reading waters again. |
| 6 | **Controller offline** (Wi-Fi/bridge) during the soak | The next cycle waits and is retried as in #4. | `wave.deferred` (`the device is offline`) | Check the controller or bridge. |
| 7 | **Controller busy** (a scheduled program started during the soak) | The next cycle waits until it's idle. | `wave.deferred` (`busy watering`) | Nothing. |
| 8 | **Owner switches the controller off, or sets a rain delay,** during the soak | The rest of the sequence is abandoned. Nothing is sent. New runs are also skipped while it's off or delayed. | `sequence.abandoned` (`the device was switched off` / `a 48h rain delay was set`) | Nothing. |
| 9 | **Device status unreadable** before a later cycle | The cycle is not sent blind (the owner might have switched the controller off). It's retried as in #4. | `wave.deferred` (`could not read the device status`) | Nothing. |
| 10 | **Conductor crashes, is killed, or loses power** mid-sequence | Progress is saved after every step. On restart: sequences resume on schedule if the next cycle was due at most `resumeWindowMinutes` (60) ago, otherwise they're abandoned. A cycle found *mid-send* is counted as delivered. | `service.unclean_shutdown`, `sequence.resumed`, `wave.assumed_delivered`, or `sequence.abandoned` (`too late to resume…`) | Find out why it crashed (service logs). Run it under systemd/pm2 with auto-restart so it comes back within the resume window. |
| 11 | **Clean stop** (SIGTERM/Ctrl+C) mid-sequence | Timers stop; the sequence stays saved and resumes on the next start (see #10). | `service.stopped` | Restart within the resume window, or the rest is abandoned. |
| 12 | **A request hangs** (half-open connection) | Times out after 20 s. If something else hangs, the 10-minute poll watchdog gives up on that poll and the loop continues. A late-waking stale poll can't start a second sequence on a device. | `poll.failed` (`timed out…` / `poll did not finish within 10 min`) | A watchdog entry means an unexpected hang: please report it. |
| 13 | **Open-Meteo unreachable** | Dry zones get their fixed `runMinutes` for that poll. | `connection.lost` (`weather`) → `connection.restored` | Nothing. |
| 14 | **State file can't be written** (disk full, permissions) | Watering continues, but cooldowns and pending cycles won't survive a restart. | `state.save_failed` | Fix the disk or permissions. |
| 15 | **Audit file can't be written** | Logged as an error; operation is unaffected. | (service log only) | Fix the disk or permissions. |
| 16 | **Telegram unreachable** | Notifications are retried (5 s → 10 min), then dropped; watering is never affected. | `notification.failed` | Check the bot token/chat (`npm run notify:test`). |

## Being told, and rehearsing

- With Telegram configured, the critical events above (connection lost past the grace period, abandoned
  watering, crash restarts, the watchdog, state-save failures) arrive as messages. See
  [notifications.md](notifications.md).
- Every scenario on this page can be replayed in virtual time with `npm run simulate`, which produces an
  audit trail you can review with the commands below. See [notifications.md](notifications.md#simulations).

## Reviewing what happened

```bash
npm run audit                                 # last 24 h, everything (! marks failures/recoveries)
npm run audit:recovery                        # only failures and recoveries
npm run audit:summary -- --since 7d           # outages with durations + fate of every watering sequence
npm run audit -- --sequence 3f9a1c2e          # one watering sequence, start to finish
npm run audit -- --zone <deviceId>:1          # everything about one zone
npm run audit -- --device <deviceId>          # everything about one controller
npm run audit -- --type connection,socket     # by event type (prefixes)
npm run audit -- --since 2026-07-01T06:00 --until 2026-07-01T12:00
npm run audit -- --tz America/Chicago         # show times in a specific zone (default: this machine's)
npm run audit -- --json | jq …                # raw events for further processing
```

A typical review after an incident:

1. `npm run audit:summary -- --since 2d`: which services were down, for how long, and was any
   watering sequence abandoned, or had retries or unconfirmed cycles?
2. For each sequence of interest: `npm run audit -- --sequence <id>`, the exact timeline.
3. `npm run audit:recovery -- --since 2d`: anything else that went wrong (sensor blackouts, crashes).

Example: the command socket dropped during a soak and came back a minute later:

```
23:58:31    wave.confirmed           confirmed timer-1 [seq 3b03f22a] cycle 1/2 via event
23:58:50  ! socket.disconnected      B-hyve socket disconnected (code 1006)
23:59:33  ! connection.lost          bhyve-commands unreachable: B-hyve socket closed before opening (code 1006)
23:59:33  ! wave.send_failed         send failed timer-1 [seq 3b03f22a] cycle 2/2: B-hyve socket closed before opening (code 1006)
23:59:34  ! wave.retry_scheduled     retry timer-1 [seq 3b03f22a] cycle 2/2 #2 in 1 min (…)
00:00:34  ! connection.restored      bhyve-commands reachable again after 1 min (1 failed attempts; …)
00:00:34    wave.sent                sent timer-1 [seq 3b03f22a] cycle 2/2 (attempt 2): st1 1min
00:00:34    wave.confirmed           confirmed timer-1 [seq 3b03f22a] cycle 2/2 via event
00:00:34    sequence.completed       watering completed timer-1 [seq 3b03f22a]: 2 min in 2 cycle(s)
```

## Settings

In `conductor.json` (all optional):

```json
"recovery": {
  "confirmTimeoutSeconds": 20,
  "retryWindowMinutes": 30,
  "resumeWindowMinutes": 60
}
```

- `confirmTimeoutSeconds`: how long to wait for the controller to acknowledge a command before
  checking its status.
- `retryWindowMinutes`: how long after a cycle was due to keep retrying it. Longer means more
  resilient to outages, but the soak between cycles may stretch well beyond `soakMinutes`.
- `resumeWindowMinutes`: after a restart, resume a sequence only if its next cycle was due at most this
  long ago. Past that, the soil has changed enough that a fresh decision from the sensors is better.

## Operating tips

- Run the conductor under a supervisor that restarts it (systemd `Restart=always`, pm2, Docker
  `restart: unless-stopped`), so a crash is followed by a resume within the window.
- The audit file only grows (a few KB a day). Rotate it with `logrotate` using `copytruncate`, or just
  archive it occasionally. The conductor only reads the last 64 KB at startup.
- Keep `.conductor-state.json` on persistent storage; it holds the cooldowns and pending cycles.

## Assumptions to be aware of

The B-hyve API is unofficial. Confirmation relies on the device sending a `watering_in_progress_notification`
or `change_mode` event, with `status.watering_status` in the device details as the fallback. If Orbit
changes either, commands will show up as `wave.unconfirmed` rather than being re-sent (rule 1), so a
sudden stream of `wave.unconfirmed` events means the confirmation signals need checking.
