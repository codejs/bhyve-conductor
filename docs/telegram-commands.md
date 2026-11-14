# Telegram commands

With commands on, the Telegram chat that gets the [notifications](notifications.md) can also ask the
running conductor questions:

| Command | Like | What you get |
|---|---|---|
| `/status` | | Running since when, last and next poll, each zone's latest decision and soil %, watering in progress, unreachable services, open alerts |
| `/sensors_read` | `npm run sensors:read` | A fresh reading of every sensor in `conductor.json`: moisture, temperature, battery, online, age, and which zone it's in |
| `/bhyve_devices` | `npm run bhyve:devices` | Each B-hyve controller: connected, battery, mode, rain delay, watering now, zones |
| `/help` (or `/start`) | | The list above |

With a [passphrase](#pausing-and-resuming) set, the chat can also change one thing:

| Command | What it does |
|---|---|
| `/pause` | Pauses automatic (supplemental) watering, until `/resume` |
| `/resume` | Resumes it, continuing or cancelling any watering that the pause put on hold |
| `/cancel` | Cancels a `/pause` or `/resume` that is waiting for your answer |

**The commands above are read-only.** None of them can start, stop or delay watering, or change
anything on a controller or in the conductor. That is enforced in the code, not just by convention: they
only get a B-hyve object with `getDevices` on it (see `src/bot/commands.ts`). `/pause` and `/resume`
only switch the conductor's own automatic watering off and on; they never send anything to B-hyve
themselves. `npm run bhyve:cmd` is deliberately not available from Telegram.

## Setup

1. Set up [notifications](notifications.md) first (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and
   check them with `npm run notify:test`). Commands need a numeric chat id: a private chat with the
   bot, or a group. Channels can't send commands.
2. Turn commands on in `.env`:
   ```
   TELEGRAM_COMMANDS=on
   ```
3. **In a group**, also list who may send commands (required, because anyone who joins the group could
   otherwise send them):
   ```
   TELEGRAM_COMMAND_USER_IDS=123456789,987654321
   ```
   To find a user id, have that person send a message to the bot (or in the group), stop the
   conductor, and open `https://api.telegram.org/bot<token>/getUpdates`. The id is in
   `"from":{"id": …}`. Stop the conductor first: only one program at a time can read the bot's
   messages.

   In a private chat, only you can send there, so the user id is optional. If you do set it, it
   must include your own id (the chat id).
4. Restart the conductor. The log says `Telegram commands on for @YourBot`, and the commands
   appear in the chat's `/` menu.

The conductor validates these settings at startup and refuses to start with a setup that is unsafe
or can't work. Examples: a group without `TELEGRAM_COMMAND_USER_IDS`, a `@channel`, or a malformed
id.

Commands are only answered by the long-running service (`npm start`, `npm run dev`). They are not
answered with `--dry-run`, `--once` or `npm run conductor:check`, so a test run never takes your
messages away from the real service.

## Pausing and resuming

### Turning it on

Set a passphrase in `.env`, **in quotes** (an unquoted `#` starts a comment and silently cuts it
short):

```
TELEGRAM_COMMAND_PASSPHRASE="correct horse battery staple"
```

It must be at least 8 characters, must not start or end with a space or start with `/`, and must not
be one of the answer words (`yes`, `cancel`, `continue`, …). The conductor refuses to start otherwise.
Without a passphrase, `/pause` and `/resume` don't exist.

### What a pause does

- **No new supplemental watering** starts. Zones that need water show as `paused` in `/status`.
- **Watering in progress is put on hold**: its remaining cycles aren't sent.
- **Water that is already on is not turned off.** A cycle that has started runs its course (at most
  `maxCycleMinutes`). To stop it immediately, use the B-hyve app.
- **Sensors are still read and alerts still sent** (critically dry, waterlogged, low battery, offline).
  A pause is often the moment those matter most.
- **Your regular B-hyve schedule is not affected**; the conductor never controlled it.
- **It survives restarts.** The pause is saved in the state file. After a restart you get
  "⏸️ Restarted while paused", and `/status` shows it.

### The conversations

Every change ends with the passphrase, and nothing changes before it:

```
/pause    nothing watering      → 🔐 passphrase                              → ⏸️ Paused
          watering in progress  → ⚠️ "Pause anyway?"  yes → 🔐 passphrase    → ⏸️ Paused

/resume   nothing on hold       → 🔐 passphrase                              → ▶️ Resumed
          watering on hold      → continue | discard  → 🔐 passphrase        → ▶️ Resumed
          on hold, too old      → "it will be cancelled; resume?"  yes → 🔐  → ▶️ Resumed
```

- **continue** carries on with the held watering where it stopped; **discard** cancels it. Either
  way the zones are re-checked against their sensors right away.
- Held watering can only be continued if its next cycle was due at most `resumeWindowMinutes`
  ago (default 60, the same rule as after a restart). Older plans are stale: it may have rained, so
  they are cancelled, and the zones are re-checked.
- While paused, `/pause` just says it's already paused; when not paused, `/resume` says there's
  nothing to resume. Neither asks for the passphrase.

### Answers

| You send | At a question | At the passphrase |
|---|---|---|
| `yes`, `y`, `ok`, `confirm` (any case, `!`/`.` allowed) | confirms | asked again (it's not the passphrase) |
| `continue` / `1`, `discard` / `2` | picks that option (`/resume`) | asked again |
| `cancel`, `no`, `stop`, `abort`, or `/cancel` | cancels, nothing changes | cancels, nothing changes |
| the passphrase | deleted, and you're asked to answer the question first | **runs the change** |
| anything else | asked again; after 3 unexpected answers the command is dropped | **wrong passphrase**: not run, and the command ends |
| nothing for 2 minutes | dropped, nothing changes | dropped, nothing changes |

- A wrong passphrase ends the command; send it again to retry. **3 wrong passphrases within 15
  minutes lock `/pause` and `/resume` for 15 minutes** (read-only commands keep working).
- Answering "yes" after a question has expired tells you it expired; nothing happens.
- Read-only commands (`/status`, …) can be used while a question is waiting; it keeps waiting.
  Starting another change replaces yours.
- In a group, only the person who sent the command can answer it. Anyone else trying a change waits
  until it's done. The bot's questions open the reply box for that person, which also lets the bot
  see the answer with group privacy mode on.

### The passphrase in the chat

The bot deletes every message that contains the passphrase: your answer, and also one sent
by mistake (too early, with the command, after the question expired, or by someone else). It tells
you when it did. In a private chat that always works. **In a group the bot needs to be an admin with
the "Delete messages" right**, otherwise it asks you to delete the message yourself. The passphrase is
never logged, audited or repeated back.

The passphrase is a second factor on top of the allowlist. It protects against someone who gets
hold of an allowed person's unlocked phone or Telegram session, or is added to the group. Use one
you don't use anywhere else, and change it (and restart) if it's ever exposed.

## Security

Commands make the conductor act on incoming messages, so they are off by default and locked down:

- **No open port.** The conductor asks Telegram for new messages (long polling). It never listens for
  incoming connections, and there's no webhook URL to discover or spoof. Only ordinary messages are
  requested; edits, reactions and button presses are never received.
- **One chat, named people.** A command counts only if it was sent in `TELEGRAM_CHAT_ID`, by a
  user in the allowlist. Anything else is ignored, including commands from the right person that
  are:
  - sent in another chat;
  - forwarded (someone else wrote them);
  - sent via an inline bot;
  - sent by a bot;
  - sent as an anonymous group admin or on behalf of a channel.
- **Strangers learn nothing.** Rejected commands get no reply at all. The attempt is written to the
  audit trail (`command.rejected`), and when it came from someone who isn't allowed, you get a 🚫
  warning. A persistent sender is reported at most once an hour, and at most 20 rejections are
  recorded per hour in total, so a flood can neither spam you nor fill the disk.
- **No stale or replayed commands.** Messages older than 2 minutes are ignored, for example ones sent
  while the conductor was down. Each message is handled at most once.
- **Changes need the passphrase.** `/pause` and `/resume` always end with the passphrase, may ask
  to confirm first, drop out on no answer or too many unexpected answers, and lock after repeated wrong
  passphrases (see [Pausing and resuming](#pausing-and-resuming)).
- **Exact commands only.** Text must be exactly one of the commands above. Arguments are refused, not
  ignored, and `/command@OtherBot` is left to that bot. Anything the APIs return (device and sensor
  names, errors) is escaped before it is shown.
- **Limits.** At most 10 commands a minute; beyond that you get one "too many commands" notice. The
  commands that call cloud APIs (`/sensors_read`, `/bhyve_devices`) run at most once every 30
  seconds. This protects your Tuya API quota and the B-hyve account the watering depends on. Each
  command times out after 45 s, and they run one at a time.
- **Watering comes first.** The command bot runs beside the monitor and can't block or break it.
  Failures are reported in the chat and logged. A rejected or revoked bot token (401) turns commands
  off until the next restart instead of retrying forever. `/sensors_read` uses its own sensor reader,
  so its reads never mix with the monitor's.
- **Accountability.** Every command is in the audit trail, with who sent it and how it went
  (for changes also `cancelled`, `expired`, `denied`, `locked`…):
  `npm run audit -- --type command`. Pauses and resumes are `conductor.paused` / `conductor.resumed`
  (`npm run audit -- --type conductor`), and wrong passphrases are `command.auth_failed`.

Anyone who can post as an allowed user can read your lawn's status. Keep the bot token secret. If it
leaks, revoke it with @BotFather (`/revoke`) and update `.env`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No answer at all | Check the log. `rejected a command (other-chat)`: the message came from a different chat than `TELEGRAM_CHAT_ID`. `(user-not-allowed)`: add the user to `TELEGRAM_COMMAND_USER_IDS`. Nothing logged: commands are off, or this is a dry run / `--once`. |
| `409 Conflict … (is another conductor running with this bot token, or a webhook set?)` | Two programs are reading the same bot's messages, or the bot has a webhook. Stop the other one, or remove the webhook with `https://api.telegram.org/bot<token>/deleteWebhook`. The conductor retries every minute. |
| `Telegram commands are off until restart: … 401` | The token was revoked or is wrong. Fix `.env` and restart. |
| In a group, the bot doesn't see commands | With privacy mode on (the default), bots in groups only receive messages starting with `/`, which is all the commands need. If still nothing, check that the bot is a member of the group. |
| `⏳ … can run again in …` | The 30-second cooldown on cloud-API commands. |
| `/pause` or `/resume` is "Unknown command" | No `TELEGRAM_COMMAND_PASSPHRASE` is set. |
| The right passphrase is "wrong" | Check the `.env` line is quoted: an unquoted `#` cuts the value short. |
| In a group, answers are ignored | Answer using Telegram's *Reply* on the bot's question (the reply box opens by itself), and from the same account that sent the command. |
| `🔒 Changes are locked …` | Too many wrong passphrases; wait, or restart the conductor to clear the lock. |
