import { describe, expect, it } from 'vitest';
import {
  clip,
  duration,
  fitLines,
  formatDevices,
  formatReadings,
  formatStatus,
  MAX_REPLY_CHARS,
  safe,
  shortTime,
} from '../../bot/format.ts';
import type { ConductorStatus } from '../../conductor/monitor.ts';
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

describe('formatStatus', () => {
  const base = (overrides: Partial<ConductorStatus> = {}): ConductorStatus => ({
    at: NOW,
    running: true,
    dryRun: false,
    pollIntervalMinutes: 15,
    startedAt: minutesAgo(150),
    polling: false,
    lastPoll: { startedAt: minutesAgo(4), finishedAt: minutesAgo(3), ok: true },
    nextPollAt: new Date(NOW.getTime() + 12 * MIN),
    zones: [
      { key: 'dev1:1', name: 'Front lawn', decision: { at: minutesAgo(3), action: 'none', reason: 'moist', detail: '', moisturePct: 35.2 } },
      { key: 'dev1:2', name: 'Back lawn', decision: { at: minutesAgo(3), action: 'water', reason: 'dry', detail: '', moisturePct: 22, runMinutes: 12 } },
      { key: 'dev1:3', name: 'Beds', decision: { at: minutesAgo(3), action: 'skip', reason: 'no-data', detail: '' } },
      { key: 'dev1:4', name: 'Side', decision: { at: minutesAgo(3), action: 'skip', reason: 'something-new', detail: '' } },
      { key: 'dev2:1', name: 'New zone' },
    ],
    sequences: [],
    wateringNow: [],
    outages: [],
    alerts: [],
    ...overrides,
  });

  it('summarises a healthy conductor', () => {
    expect(formatStatus(base(), 'UTC')).toBe(
      [
        '🌱 <b>Lawn conductor status</b>',
        '▶️ Running since Jul 1, 09:30 (2.5 h), polling every 15 min',
        '✅ Last poll Jul 1, 11:57 (3 min ago)',
        '⏭️ Next poll Jul 1, 12:12',
        '',
        '<b>Zones</b>',
        '🟢 Front lawn: moist, soil 35.2% <i>(3 min ago)</i>',
        '💦 Back lawn: dry, soil 22%, 12 min <i>(3 min ago)</i>',
        '📵 Beds: no-data <i>(3 min ago)</i>',
        '• Side: something-new <i>(3 min ago)</i>',
        '• New zone: no decision yet',
        '',
        '<b>Connections</b>',
        '🟢 All services reachable',
      ].join('\n'),
    );
  });

  it('shows watering in progress, outages and open alerts', () => {
    const html = formatStatus(
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
      'UTC',
    );
    expect(html).toContain('🔄 Polling right now');
    expect(html).toContain('❌ Last poll failed Jul 1, 11:41 (19 min ago): Tuya GET /v1.0/token timed out after 20s');
    expect(html).toContain('<b>Watering in progress</b>\n💧 Back lawn: cycle 2/3 due Jul 1, 12:25\n💧 dev2: cycle 1/1 due now, 2 failed attempt(s)');
    expect(html).toContain('🔴 tuya unreachable since Jul 1, 11:15 (3 failure(s)): timed out');
    expect(html).toContain('<b>Open alerts</b> (1)\n⚠️ battery:sensor:s1: low since Jul 1, 02:00');
    expect(html).not.toContain('All services reachable');
  });

  it('shows a pause, the watering on hold (and what is too old to continue), and water that is on', () => {
    const html = formatStatus(
      base({
        paused: { since: minutesAgo(50), by: '@owner via Telegram' },
        sequences: [
          { id: 'a', deviceId: 'dev1', zoneNames: ['Front lawn'], nextCycle: 2, cycles: 3, dueAt: minutesAgo(20), attempts: 0, stale: false },
          { id: 'b', deviceId: 'dev2', zoneNames: ['Back lawn'], nextCycle: 3, cycles: 3, dueAt: minutesAgo(90), attempts: 0, stale: true },
          { id: 'c', deviceId: 'dev3', zoneNames: [], nextCycle: 2, cycles: 2, dueAt: new Date(NOW.getTime() + 5 * MIN), attempts: 0, stale: false },
        ],
        wateringNow: [{ deviceId: 'dev1', zoneNames: ['Front lawn'], cycle: 1, of: 3, until: new Date(NOW.getTime() + 4 * MIN) }],
      }),
      'UTC',
    );
    expect(html).toContain(
      '⏸️ <b>Paused</b> since Jul 1, 11:10 by @owner via Telegram: no supplemental watering (sensors are still read and alerts still sent). /resume to resume.',
    );
    expect(html).toContain(
      [
        '<b>Watering on hold</b>',
        '⏸️ Front lawn: cycle 2/3 due since Jul 1, 11:40',
        '⏸️ Back lawn: cycle 3/3 due since Jul 1, 10:30, too late to continue',
        '⏸️ dev3: cycle 2/2 due Jul 1, 12:05',
      ].join('\n'),
    );
    expect(html).toContain('<b>Water on now</b>\n💧 Front lawn: cycle 1/3 until Jul 1, 12:04');
  });

  it('shows water on now without a pause, and a paused zone', () => {
    const html = formatStatus(
      base({
        wateringNow: [{ deviceId: 'dev9', zoneNames: [], cycle: 2, of: 2, until: new Date(NOW.getTime() + MIN) }],
        zones: [{ key: 'dev1:1', name: 'Front', decision: { at: NOW, action: 'skip', reason: 'paused', detail: '', moisturePct: 20 } }],
      }),
      'UTC',
    );
    expect(html).toContain('<b>Water on now</b>\n💧 dev9: cycle 2/2 until Jul 1, 12:01');
    expect(html).toContain('⏸️ Front: paused, soil 20%');
    expect(html).not.toContain('<b>Paused</b>');
  });

  it('says when monitoring is not running, or has not polled yet', () => {
    const { startedAt: _s, lastPoll: _l, nextPollAt: _n, ...rest } = base();
    expect(formatStatus({ ...rest, running: false }, 'UTC')).toContain('⏹️ Monitoring is <b>not running</b>');
    expect(formatStatus({ ...rest, startedAt: NOW }, 'UTC')).toContain('No poll has finished yet');
    expect(formatStatus({ ...rest, startedAt: NOW, polling: true }, 'UTC')).not.toContain('No poll has finished yet');
  });

  it('flags a dry run', () => {
    expect(formatStatus(base({ dryRun: true }), 'UTC').split('\n')[0]).toBe(
      '🌱 <b>Lawn conductor status</b> (dry run: no watering commands are sent)',
    );
  });

  it('escapes zone names, errors and alert keys', () => {
    const html = formatStatus(
      base({
        lastPoll: { startedAt: NOW, finishedAt: NOW, ok: false, error: EVIL },
        zones: [{ key: EVIL, name: EVIL, decision: { at: NOW, action: 'skip', reason: EVIL, detail: EVIL } }],
        sequences: [{ id: EVIL, deviceId: EVIL, zoneNames: [EVIL], nextCycle: 1, cycles: 2, dueAt: NOW, attempts: 0, stale: false }],
        wateringNow: [{ deviceId: EVIL, zoneNames: [EVIL], cycle: 1, of: 2, until: NOW }],
        paused: { since: NOW, by: EVIL },
        outages: [{ service: 'tuya', since: NOW, failures: 1, lastError: EVIL }],
        alerts: [{ key: EVIL, state: EVIL, since: NOW }],
      }),
      'UTC',
    );
    wellFormed(html);
  });

  it('stays within the message size limit with many zones', () => {
    const zones = Array.from({ length: 300 }, (_, i) => ({ key: `d:${i}`, name: `Zone ${i} ${'n'.repeat(150)}` }));
    const html = formatStatus(base({ zones }), 'UTC');
    expect(html.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    wellFormed(html);
  });
});
