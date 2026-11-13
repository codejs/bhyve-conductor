# Notifications (Telegram) and simulations

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Send `/start` to your bot (or add it to a group or channel).
3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy `"chat":{"id": …}`. Groups have
   negative ids; channels can use `@channelname`.
4. Put both in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AA…
   TELEGRAM_CHAT_ID=-1001234567890
   ```
5. `npm run notify:test` sends a test message. If it fails, the error tells you whether the token
   (401) or the chat (400 "chat not found" / 403 "bot was blocked") is wrong.

Notifications are off if neither variable is set, and always off in dry-run mode (`--dry-run`,
`npm run conductor:check`).

## What you get

Every notification comes from an audit event, so anything you were told about is also in
`npm run audit`, with more detail.

| Event | Severity | Message |
|---|---|---|
| **Watering** | | |
| Watering starts | info | 💧 Watering started: zones, plan (minutes, cycles, soak), soil % per zone |
| Water off (last cycle's run time over) | info | ✅ Watering finished: total minutes and cycles |
| Each cycle (only with `"cycles": true`) | info | 💧 Cycle 2/3 started |
| Stopped early: you switched it off or set a rain delay | warning | ⚠️ Watering stopped early, with the reason and minutes delivered |
| Stopped early: B-hyve unreachable past the retry window, or too late to resume | critical | 🛑 Watering stopped early … re-evaluated after the cooldown |
| Resumed after a restart | info | 🔁 Watering resumed |
| A cycle couldn't be confirmed (counted as delivered) | warning | ❓ Couldn't confirm cycle … |
| **Moisture** | | |
| A sensor below the zone's `criticalLowPct` (default threshold − 10) | critical | 🏜️ Critically dry |
| A sensor above `criticalHighPct` (default target + 20): leak, stuck valve, storm | critical | 🌊 Waterlogged |
| Back inside the limits (2 points of hysteresis) | info | 👍 Moisture back to normal |
| A zone used its whole daily allowance and is still below its threshold | warning | ⏱️ … is still dry after its full daily allowance (broken valve? clogged nozzle? misplaced sensor?) |
| **Devices** | | |
| Sensor or B-hyve timer battery ≤ `lowBatteryPct` (default 20%) | warning | 🪫 Low battery |
| Battery replaced (≥ low + 10%) | info | 🔋 Battery OK |
| A zone has no usable sensor data (offline, stale) | warning | 📵 No sensor data … not watered until readings return |
| Sensor data back | info | 📶 Sensor data back |
| B-hyve controller offline / back online | critical / info | 📴 … is offline / 📶 … back online |
| **Connections** (only if still down after `connectionGraceMinutes`, default 5) | | |
| Tuya, B-hyve cloud, or B-hyve command connection unreachable | critical | 🔴 … unreachable since …, with impact and error |
| Weather forecast unreachable | warning | 🔴 … (watering falls back to fixed run lengths) |
| Reachable again | info | 🟢 … reachable again after … |
| **The conductor itself** | | |
| Started / stopped | info | ▶️ / ⏹️ |
| Restarted after a crash or power loss | critical | 💥 …, with its last activity |
| Monitoring got stuck (watchdog) | critical | ⏳ Monitoring got stuck and was restarted |
| State file can't be written | critical | 💾 Can't save state |

### Keeping it quiet

- **Transitions only.** A low battery is reported once, not on every poll. It's reported again
  only after a real recovery (≥ 10 points above the low level).
- **Conditions survive restarts.** Open alerts are saved in the state file, so a restart doesn't
  repeat them.
- **Grace period for connections.** A blip that heals within `connectionGraceMinutes` produces
  no messages at all.
- **No duplicates.** During a Tuya outage, the per-zone "no sensor data" messages are folded into
  the one Tuya message. After a crash, the crash message replaces "started".
- **Bursts are combined.** Several alerts at once (e.g. a storm flooding three sensors) arrive as
  one message. Delivery is paced to stay within Telegram's limits.
- **Routine plumbing stays in the audit.** Sends, confirmations and retries aren't notified.
- **`minSeverity`** (`info`, `warning`, `critical`) sets the least severe message sent.

### If Telegram is down

Notifications never block or delay watering. Failed sends are retried after 5 s, 30 s, 2 min and 10 min.
Telegram's "retry after" is honoured, and messages Telegram will never accept (bad token or chat) are not
retried. At most 100 messages wait in the queue. Anything dropped is recorded in the audit file as
`notification.failed` (`npm run audit -- --type notification`). At shutdown, pending messages get up
to 10 s to go out.

## Settings (`conductor.json`)

```json
"notifications": {
  "minSeverity": "info",
  "cycles": false,
  "connectionGraceMinutes": 5,
  "timeZone": "America/Chicago"
},
"alerts": {
  "lowBatteryPct": 20,
  "deviceCheckMinutes": 60
}
```

- `deviceCheckMinutes`: how often the B-hyve controllers are checked for connectivity and battery
  when nothing needs water (0 = only when watering).
- Per zone, or in `defaults`: `criticalLowPct` and `criticalHighPct`. Low must be below the
  threshold; high must be above the target.
- `timeZone` is used for times in messages (default: this machine's).

## Simulations

`npm run simulate` plays realistic scenarios against the real conductor code (monitor, cycle-and-soak,
recovery, alerts, notifications) with a simulated garden and fake cloud services, in virtual time. A
simulated day takes a fraction of a second. Each run prints the audit trail, the Telegram messages (at
the time they would be sent), a summary, and a checklist of what to look for.

```bash
npm run simulate -- --list                      # the scenarios
npm run simulate -- bhyve-socket-outage          # one scenario, in full
npm run simulate -- crash-mid-soak tuya-outage   # several
npm run simulate -- --all                        # all of them, plus a summary table
npm run simulate -- --all --quiet                # just the summary table
npm run simulate -- low-batteries --telegram     # also send its messages to your chat, to preview them
```

| Scenario | What happens |
|---|---|
| `normal-watering` | A dry morning: 3 cycles with soaks |
| `rain-forecast` | Dry, but rain is forecast soon: it waits, and the rain comes |
| `bhyve-socket-outage` | The command connection drops during a soak; retries until it's back |
| `bhyve-long-outage` | B-hyve down for 2½ h: the sequence is abandoned, then re-watered after the cooldown |
| `tuya-outage` | No sensor data for 3 h: no watering until it's back |
| `crash-mid-soak` | Killed between cycles, restarted: resumes on schedule |
| `owner-switches-off` | You switch the controller off mid-soak: it stops |
| `command-lost` | A command never arrives: re-sent only once it's certain it didn't start |
| `unconfirmed-command` | Delivery can't be determined: counted as delivered, never sent twice |
| `low-batteries` | Sensor and hose-timer batteries run low and are replaced |
| `critical-moisture` | Critically dry during a rain delay, then waterlogged by a storm |
| `controller-offline` | The controller loses Wi-Fi for 2 h |
| `broken-valve` | Watering runs but no water arrives: flagged after the daily allowance |
| `sensor-dies` | A sensor's battery dies and it goes quiet |
| `monitoring-stuck` | A request hangs forever: the watchdog recovers |

Each scenario's trail is saved to `simulations/<scenario>.audit.jsonl` (and its messages to
`simulations/<scenario>.notifications.jsonl`), so all the audit commands work on it:

```bash
npm run audit -- --file simulations/bhyve-long-outage.audit.jsonl --since 2026-01-01 --summary
npm run audit -- --file simulations/bhyve-long-outage.audit.jsonl --since 2026-01-01 --recovery
```

(Simulated days are in 2026, so pass `--since`; the default is the last 24 hours.) The same
scenarios run as automated tests (`src/test/sim/scenarios.test.ts`). They also check that no cycle
is ever delivered twice, that every watering ends, and that no notification is sent before its event.
