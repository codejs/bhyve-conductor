# Web app

Status: the read-only **web API** is in place; the single-page web app that uses it comes next and will be
served by the same process. The API answers what `npm run audit -- --for-simulation` shows (the
simulations stored with `npm run simulate -- --store`) as JSON.

## Running it

```sh
npm run simulate -- --all --store     # something to look at (see notifications.md#simulations)
npm run web                           # http://127.0.0.1:8787/api, reading CONDUCTOR_DB
npm run web -- --db other.db --port 9000
```

`npm run web` runs in its own process, next to the conductor: a problem in it never affects watering. It
opens the database **read-only** (like `npm run audit`), so it can run while the service writes. The
database must exist (the conductor creates it at its first start, or `npm run db:migrate`). Stop it with
Ctrl+C or SIGTERM.

| Setting | Option | Default | Meaning |
| --- | --- | --- | --- |
| `CONDUCTOR_DB` | `--db <path>` | `.conductor.db` | The database to read |
| `WEB_HOST` | `--host <addr>` | `127.0.0.1` | Where it listens. `127.0.0.1`: this machine only; `0.0.0.0`: every network interface |
| `WEB_PORT` | `--port <n>` | `8787` | The port |
| `WEB_ALLOWED_HOSTS` | | (none) | More host names browsers may use to reach it, comma-separated, e.g. `garden-pi.local` |

### From another machine

The API has **no login**: anyone who can reach it can read the audit trail. To use it from another
machine on a network you trust:

```sh
WEB_HOST=0.0.0.0 WEB_ALLOWED_HOSTS=garden-pi.local,192.168.1.20 npm run web
```

It then warns at startup, and answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]`, the
address it listens on (unless `0.0.0.0`) and the names in `WEB_ALLOWED_HOSTS`. Everything else gets
`403 host not allowed` (see [Security](#security)). Use the name exactly as you type it in the browser.

## Endpoints

All are `GET` (and `HEAD`). Times in answers are ISO 8601 in UTC; simulated times are virtual (the
simulated summer day), and each simulation has the `timeZone` of its garden for showing them. The types
of every answer are in [`src/http/contract.ts`](../src/http/contract.ts).

| Path | Parameters | Answer |
| --- | --- | --- |
| `/api/simulations` | none | `{ simulations: SimulationDto[], available }`, by scenario id. `available` is false when the database predates stored simulations. |
| `/api/simulations/:scenario` | none | `{ simulation: SimulationDto }`: when it was simulated and stored, event/notification counts, `recoveryEvents` (the `!` of `npm run audit`), the scenario's `story` and `lookFor` |
| `/api/simulations/:scenario/events` | `since`, `until`, `types`, `device`, `zone`, `sequence`, `recovery` | `{ scenario, timeZone, events, total }`: the matching events as recorded (`{ ts, type, ...data }`, as `npm run audit -- --json`), and how many the simulation has |
| `/api/simulations/:scenario/summary` | `since`, `until` | `{ scenario, timeZone, summary }`: connection outages, the fate of each watering sequence, unclean shutdowns (as `--summary`) |
| `/api/simulations/:scenario/notifications` | none | `{ scenario, timeZone, notifications }`: the Telegram messages it would have sent, in order |

The parameters mean what the options of `npm run audit` mean:

| Parameter | Example | Picks |
| --- | --- | --- |
| `since`, `until` | `2026-07-01T06:30-05:00`, `2026-07-01T11:30Z`, `2026-07-01`, `24h`, `90m`, `7d`, `2w` | Events in the window (inclusive). A duration counts back from now, which for simulations is after the simulated day. Encode `+` in an offset as `%2B`. |
| `types` | `wave,sequence.abandoned` | Event types or their prefixes, comma-separated (at most 30) |
| `device` | `timer-1` | One B-hyve controller |
| `zone` | `timer-1:2` | One zone, `<deviceId>:<station>` |
| `sequence` | `86da5fd5` | One watering sequence: its id or its first characters |
| `recovery` | `true` | Only failures and recoveries |

One difference from the command line: the **summary always reads every event of the window**. A sequence's
outcome depends on its `sequence.started`, which `--summary --recovery` filters out (so the command shows
no sequences); the API doesn't take filters on the summary.

```sh
curl -s 'http://127.0.0.1:8787/api/simulations/bhyve-long-outage/events?recovery=true&types=wave,sequence'
curl -s 'http://127.0.0.1:8787/api/simulations/crash-mid-soak/summary'
```

### Errors

Every error is JSON, `{ "error": "...", "issues": [...] }`, with nothing from inside the service (no stack
traces, paths or SQL; those go to the service log):

| Status | When |
| --- | --- |
| `400 invalid request` | A parameter is malformed, unknown, repeated or not for this path. `issues` lists each `{ parameter, message }`. Unknown parameters are refused so a typo never silently shows everything. |
| `403 host not allowed` | The request was addressed to a host name it doesn't answer to |
| `404` | No such path, or no stored simulation of that scenario |
| `405 method not allowed` | Anything but `GET`/`HEAD` (`Allow: GET, HEAD`) |
| `500 internal error` | Something failed inside; see the log |

## Security

The web API sits next to the garden's history and has no login, so it is built to be safe to leave running
on a home network:

- **Read-only.** The database is opened read-only, and only `GET`/`HEAD` exist; every other method is
  refused before anything else runs.
- **This machine only, by default.** Listening elsewhere is a setting, and logs a warning.
- **DNS rebinding.** A web page you visit could point its own domain at `127.0.0.1` and read the API from
  your browser. Such requests carry that domain in their `Host` header, so any host name not on the list
  above is refused (`403`) before anything is read.
- **No cross-origin access.** No CORS headers: other sites' pages can't read the answers.
- **Strict parameters.** Each parameter has an anchored, bounded pattern (no wildcards, quotes, control
  characters or path separators) and is checked before the database is touched. Impossible dates such as
  February 31 or `T24:00` are refused rather than rolled over to another day.
- **Response headers** on every answer, errors included: `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`.
  Stored text (event data, Telegram HTML) is returned as JSON data, never as markup.
- **Timeouts.** Request headers must arrive within 10 s and a whole request within 30 s.

Not covered, and needed before exposing it beyond a trusted network or before the web app can change
anything: authentication, TLS (put a reverse proxy in front), rate limiting.

## Code

| File | What |
| --- | --- |
| [`src/http/app.ts`](../src/http/app.ts) | The Hono app: middleware, parameter validation, endpoints (`createApp`, `type Api` for the typed client) |
| [`src/http/contract.ts`](../src/http/contract.ts) | The answers' types, without Node imports, shared with the web app |
| [`src/http/hosts.ts`](../src/http/hosts.ts) | The host names it answers to |
| [`src/http/server.ts`](../src/http/server.ts) | The Node server: read-only database, limits, start and stop |
| [`src/http/command.ts`](../src/http/command.ts), [`src/scripts/web.ts`](../src/scripts/web.ts) | `npm run web` |

Tests: `src/test/http/`. `api.test.ts` checks each endpoint gives what `npm run audit` gives for the same
stored simulations; `security.test.ts` the checks above, in process; `server.test.ts` the same over real
sockets (Host headers as they arrive, read-only file, start and stop); `contract.test.ts` that the files
shared with the web app stay free of Node.
