# Telegram commands

With commands on, the Telegram chat that gets the [notifications](notifications.md) can also ask the
running conductor questions:

| Command | Like | What you get |
|---|---|---|
| `/status` | | Running since when, last and next poll, each zone's latest decision and soil %, watering in progress, unreachable services, open alerts |
| `/sensors_read` | `npm run sensors:read` | A fresh reading of every sensor in `conductor.json`: moisture, temperature, battery, online, age, and which zone it's in |
| `/bhyve_devices` | `npm run bhyve:devices` | Each B-hyve controller: connected, battery, mode, rain delay, watering now, zones |
| `/help` (or `/start`) | | The list above |

**All commands are read-only.** None of them can start, stop or delay watering, or change anything on
a controller or in the conductor. That is enforced in the code, not just by convention: the commands only
get a B-hyve object with `getDevices` on it (see `src/bot/commands.ts`). `npm run bhyve:cmd` is
deliberately not available from Telegram.

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
- **Accountability.** Every command that ran is in the audit trail, with who sent it and how it went:
  `npm run audit -- --type command`.

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
