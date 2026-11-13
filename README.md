# bhyve-conductor

Waters your lawn when the soil actually needs it.

bhyve-conductor reads soil-moisture sensors and, when a zone gets too dry, starts a short
supplemental run on your Orbit B-hyve sprinkler controller. Your regular B-hyve schedule stays as it
is; the conductor only adds water on top when the sensors say the schedule isn't enough.

## What it does

- **Watches the soil.** Polls Tuya soil-moisture sensors (every 15 minutes by default) and maps each
  sensor to a B-hyve zone.
- **Waters dry zones.** When a zone drops below its threshold, it starts a manual B-hyve run,
  split into cycle-and-soak runs so the water soaks in instead of running off.
- **Checks the forecast first** (optional). With a location set, it uses the
  [Open-Meteo](https://open-meteo.com) forecast (rain and evapotranspiration) and your upcoming
  B-hyve programs to work out how much water a zone needs. If rain or a scheduled run will cover it,
  it waits.
- **Stays on the safe side.** Stale or offline sensors never trigger watering. Cooldowns and daily
  caps stop it from overwatering, even across restarts. It respects rain delays and controllers that
  are switched off.
- **Tells you what happened.** Every watering and connection event goes to an audit trail you can
  review with `npm run audit`. Alerts (low batteries, critically dry or wet soil, controller offline)
  can be sent to Telegram.

## Who it's for

Homeowners and hobbyists who already have:

- an **Orbit B-hyve** Wi-Fi sprinkler controller, and
- one or more **Tuya / Smart Life soil-moisture sensors**,

and are comfortable editing a JSON file and running a Node.js process on an always-on machine
(a Raspberry Pi, home server or NAS).

> B-hyve has no official public API. This project uses the same endpoints as the B-hyve app, which
> could change without notice.

## Built with

- [TypeScript](https://www.typescriptlang.org/) on [Node.js](https://nodejs.org/) 26 (ES modules)
- [Zod](https://zod.dev/) for validating config, environment and API responses
- [tsx](https://tsx.is/) to run TypeScript directly in development
- [Vitest](https://vitest.dev/) for tests
- External services: B-hyve cloud (REST + WebSocket), [Tuya IoT Platform](https://platform.tuya.com)
  OpenAPI, Open-Meteo forecast and geocoding (free, no API key), Telegram Bot API (optional)

## Getting started

### Prerequisites

- Node.js 26 (the exact version is in `.node-version`) and npm
- Your B-hyve app login
- A Tuya IoT Platform cloud project with your Smart Life account linked to it, to get API access to
  the sensors

### 1. Install

```sh
npm install
```

### 2. Set credentials

```sh
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BHYVE_EMAIL`, `BHYVE_PASSWORD` | yes | Your B-hyve app login |
| `TUYA_CLIENT_ID`, `TUYA_CLIENT_SECRET` | yes | From your Tuya cloud project's Overview page |
| `TUYA_BASE_URL` | yes | Your Tuya data center (default `https://openapi.tuyaus.com`) |
| `TUYA_MOISTURE_CODE` | no | Data point holding moisture % (default `humidity`) |
| `LOCATION` | no | Enables forecast-based watering: `lat,lon`, a US ZIP, `City, ST` or a place name |
| `CONDUCTOR_CONFIG` | no | Zone config file (default `conductor.json`) |
| `CONDUCTOR_STATE` | no | Watering history file (default `.conductor-state.json`) |
| `CONDUCTOR_AUDIT` | no | Audit trail file (default `.conductor-audit.jsonl`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Telegram alerts; see [docs/notifications.md](docs/notifications.md) |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn` or `error` |

### 3. Find your devices

```sh
npm run bhyve:devices    # B-hyve controllers, their ids and zone (station) numbers
npm run tuya:devices     # Tuya sensors, their ids and data-point codes
npm run sensors:read     # current readings from the sensors in TUYA_SOIL_SENSOR_IDS
```

### 4. Map sensors to zones

```sh
cp conductor.example.json conductor.json
```

For each zone, set the B-hyve `deviceId` and `station`, and the Tuya `sensorIds` in that zone. Rules
in `defaults` apply to every zone, and any zone can override them. The main ones:

| Setting | Meaning |
| --- | --- |
| `thresholdPct` | Water when the soil reads below this moisture % |
| `targetPct` | Refill level; supplemental watering never goes above it |
| `runMinutes` | Run length when no forecast is used |
| `maxMinutesPerDay`, `cooldownMinutes` | Limits on supplemental watering per zone |
| `maxCycleMinutes`, `soakMinutes` | Cycle-and-soak: longest single run and the pause between runs |
| `sensorAggregation` | How a zone with several sensors decides: `driest`, `average` or `median` |
| `precipRateInPerHour` | How fast the zone's sprinklers apply water; required when `LOCATION` is set. Measure it with a catch-cup test (spray heads ≈ 1.5, rotors ≈ 0.5) |

If `LOCATION` is set, check what the forecast and your B-hyve schedule look like to the conductor:

```sh
npm run weather:forecast
```

### 5. Try it without watering

```sh
npm run conductor:check          # one dry-run cycle, then exit
npm run dev -- --dry-run         # keep running, log decisions, send nothing
```

### 6. Run it

```sh
npm run build
npm start
```

Keep it running with whatever you use for long-lived processes (systemd, pm2, Docker, ...). Stop it
with Ctrl+C or SIGTERM; it finishes the current cycle before exiting.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the conductor from the built `dist/` (run `npm run build` first) |
| `npm run dev` | Run from source and restart on file changes |
| `npm run conductor:check` | One dry-run cycle, then exit |
| `npm run build` / `npm run clean` | Compile to `dist/` / delete it |
| `npm run bhyve:devices` | List B-hyve controllers and zones (`-- --json` for raw output) |
| `npm run bhyve:watch` | Print live B-hyve events |
| `npm run bhyve:cmd -- start <deviceId> <station> <minutes>` | Start a manual run (also `stop <deviceId>`, `delay <deviceId> <hours>`) |
| `npm run tuya:devices` | List Tuya devices and their data points (`-- --json` for raw output) |
| `npm run sensors:read` | Read the soil sensors once |
| `npm run weather:forecast` | Show the forecast and upcoming B-hyve runs the water budget uses |
| `npm run audit` | Review the audit trail (`audit:summary`, `audit:recovery`; filters such as `-- --since 7d` or `-- --zone <deviceId>:2` are listed at the top of `src/scripts/audit.ts`) |
| `npm run notify:test` | Send a test Telegram message |
| `npm run simulate -- --list` | List simulated scenarios (outages, storms, dead batteries, ...); `-- --all` runs them |
| `npm test` / `npm run test:watch` / `npm run test:coverage` | Run the tests |
| `npm run typecheck` | Type-check without building |
| `npm run archive` | Zip the project, without `node_modules`, `.git` or `.env` |

## More documentation

- [docs/disaster-recovery.md](docs/disaster-recovery.md): what happens when a service fails mid-watering, and how to review it
- [docs/notifications.md](docs/notifications.md): Telegram setup and simulations

## TODO

Next items, roughly four days of work each, in priority order:

- [ ] **Watering amounts that match the hardware:** daily cap in inches, skip Smart Watering programs in the expected water, whole-minute runs, no runs just before a scheduled program.
- [ ] **Sensor calibration and trust:** per-sensor calibration with a `sensors:calibrate` helper; flag sensors that disagree with their zone or jump without rain or watering.
- [ ] **Shadow mode:** dry runs that keep history, persisted dry-spell tracking, and a daily report of what the conductor would have added.
- [ ] **Unattended deployment:** Dockerfile and systemd unit, a `doctor` config check, audit and state file rotation, a health endpoint and a heartbeat alert.
- [ ] **Water-use reporting:** per-zone daily and weekly totals (minutes, inches, gallons, moisture), an `npm run report` command and a weekly Telegram digest.

## License

See [LICENSE](LICENSE).
