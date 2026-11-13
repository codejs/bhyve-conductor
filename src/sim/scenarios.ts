import type { Scenario } from './runner.ts';

/**
 * The simulated garden (see runner.ts): "Lawn timer" (timer-1) waters Front lawn (station 1, sensors
 * front-a + front-b, averaged) and Back lawn (station 2, back-a). Threshold 30%, target 40%, critical
 * limits 20% / 60%. A dry zone gets 24 min as 3 cycles of 8 min with 20 min soaks; cooldown 4 h, at most
 * 48 min a day. Soil dries 0.4%/h; a minute of watering adds ~0.4%. Day starts 06:00 Chicago time.
 */

const dryFront = (w: Parameters<Scenario['setup']>[0]) => {
  w.sensor('front-a').moisture = 26;
  w.sensor('front-b').moisture = 28;
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'normal-watering',
    title: 'A normal dry morning',
    story: 'Front lawn is dry at 06:00 (27% average). It gets 24 min in 3 cycles with soaks, then rests.',
    lookFor: [
      'zone.decision Front lawn → dry, then soaking, then cooldown',
      'sequence.started → 3 × wave.sent/confirmed → sequence.completed → sequence.finished (water off ~07:04)',
      'Telegram: "Watering started" and "Watering finished" only (no per-cycle noise)',
    ],
    hours: 4,
    setup: dryFront,
    timeline: [],
  },
  {
    id: 'rain-forecast',
    title: 'Dry, but rain is forecast within the wait window',
    story:
      'Front lawn is slightly dry (29%) and the forecast has 8 mm of rain at 08:00. The conductor waits instead of ' +
      'watering; the rain comes and the zone recovers. (Uses the weather forecast for amounts.)',
    lookFor: [
      'zone.decision Front lawn → forecast-covered ("no water now: rain/scheduled watering restores the threshold within …")',
      'no sequence.started at all',
      'after the rain: zone.decision Front lawn → moist',
    ],
    hours: 4,
    weather: true,
    setup: (w) => {
      w.sensor('front-a').moisture = 28.5;
      w.sensor('front-b').moisture = 29.5;
      w.forecastRain.push({ at: Date.parse('2026-07-01T13:00:00Z'), mm: 8, chancePct: 90 });
    },
    timeline: [{ at: 120, note: 'It rains (8 mm)', run: ({ world }) => world.rain(6) }],
  },
  {
    id: 'bhyve-socket-outage',
    title: 'B-hyve connection drops during a soak, comes back 35 min later',
    story: 'Front lawn starts 3 cycles at 06:00. At 06:10 the B-hyve command socket goes down; it returns at 06:45.',
    lookFor: [
      'wave.send_failed for cycle 2 at 06:28, then wave.retry_scheduled 1 → 2 → 5 → 10 min',
      'connection.lost (bhyve-commands) → connection.restored, with the outage length',
      'cycle 2 delivered after the connection returns; sequence.completed, nothing sent twice',
      'Telegram: connection lost (after the 5-min grace), restored, watering started/finished',
    ],
    hours: 3,
    setup: dryFront,
    timeline: [
      { at: 10, note: 'B-hyve command socket goes down', run: ({ world }) => void (world.services.bhyveSocket = 'down') },
      { at: 45, note: 'B-hyve command socket is back', run: ({ world }) => void (world.services.bhyveSocket = 'up') },
    ],
  },
  {
    id: 'bhyve-long-outage',
    title: 'B-hyve unreachable for 2½ hours mid-sequence',
    story:
      'Front lawn (26%) starts 3 cycles at 06:00. B-hyve goes down at 06:10 until 08:40. Cycle 2 is retried for 30 min, ' +
      'then the rest is abandoned. After the cooldown the zone, still dry, is watered again.',
    lookFor: [
      'retries for cycle 2 until 06:58, then sequence.abandoned "gave up on cycle 2/3 after … attempt(s)"',
      'connection.lost → connection.restored (~150 min)',
      'a new sequence for Front lawn at ~10:00 (after the 4 h cooldown)',
      'Telegram: "Watering stopped early" (critical), connection lost/restored',
    ],
    hours: 6,
    setup: (w) => {
      w.sensor('front-a').moisture = 25;
      w.sensor('front-b').moisture = 27;
    },
    timeline: [
      {
        at: 10,
        note: 'B-hyve goes down (REST and commands)',
        run: ({ world }) => {
          world.services.bhyveSocket = 'down';
          world.services.bhyveRest = 'down';
        },
      },
      {
        at: 160,
        note: 'B-hyve is back',
        run: ({ world }) => {
          world.services.bhyveSocket = 'up';
          world.services.bhyveRest = 'up';
        },
      },
    ],
  },
  {
    id: 'tuya-outage',
    title: 'Tuya cloud down for 3 hours',
    story: 'Front lawn is dry, but Tuya is down from 06:00 to 09:00: without sensor data nothing is watered. It waters once data returns.',
    lookFor: [
      'connection.lost (tuya) and zone.no_data for both zones; no watering during the outage',
      'connection.restored (tuya, ~180 min), zone.data_restored, then sequence.started',
      'Telegram: one Tuya outage message (the per-zone "no data" messages are folded into it), restored, watering',
    ],
    hours: 5,
    setup: (w) => {
      dryFront(w);
      w.services.tuya = 'down';
    },
    timeline: [{ at: 180, note: 'Tuya is back', run: ({ world }) => void (world.services.tuya = 'up') }],
  },
  {
    id: 'crash-mid-soak',
    title: 'Conductor crashes during a soak and restarts',
    story: 'Front lawn starts 3 cycles at 06:00. The conductor is killed at 06:35 (between cycles 2 and 3) and restarted at 06:50.',
    lookFor: [
      'service.unclean_shutdown then sequence.resumed at cycle 3/3',
      'cycle 3 sent on its original schedule (06:56); sequence.completed; 24 min in total, nothing twice',
      'Telegram: "restarted after a crash" (critical), "Watering resumed", "Watering finished"',
    ],
    hours: 3,
    setup: dryFront,
    timeline: [
      { at: 35, note: 'The conductor process is killed (kill -9 / power loss)', run: (c) => c.crash() },
      { at: 50, note: 'The conductor is restarted', run: (c) => c.restart() },
    ],
  },
  {
    id: 'owner-switches-off',
    title: 'The owner switches the controller off during a soak',
    story: 'Front lawn starts 3 cycles at 06:00. At 06:20 the owner turns the B-hyve controller off in the app; back on at 07:30.',
    lookFor: [
      'sequence.abandoned "the device was switched off" before cycle 2 — nothing more is sent',
      'no new watering while it is off: Front lawn is in its cooldown (device-off would show for a zone that needs water)',
      'Telegram: "Watering stopped early" as a warning (not critical)',
    ],
    hours: 3,
    setup: dryFront,
    timeline: [
      { at: 20, note: 'Owner switches the controller off', run: ({ world }) => void (world.device('timer-1').runMode = 'off') },
      { at: 90, note: 'Owner switches the controller back on', run: ({ world }) => void (world.device('timer-1').runMode = 'auto') },
    ],
  },
  {
    id: 'command-lost',
    title: 'A watering command is lost on the way to the controller',
    story: 'The first command at 06:00 never reaches the controller (no acknowledgement, status stays idle). It is re-sent once it is clear it did not start.',
    lookFor: [
      'wave.sent → wave.not_started (idle on two checks) → wave.retry_scheduled → wave.sent → wave.confirmed',
      'the cycle counted once in the history; the rest of the sequence continues',
    ],
    hours: 2,
    setup: (w) => {
      dryFront(w);
      w.ignoresCommands.add('timer-1');
    },
    timeline: [{ at: 1, note: 'The controller receives commands again', run: ({ world }) => void world.ignoresCommands.delete('timer-1') }],
  },
  {
    id: 'unconfirmed-command',
    title: 'Delivery cannot be confirmed either way',
    story:
      'At 06:00 the controller does not acknowledge the command and the B-hyve API goes down seconds later, so its status ' +
      'cannot be read. The cycle is counted as delivered rather than risking watering twice.',
    lookFor: [
      'wave.unconfirmed "counted as delivered so it is never sent twice"; no re-send',
      'Telegram: "Couldn’t confirm cycle 1/3 started" (warning)',
    ],
    hours: 2,
    setup: (w) => {
      dryFront(w);
      w.ignoresCommands.add('timer-1');
    },
    timeline: [
      { at: 0.1, note: 'B-hyve API goes down', run: ({ world }) => void (world.services.bhyveRest = 'down') },
      {
        at: 10,
        note: 'B-hyve API is back; the controller acknowledges commands again',
        run: ({ world }) => {
          world.services.bhyveRest = 'up';
          world.ignoresCommands.delete('timer-1');
        },
      },
    ],
  },
  {
    id: 'low-batteries',
    title: 'Batteries running low and being replaced',
    story:
      'Front sensor A drops to 18% at 06:30 and is replaced at 07:30. The hose timer (a second, battery-powered B-hyve ' +
      'controller) reads 15% and gets new batteries at 08:30.',
    lookFor: [
      'battery.low (sensor) → battery.ok after replacement',
      'battery.low (timer) from the hourly controller check → battery.ok',
      'Telegram: two "Low battery" warnings, two "Battery OK"',
    ],
    hours: 4,
    setup: (w) => {
      w.addDevice({ id: 'hose-1', name: 'Hose timer', stations: [1], battery: 15 });
    },
    timeline: [
      { at: 30, note: 'Front sensor A battery drops to 18%', run: ({ world }) => void (world.sensor('front-a').battery = 18) },
      { at: 90, note: 'Front sensor A battery replaced', run: ({ world }) => void (world.sensor('front-a').battery = 100) },
      { at: 150, note: 'Hose timer batteries replaced', run: ({ world }) => void (world.device('hose-1').battery = 100) },
    ],
  },
  {
    id: 'critical-moisture',
    title: 'Critically dry during a rain delay, then waterlogged by a storm',
    story:
      'A 48 h rain delay blocks watering while a hot day dries Back lawn past the 20% alert limit (around 08:00). ' +
      'A storm at 12:00 soaks everything past 60%; it drains by 15:00.',
    lookFor: [
      'zone.decision Back lawn → rain-delay (it needs water but may not get it)',
      'moisture.critical_low for the back sensor; later moisture.critical_high for all three sensors',
      'moisture.normal once they drain below 58% (hysteresis)',
      'Telegram: "Critically dry", "Waterlogged" (critical), "Moisture back to normal"',
    ],
    hours: 10,
    world: { dryingPctPerHour: 1 },
    setup: (w) => {
      w.sensor('back-a').moisture = 22;
      w.device('timer-1').rainDelayHours = 48;
    },
    timeline: [
      { at: 360, note: 'Thunderstorm: 60 mm of rain', run: ({ world }) => world.rain(45) },
      {
        at: 540,
        note: 'The soil has drained',
        run: ({ world }) => {
          for (const s of world.sensors.values()) s.moisture -= 15;
        },
      },
    ],
  },
  {
    id: 'controller-offline',
    title: 'The controller loses Wi-Fi for 2 hours',
    story: 'Front lawn is dry, but Lawn timer is offline (unreachable by the B-hyve cloud) from 06:00 to 08:00.',
    lookFor: [
      'device.offline → device.online (~120 min); zone.decision Front lawn → device-offline meanwhile',
      'watering starts once it is back online',
      'Telegram: "Lawn timer is offline" (critical), "back online", watering',
    ],
    hours: 4,
    setup: (w) => {
      dryFront(w);
      w.device('timer-1').connected = false;
    },
    timeline: [{ at: 120, note: 'The controller is back on Wi-Fi', run: ({ world }) => void (world.device('timer-1').connected = true) }],
  },
  {
    id: 'broken-valve',
    title: 'A stuck valve: watering runs but no water arrives',
    story:
      'Front lawn’s valve is stuck shut. The controller accepts each run, but the soil never gets wetter. After the full ' +
      'daily allowance (48 min) the zone is still dry.',
    lookFor: [
      'two sequences (06:00 and ~10:00), both completed, yet moisture keeps falling',
      'zone.daily_limit_reached for Front lawn',
      'Telegram: "Front lawn is still dry after its full daily allowance" (warning)',
    ],
    hours: 10,
    setup: (w) => {
      dryFront(w);
      w.stuckValves.add('timer-1:1');
    },
    timeline: [],
  },
  {
    id: 'sensor-dies',
    title: 'A sensor’s battery dies and it goes quiet',
    story: 'The back sensor reports a low battery at 06:20, stops reporting at 06:30, and is replaced at 11:00.',
    lookFor: [
      'battery.low, then zone.no_data for Back lawn once its last reading is 3 h old (~09:30)',
      'zone.data_restored and battery.ok after the replacement',
      'Telegram: "Low battery", "No sensor data for Back lawn", "Sensor data back", "Battery OK"',
    ],
    hours: 6,
    setup: () => {},
    timeline: [
      { at: 20, note: 'Back sensor battery at 4%', run: ({ world }) => void (world.sensor('back-a').battery = 4) },
      { at: 30, note: 'Back sensor stops reporting', run: ({ world, clock }) => void (world.sensor('back-a').silentSince = clock.now().getTime()) },
      {
        at: 300,
        note: 'Back sensor batteries replaced',
        run: ({ world }) => {
          const s = world.sensor('back-a');
          s.battery = 100;
          delete s.silentSince;
        },
      },
    ],
  },
  {
    id: 'monitoring-stuck',
    title: 'A request hangs forever (half-open connection)',
    story: 'At 06:10 the Tuya connection starts hanging without ever answering. The 10-minute watchdog abandons the stuck poll and monitoring carries on.',
    lookFor: [
      'poll.failed "poll did not finish within 10 min" at 06:25 (the 06:15 poll hung)',
      'monitoring carries on: the 06:40 poll sees Front lawn dry and starts watering',
      'Telegram: "Monitoring got stuck and was restarted" (critical), then watering',
    ],
    hours: 2,
    setup: () => {},
    timeline: [
      { at: 10, note: 'Tuya connection starts hanging', run: ({ world }) => void (world.services.tuya = 'hang') },
      { at: 30, note: 'Tuya answers again', run: ({ world }) => void (world.services.tuya = 'up') },
      {
        at: 35,
        note: 'Front lawn dries out',
        run: ({ world }) => {
          world.sensor('front-a').moisture = 25;
          world.sensor('front-b').moisture = 27;
        },
      },
    ],
  },
];

export const scenarioById = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);
