import { describe, expect, it } from 'vitest';
import {
  clip,
  duration,
  fitLines,
  formatDevices,
  formatReadings,
  formatHealth,
  formatZone,
  alertLabel,
  isDuration,
  parseDuration,
  size,
  MAX_REPLY_CHARS,
  safe,
  shortTime,
} from '../../bot/format.ts';
import type { ServiceName } from '../../audit/health.ts';
import type { ConductorStatus, ZoneDetail } from '../../conductor/monitor.ts';
import { conductorStatus, serviceInfo } from '../utils/bot.ts';
import { bhyveDevice, minutesAgo, NOW, reading } from '../utils/conductor.ts';

const MIN = 60_000;
/** Telegram HTML with the tags we produce removed must have no "<" or ">" left (i.e. everything else was escaped). */
const wellFormed = (html: string) => expect(html.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);
const EVIL = '<a href="http://evil">x</a> & <script>';

describe('helpers', () => {
  it('clip shortens with an ellipsis', () => {
    expect(clip('abcdef', 10)).toBe('abcdef');
    expect(clip('abcdef', 4)).toBe('abc…');
  });

  it('safe clips before escaping, so an entity is never cut in half', () => {
    expect(safe('<<<<', 3)).toBe('&lt;&lt;…');
    expect(safe(undefined)).toBe('?');
    expect(safe(null)).toBe('?');
    expect(safe(42)).toBe('42');
    expect(safe(EVIL)).toBe('&lt;a href="http://evil"&gt;x&lt;/a&gt; &amp; &lt;script&gt;');
  });

  it('fitLines keeps whole lines and says how many were left out', () => {
    expect(fitLines(['a', 'b', 'c'], 100)).toBe('a\nb\nc');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const out = fitLines(lines, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.split('\n').at(-1)).toMatch(/^… \d+ more line\(s\) not shown$/);
    const shown = out.split('\n').length - 1;
    expect(out).toContain(`… ${10 - shown} more line(s) not shown`);
  });

  it('fitLines uses all the space when the last line fits exactly', () => {
    expect(fitLines(['aaaa', 'bbbb'], 9)).toBe('aaaa\nbbbb');
  });

  it('fitLines never cuts inside a line (so never inside a tag)', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `<b>${i}</b> <code>${'y'.repeat(i % 50)}</code>`);
    const out = fitLines(lines);
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    for (const line of out.split('\n').slice(0, -1)) expect(lines).toContain(line);
  });

  it.each([
    [0, '0 s'],
    [45_000, '45 s'],
    [89_000, '89 s'],
    [12 * MIN, '12 min'],
    [150 * MIN, '2.5 h'],
    [72 * 60 * MIN, '3 days'],
    [-5000, '0 s'],
  ])('duration(%i) = %s', (ms, text) => {
    expect(duration(ms)).toBe(text);
  });

  it('shortTime uses the given time zone', () => {
    expect(shortTime(NOW, 'UTC')).toBe('Jul 1, 12:00');
    expect(shortTime(NOW, 'America/Chicago')).toBe('Jul 1, 07:00');
  });
});

describe('formatDevices', () => {
  it('shows each controller like `npm run bhyve:devices`', () => {
    const html = formatDevices([
      bhyveDevice('dev1', {
        name: 'Front timer',
        battery: { percent: 76.55 },
        zones: [
          { station: 1, name: 'Front lawn' },
          { station: 2 },
        ],
      }),
      bhyveDevice('dev2', {
        name: 'Back timer',
        is_connected: false,
        status: { run_mode: 'off', rain_delay: 24, watering_status: { current_station: 3 } },
        zones: [],
      }),
      { id: 'br1', name: 'Hub', type: 'bridge' },
    ]);
    expect(html).toBe(
      [
        '📟 <b>B-hyve devices</b> (3)',
        '',
        '<b>Front timer</b> [sprinkler_timer]',
        'id <code>dev1</code> · connected ✅ · battery 76.6%',
        'mode auto · rain delay 0 h',
        '  zone 1: Front lawn',
        '  zone 2: (unnamed)',
        '',
        '<b>Back timer</b> [sprinkler_timer]',
        'id <code>dev2</code> · connected ❌ offline',
        'mode off · rain delay 24 h · 💧 watering station 3',
        '',
        '<b>Hub</b> [bridge]',
        'id <code>br1</code> · connected ?',
      ].join('\n'),
    );
  });

  it('says when watering is on without a known station', () => {
    expect(formatDevices([bhyveDevice('d', { status: { run_mode: 'auto', watering_status: {} } })])).toContain('mode auto · rain delay 0 h · 💧 watering');
  });

  it('handles an empty account', () => {
    expect(formatDevices([])).toBe('📟 <b>B-hyve devices</b>\nNo devices on this account.');
  });

  it('escapes names set in the B-hyve app, and whatever else the API returns', () => {
    const html = formatDevices([
      {
        id: EVIL,
        name: EVIL,
        type: EVIL,
        is_connected: true,
        status: { run_mode: EVIL, rain_delay: 0 },
        zones: [{ station: 1, name: EVIL }],
      },
    ]);
    wellFormed(html);
    expect(html).toContain('&lt;script&gt;');
  });

  it('stays within the message size limit for a huge account', () => {
    const devices = Array.from({ length: 60 }, (_, i) =>
      bhyveDevice(`dev${i}`, { name: 'N'.repeat(500), zones: Array.from({ length: 12 }, (_, s) => ({ station: s + 1, name: 'Z'.repeat(300) })) }),
    );
    const html = formatDevices(devices);
    expect(html.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(html).toMatch(/… \d+ more line\(s\) not shown$/);
    wellFormed(html);
  });
});

describe('formatReadings', () => {
  const zones = new Map([
    ['s1', ['Front lawn']],
    ['s2', ['Front lawn', 'Back lawn']],
  ]);

  it('shows each sensor like `npm run sensors:read`, with its zones', () => {
    const html = formatReadings({
      readings: [
        reading('s1', 31.25, { sensorName: 'Probe A', temperatureC: 21.04, batteryPct: 80, at: minutesAgo(5) }),
        reading('s2', 12, { sensorName: 'Probe B', online: false, at: minutesAgo(200) }),
        reading('s3', 40, { sensorName: 'Spare', at: NOW }),
      ],
      errors: [{ sensorId: 's4', error: 'No numeric "humidity" data point; available codes: temp_current' }],
      zonesBySensor: zones,
      now: NOW,
    });
    expect(html).toBe(
      [
        '🌱 <b>Soil sensors</b> (3 of 4 read)',
        '• <b>Probe A</b> (Front lawn): 💧 31.3% · 🌡️ 21°C · 🔋 80% · updated 5 min ago',
        '• <b>Probe B</b> (Front lawn, Back lawn): 💧 12% · ⚠️ offline · updated 3.3 h ago',
        '• <b>Spare</b>: 💧 40% · updated 0 s ago',
        '• ❌ <code>s4</code>: No numeric "humidity" data point; available codes: temp_current',
      ].join('\n'),
    );
  });

  it('handles no sensors', () => {
    expect(formatReadings({ readings: [], errors: [], zonesBySensor: new Map(), now: NOW })).toBe('🌱 <b>Soil sensors</b>\nNo sensors configured.');
  });

  it('escapes sensor names and errors', () => {
    const html = formatReadings({
      readings: [reading(EVIL, 10, { sensorName: EVIL })],
      errors: [{ sensorId: EVIL, error: EVIL }],
      zonesBySensor: new Map([[EVIL, [EVIL]]]),
      now: NOW,
    });
    wellFormed(html);
  });
});

describe('formatHealth', () => {
  const base = (overrides: Partial<ConductorStatus> = {}): ConductorStatus =>
    conductorStatus({
      startedAt: minutesAgo(150),
      lastPoll: { startedAt: minutesAgo(4), finishedAt: minutesAgo(3), ok: true },
      nextPollAt: new Date(NOW.getTime() + 12 * MIN),
      zones: [
        { key: 'dev1:1', name: 'Front lawn', decision: { at: minutesAgo(3), action: 'none', reason: 'moist', detail: '', moisturePct: 35.2 } },
        { key: 'dev1:2', name: 'Back lawn', decision: { at: minutesAgo(3), action: 'water', reason: 'dry', detail: '', moisturePct: 22, runMinutes: 12 } },
        { key: 'dev1:3', name: 'Beds', decision: { at: minutesAgo(3), action: 'skip', reason: 'no-data', detail: '' } },
        { key: 'dev1:4', name: 'Side', decision: { at: minutesAgo(3), action: 'skip', reason: 'something-new', detail: '' } },
        { key: 'dev2:1', name: 'New zone' },
      ],
      polls: { ok: 288, failed: 2, hung: 0 },
      ...overrides,
    });
  const health = (s: ConductorStatus, service = serviceInfo()) => formatHealth(s, service, 'UTC');

  it('summarises a healthy conductor: verdict first, then everything /status used to show, then the service', () => {
    expect(health(base())).toBe(
      [
        '🩺 <b>Health</b>: ✅ all good',
        '',
        '▶️ Running since Jul 1, 09:30 (2.5 h), polling every 15 min',
        '✅ Last poll Jul 1, 11:57 (3 min ago)',
        '⏭️ Next poll Jul 1, 12:12',
        '',
        '<b>Zones</b> (details: /zone <i>number</i>)',
        '1. 🟢 Front lawn: moist, soil 35.2% <i>(3 min ago)</i>',
        '2. 💦 Back lawn: dry, soil 22%, 12 min <i>(3 min ago)</i>',
        '3. 📵 Beds: no-data <i>(3 min ago)</i>',
        '4. • Side: something-new <i>(3 min ago)</i>',
        '5. New zone: no decision yet',
        '',
        '<b>Connections</b>',
        '🟢 All services reachable',
        '',
        '<b>Service</b>',
        'v1.0.0 · Node v22.21.0 · up 3 h · memory 80 MB',
        'Polls since start: 288 ok · 2 failed · 0 stuck',
        'Files: audit trail 1.2 MB · state 2 KB · settings 900 B',
        'Notifications: 12 sent · 0 failed · 0 waiting',
      ].join('\n'),
    );
  });

  it('shows watering in progress, outages and open alerts (in words), and lists what needs a look first', () => {
    const html = health(
      base({
        polling: true,
        lastPoll: { startedAt: minutesAgo(20), finishedAt: minutesAgo(19), ok: false, error: 'Tuya GET /v1.0/token timed out after 20s' },
        sequences: [
          { id: 'a1', deviceId: 'dev1', zoneNames: ['Back lawn'], nextCycle: 2, cycles: 3, dueAt: new Date(NOW.getTime() + 25 * MIN), attempts: 0, stale: false },
          { id: 'b2', deviceId: 'dev2', zoneNames: [], nextCycle: 1, cycles: 1, dueAt: minutesAgo(2), attempts: 2, stale: false },
        ],
        outages: [{ service: 'tuya', since: minutesAgo(45), failures: 3, lastError: 'timed out' }],
        alerts: [{ key: 'battery:sensor:s1', state: 'low', since: minutesAgo(600) }],
      }),
    );
    expect(html.split('\n').slice(0, 4)).toEqual([
      '🩺 <b>Health</b>: ⚠️ 3 thing(s) to look at',
      '• tuya unreachable since Jul 1, 11:15',
      '• the last poll failed',
      '• 1 open alert(s)',
    ]);
    expect(html).toContain('🔄 Polling right now');
    expect(html).toContain('❌ Last poll failed Jul 1, 11:41 (19 min ago): Tuya GET /v1.0/token timed out after 20s');
    expect(html).toContain('<b>Watering in progress</b>\n💧 Back lawn: cycle 2/3 due Jul 1, 12:25\n💧 dev2: cycle 1/1 due now, 2 failed attempt(s)');
    expect(html).toContain('🔴 tuya unreachable since Jul 1, 11:15 (3 failure(s)): timed out');
    expect(html).toContain('<b>Open alerts</b> (1)\n🪫 low battery: sensor s1 since Jul 1, 02:00');
    expect(html).not.toContain('All services reachable');
  });

  it.each([
    ['no poll for a long time', { lastPoll: { startedAt: minutesAgo(50), finishedAt: minutesAgo(40), ok: true } }, {}, '• no poll for 40 min'],
    ['monitoring stopped', { running: false }, {}, '• monitoring is not running'],
    ['notifications lost', {}, { notifications: { delivered: 3, failed: 2, waiting: 0 } }, '• 2 notification(s) could not be sent'],
    ['changes locked', {}, { commandsLockedForMs: 12 * MIN }, '• changes locked for another 12 min after wrong passphrases'],
  ] as const)('lists %s as something to look at', (_, status, service, line) => {
    const html = health(base(status), serviceInfo(service));
    expect(html).toMatch(/^🩺 <b>Health<\/b>: ⚠️ 1 thing\(s\) to look at/);
    expect(html.split('\n')[1]).toBe(line);
  });

  it('does not count a poll under way, or one merely due, as a problem', () => {
    expect(health(base({ lastPoll: { startedAt: minutesAgo(20), finishedAt: minutesAgo(18), ok: true } })).split('\n')[0]).toBe('🩺 <b>Health</b>: ✅ all good');
    expect(health(base({ polling: true, lastPoll: { startedAt: minutesAgo(50), finishedAt: minutesAgo(40), ok: true } })).split('\n')[0]).toBe(
      '🩺 <b>Health</b>: ✅ all good',
    );
  });

  it('shows a pause (and when it ends), the watering on hold, and water that is on', () => {
    const html = health(
      base({
        paused: { since: minutesAgo(50), by: '@owner via Telegram', until: new Date(NOW.getTime() + 70 * MIN) },
        sequences: [
          { id: 'a', deviceId: 'dev1', zoneNames: ['Front lawn'], nextCycle: 2, cycles: 3, dueAt: minutesAgo(20), attempts: 0, stale: false },
          { id: 'b', deviceId: 'dev2', zoneNames: ['Back lawn'], nextCycle: 3, cycles: 3, dueAt: minutesAgo(90), attempts: 0, stale: true },
          { id: 'c', deviceId: 'dev3', zoneNames: [], nextCycle: 2, cycles: 2, dueAt: new Date(NOW.getTime() + 5 * MIN), attempts: 0, stale: false },
        ],
        wateringNow: [{ deviceId: 'dev1', zoneNames: ['Front lawn'], cycle: 1, of: 3, until: new Date(NOW.getTime() + 4 * MIN) }],
      }),
    );
    expect(html).toContain(
      '⏸️ <b>Paused</b> since Jul 1, 11:10 by @owner via Telegram, until Jul 1, 13:10: no supplemental watering (sensors are still read and alerts still sent). /resume to resume sooner.',
    );
    expect(html).toContain(
      [
        '<b>Watering on hold</b>',
        '⏸️ Front lawn: cycle 2/3 due since Jul 1, 11:40',
        '⏸️ Back lawn: cycle 3/3 due since Jul 1, 10:30, too late to continue',
        '⏸️ dev3: cycle 2/2 due Jul 1, 12:05',
      ].join('\n'),
    );
    expect(html).toContain('<b>Water on now</b> (/stop turns it off)\n💧 Front lawn: cycle 1/3 until Jul 1, 12:04');
  });

  it('shows a pause without an end', () => {
    expect(health(base({ paused: { since: minutesAgo(50), by: '@owner via Telegram' } }))).toContain(
      '⏸️ <b>Paused</b> since Jul 1, 11:10 by @owner via Telegram: no supplemental watering (sensors are still read and alerts still sent). /resume to resume.',
    );
  });

  it('shows water on now without a pause, and a paused zone', () => {
    const html = health(
      base({
        wateringNow: [{ deviceId: 'dev9', zoneNames: [], cycle: 2, of: 2, until: new Date(NOW.getTime() + MIN) }],
        zones: [{ key: 'dev1:1', name: 'Front', decision: { at: NOW, action: 'skip', reason: 'paused', detail: '', moisturePct: 20 } }],
      }),
    );
    expect(html).toContain('<b>Water on now</b> (/stop turns it off)\n💧 dev9: cycle 2/2 until Jul 1, 12:01');
    expect(html).toContain('1. ⏸️ Front: paused, soil 20%');
    expect(html).not.toContain('<b>Paused</b>');
  });

  it('says when monitoring is not running, or has not polled yet', () => {
    const { startedAt: _s, lastPoll: _l, nextPollAt: _n, ...rest } = base();
    expect(health({ ...rest, running: false })).toContain('⏹️ Monitoring is <b>not running</b>');
    expect(health({ ...rest, startedAt: NOW })).toContain('No poll has finished yet');
    expect(health({ ...rest, startedAt: NOW, polling: true })).not.toContain('No poll has finished yet');
  });

  it('flags a dry run', () => {
    expect(health(base({ dryRun: true })).split('\n')[1]).toBe('🧪 Dry run: no watering commands are sent.');
  });

  it('says when a file is missing, and leaves out notifications when there are none', () => {
    const { notifications: _n, ...noNotifications } = serviceInfo({ files: [{ name: 'state' }] });
    const html = health(base(), noNotifications);
    expect(html).toContain('Files: state none yet');
    expect(html).not.toContain('Notifications:');
  });

  it('escapes zone names, errors, alert keys and the service details', () => {
    const html = health(
      base({
        lastPoll: { startedAt: NOW, finishedAt: NOW, ok: false, error: EVIL },
        zones: [{ key: EVIL, name: EVIL, decision: { at: NOW, action: 'skip', reason: EVIL, detail: EVIL } }],
        sequences: [{ id: EVIL, deviceId: EVIL, zoneNames: [EVIL], nextCycle: 1, cycles: 2, dueAt: NOW, attempts: 0, stale: false }],
        wateringNow: [{ deviceId: EVIL, zoneNames: [EVIL], cycle: 1, of: 2, until: NOW }],
        paused: { since: NOW, by: EVIL, until: NOW },
        outages: [{ service: EVIL as ServiceName, since: NOW, failures: 1, lastError: EVIL }],
        alerts: [{ key: EVIL, state: EVIL, since: NOW }],
      }),
      serviceInfo({ version: EVIL, node: EVIL, files: [{ name: EVIL, bytes: 1 }] }),
    );
    wellFormed(html);
  });

  it('stays within the message size limit with many zones', () => {
    const zones = Array.from({ length: 300 }, (_, i) => ({ key: `d:${i}`, name: `Zone ${i} ${'n'.repeat(150)}` }));
    const html = health(base({ zones }));
    expect(html.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    wellFormed(html);
  });
});

describe('alertLabel', () => {
  const names = new Map([
    ['s1', 'Probe A'],
    ['dev1', 'Front timer'],
    ['dev1:1', 'Front lawn'],
  ]);
  it.each([
    ['battery:sensor:s1', 'low', '🪫 low battery: sensor Probe A'],
    ['battery:device:dev1', 'low', '🪫 low battery: controller Front timer'],
    ['device:dev1', 'offline', '📴 controller Front timer offline'],
    ['daily-limit:dev1:1', 'reached', '⏱️ Front lawn still dry after its daily allowance'],
    ['moisture:dev1:1:s1', 'low', '🏜️ critically dry: Front lawn (sensor Probe A)'],
    ['moisture:dev1:1:s1', 'high', '🌊 waterlogged: Front lawn (sensor Probe A)'],
    ['moisture:dev1:1:s9', 'odd', '⚠️ odd: Front lawn (sensor s9)'],
    ['battery:sensor:unknown', 'low', '🪫 low battery: sensor unknown'],
    ['something:new', 'on', '⚠️ something:new: on'],
  ])('%s (%s)', (key, state, label) => {
    expect(alertLabel(key, state, names)).toBe(label);
  });

  it('escapes', () => {
    wellFormed(alertLabel(`battery:sensor:${EVIL}`, 'low'));
    wellFormed(alertLabel(EVIL, EVIL));
  });
});

describe('parseDuration', () => {
  const limits = { minMs: 5 * MIN, maxMs: 30 * 24 * 60 * MIN };
  it.each([
    ['90m', 90 * MIN],
    ['30min', 30 * MIN],
    ['4h', 240 * MIN],
    [' 2D ', 2 * 24 * 60 * MIN],
    ['1w', 7 * 24 * 60 * MIN],
    ['30d', 30 * 24 * 60 * MIN],
  ])('%j', (text, ms) => {
    expect(parseDuration(text, limits)).toBe(ms);
  });

  it.each(['', '4', '4 h', '1.5h', '-2h', 'h4', '4hours', 'tomorrow', '2026-07-01'])('refuses %j', (text) => {
    expect(parseDuration(text, limits)).toEqual({ problem: 'Give a time like 90m, 4h or 2d (between 5 min and 30 days).' });
  });

  it.each(['4m', '31d', '5w', '9999h'])('refuses %j as out of range', (text) => {
    expect(parseDuration(text, limits)).toEqual({ problem: 'The time must be between 5 min and 30 days.' });
  });

  it('recognises the shape, whatever the range', () => {
    expect(isDuration('9999d')).toBe(true);
    expect(isDuration('9999 d')).toBe(false);
  });
});

describe('size', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [2048, '2 KB'],
    [1_234_567, '1.2 MB'],
  ])('%d → %s', (bytes, text) => {
    expect(size(bytes)).toBe(text);
  });
});

describe('formatZone', () => {
  const detail = (overrides: Partial<ZoneDetail> = {}): ZoneDetail => ({
    at: NOW,
    zone: {
      key: 'dev1:1',
      name: 'Front lawn',
      deviceId: 'dev1',
      station: 1,
      thresholdPct: 30,
      targetPct: 40,
      runMinutes: 10,
      maxMinutesPerDay: 30,
      cooldownMinutes: 240,
      maxCycleMinutes: 20,
      soakMinutes: 30,
      sensorAggregation: 'driest',
      maxReadingAgeMinutes: 180,
      criticalLowPct: 20,
      criticalHighPct: 60,
    },
    decision: { at: minutesAgo(3), action: 'skip', reason: 'cooldown', detail: 'Probe A at 24% (threshold 30%), but in cooldown until 12:45' },
    sensors: [
      { id: 's1', name: 'Probe A', moisturePct: 24.04, temperatureC: 21.26, batteryPct: 80, at: minutesAgo(5) },
      { id: 's2', name: 'Probe B', moisturePct: 12, at: minutesAgo(400), problem: 'stale (400 min old)' },
      { id: 's3', problem: 'Tuya GET /v1.0/devices/s3 failed: code 1106 permission deny' },
    ],
    usedLastDayMinutes: 20,
    lastRun: { at: minutesAgo(75), minutes: 10 },
    cooldownUntil: new Date(NOW.getTime() + 45 * MIN),
    alerts: [{ key: 'battery:sensor:s2', state: 'low', since: minutesAgo(600) }],
    ...overrides,
  });

  it('shows everything about the zone: why, sensors, watering, settings, alerts', () => {
    expect(formatZone(detail(), 'UTC')).toBe(
      [
        '🌱 <b>Front lawn</b> · controller dev1, station 1',
        '🕒 <b>cooldown</b>: Probe A at 24% (threshold 30%), but in cooldown until 12:45 <i>(3 min ago)</i>',
        '',
        '<b>Sensors</b> (the driest sensor counts)',
        '• Probe A: 💧 24% · 🌡️ 21.3°C · 🔋 80% · 5 min old',
        '• Probe B: 💧 12% · 6.7 h old · ⚠️ not used: stale (400 min old)',
        '• s3: ⚠️ Tuya GET /v1.0/devices/s3 failed: code 1106 permission deny',
        '',
        '<b>Watering</b>',
        '• Last 24 h: 20 of 30 min used',
        '• Last run: Jul 1, 10:45 (10 min)',
        '• ⏳ Resting until Jul 1, 12:45 (cooldown)',
        '',
        '<b>Settings</b> (/config changes them)',
        'Water below 30% · refill to 40% · runs of 10 min · up to 30 min a day · 4 h between runs · cycles of up to 20 min with 30 min soak · ' +
          'alerts below 20% and above 60% · readings used up to 3 h old',
        '',
        '<b>Open alerts</b> (1)',
        '🪫 low battery: sensor Probe B since Jul 1, 02:00',
      ].join('\n'),
    );
  });

  it('shows watering under way, a pause, and what is missing', () => {
    const { decision: _d, lastRun: _l, cooldownUntil: _c, ...rest } = detail({ alerts: [] });
    const html = formatZone(
      {
        ...rest,
        paused: { since: minutesAgo(10), by: '@owner via Telegram' },
        wateringNow: { deviceId: 'dev1', zoneNames: ['Front lawn'], cycle: 1, of: 3, until: new Date(NOW.getTime() + 8 * MIN) },
        sequence: { id: 'q', deviceId: 'dev1', zoneNames: ['Front lawn', 'Back lawn'], nextCycle: 2, cycles: 3, dueAt: new Date(NOW.getTime() + 38 * MIN), attempts: 0, stale: false },
      },
      'UTC',
    );
    expect(html).toContain('No decision yet.');
    expect(html).toContain('⏸️ <b>Paused</b> since Jul 1, 11:50 by @owner via Telegram');
    expect(html).toContain('• No supplemental run recently');
    expect(html).toContain('• 💧 Water on until Jul 1, 12:08 (cycle 1/3) · /stop turns it off');
    expect(html).toContain('• ⏸️ Next cycle 2/3 on hold (on Front lawn, Back lawn)');
    expect(html).not.toContain('Open alerts');
    expect(html).not.toContain('Resting');
  });

  it('shows the next cycle when not paused', () => {
    const html = formatZone(
      detail({ sequence: { id: 'q', deviceId: 'dev1', zoneNames: ['Front lawn'], nextCycle: 2, cycles: 3, dueAt: new Date(NOW.getTime() + 38 * MIN), attempts: 0, stale: false } }),
      'UTC',
    );
    expect(html).toContain('• 🔁 Next cycle 2/3 due Jul 1, 12:38 (on Front lawn)');
  });

  it('escapes what comes from sensors, settings and decisions', () => {
    const html = formatZone(
      detail({
        zone: { ...detail().zone, name: EVIL, deviceId: EVIL, sensorAggregation: EVIL as 'driest' },
        decision: { at: NOW, action: 'skip', reason: EVIL, detail: EVIL },
        sensors: [{ id: EVIL, name: EVIL, moisturePct: 1, problem: EVIL }, { id: EVIL, problem: EVIL }],
        alerts: [{ key: EVIL, state: EVIL, since: NOW }],
      }),
      'UTC',
    );
    wellFormed(html);
  });
});
