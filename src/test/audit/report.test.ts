import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../audit/audit.ts';
import { describe as describeEvent, filterEvents, formatEvent, formatSummary, parseSince, shortId, summarize } from '../../audit/report.ts';

const NOW = new Date('2026-07-01T12:00:00Z');
const ev = (ts: string, type: AuditEvent['type'], data: Record<string, unknown> = {}): AuditEvent => ({ ts, type, ...data });

/** A realistic incident: B-hyve's socket drops during a soak; the sequence retries and completes. */
const INCIDENT: AuditEvent[] = [
  ev('2026-07-01T06:00:00.000Z', 'service.started', { mode: 'continuous', dryRun: false, zones: 2 }),
  ev('2026-07-01T06:05:00.000Z', 'sequence.started', {
    sequence: 's1',
    device: 'dev1',
    waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]],
    soakMinutes: 30,
    plannedMinutes: 20,
    zones: [{ zone: 'dev1:1', moisturePct: 22.46, minutes: 20 }],
  }),
  ev('2026-07-01T06:05:00.000Z', 'wave.sent', { sequence: 's1', device: 'dev1', cycle: 1, of: 2, stations: [{ station: 1, runTime: 10 }], attempt: 1 }),
  ev('2026-07-01T06:05:01.000Z', 'wave.confirmed', { sequence: 's1', device: 'dev1', cycle: 1, of: 2, via: 'event' }),
  ev('2026-07-01T06:20:00.000Z', 'socket.disconnected', { code: 1006 }),
  ev('2026-07-01T06:45:00.000Z', 'connection.lost', { service: 'bhyve-commands', error: 'socket did not open within 15s' }),
  ev('2026-07-01T06:45:00.000Z', 'wave.send_failed', { sequence: 's1', device: 'dev1', cycle: 2, of: 2, stations: [{ station: 1, runTime: 10 }], error: 'socket did not open within 15s' }),
  ev('2026-07-01T06:45:00.000Z', 'wave.retry_scheduled', { sequence: 's1', device: 'dev1', cycle: 2, of: 2, attempt: 2, inMinutes: 1, reason: 'socket did not open within 15s' }),
  ev('2026-07-01T06:46:00.000Z', 'socket.connected'),
  ev('2026-07-01T06:46:00.000Z', 'connection.restored', { service: 'bhyve-commands', downSince: '2026-07-01T06:45:00.000Z', outageMinutes: 1, failures: 1, lastError: 'socket did not open within 15s' }),
  ev('2026-07-01T06:46:00.000Z', 'wave.sent', { sequence: 's1', device: 'dev1', cycle: 2, of: 2, stations: [{ station: 1, runTime: 10 }], attempt: 2 }),
  ev('2026-07-01T06:46:01.000Z', 'wave.confirmed', { sequence: 's1', device: 'dev1', cycle: 2, of: 2, via: 'status' }),
  ev('2026-07-01T06:46:01.000Z', 'sequence.completed', { sequence: 's1', device: 'dev1', cycles: 2, deliveredMinutes: 20 }),
  ev('2026-07-01T08:00:00.000Z', 'zone.no_data', { zone: 'dev2:3', name: 'Back', detail: 'no usable readings (s9: offline)' }),
  ev('2026-07-01T09:00:00.000Z', 'connection.lost', { service: 'tuya', error: 'timed out after 20s' }),
];

describe('parseSince', () => {
  it.each([
    ['90m', '2026-07-01T10:30:00.000Z'],
    ['24h', '2026-06-30T12:00:00.000Z'],
    ['7d', '2026-06-24T12:00:00.000Z'],
    ['2w', '2026-06-17T12:00:00.000Z'],
    ['2026-06-30T06:00:00Z', '2026-06-30T06:00:00.000Z'],
  ])('reads %s', (text, expected) => {
    expect(parseSince(text, NOW).toISOString()).toBe(expected);
  });

  it('explains what it accepts', () => {
    expect(() => parseSince('yesterday', NOW)).toThrow('use e.g. 24h, 7d or 2026-07-01T06:00');
  });
});

describe('filterEvents', () => {
  const types = (events: AuditEvent[]) => events.map((e) => e.type);

  it('filters by time range', () => {
    const got = filterEvents(INCIDENT, { since: new Date('2026-07-01T06:45:00Z'), until: new Date('2026-07-01T06:46:00Z') });
    expect(got).toHaveLength(6);
  });

  it('filters by type prefix or exact type', () => {
    expect(new Set(types(filterEvents(INCIDENT, { types: ['connection'] })))).toEqual(new Set(['connection.lost', 'connection.restored']));
    expect(types(filterEvents(INCIDENT, { types: ['sequence.completed', 'socket'] }))).toEqual([
      'socket.disconnected',
      'socket.connected',
      'sequence.completed',
    ]);
  });

  it('only failures and recoveries with --recovery', () => {
    expect(types(filterEvents(INCIDENT, { recovery: true }))).toEqual([
      'socket.disconnected',
      'connection.lost',
      'wave.send_failed',
      'wave.retry_scheduled',
      'connection.restored',
      'zone.no_data',
      'connection.lost',
    ]);
  });

  it('follows one sequence from start to finish', () => {
    expect(filterEvents(INCIDENT, { sequence: 's1' })).toHaveLength(8);
  });

  it('finds a sequence by the beginning of its id, as messages show it', () => {
    const id = '3f9a1c2e-7b4d-4e21-9c0a-5d6e7f801234';
    const events = [ev(NOW.toISOString(), 'wave.sent', { sequence: id }), ev(NOW.toISOString(), 'wave.sent', { sequence: '3f9a0000-0000-4000-8000-000000000000' })];

    expect(filterEvents(events, { sequence: '3f9a1c2e' })).toEqual([events[0]]);
    expect(filterEvents(events, { sequence: id })).toEqual([events[0]]);
    expect(filterEvents(events, { sequence: '3f9a' })).toHaveLength(2);
    expect(filterEvents([ev(NOW.toISOString(), 'service.started')], { sequence: '3f9a' })).toEqual([]);
  });

  it('finds a zone by key, station or zone list', () => {
    expect(types(filterEvents(INCIDENT, { zone: 'dev1:1' }))).toContain('sequence.started');
    expect(filterEvents(INCIDENT, { zone: 'dev1:1' }).filter((e) => e.type === 'wave.sent')).toHaveLength(2);
    expect(types(filterEvents(INCIDENT, { zone: 'dev2:3' }))).toEqual(['zone.no_data']);
    expect(filterEvents(INCIDENT, { zone: 'dev1:2' })).toEqual([]);
  });

  it('filters by device', () => {
    expect(filterEvents(INCIDENT, { device: 'dev1' })).toHaveLength(8);
  });
});

describe('describe / formatEvent', () => {
  it('renders each event as one readable line', () => {
    const lines = INCIDENT.map((e) => describeEvent(e));

    expect(lines[1]).toBe('watering started dev1 [seq s1]: 20 min in 2 cycle(s), 30 min soak — dev1:1 at 22.5% → 20 min');
    expect(lines[6]).toBe('send failed dev1 [seq s1] cycle 2/2: socket did not open within 15s');
    expect(lines[7]).toBe('retry dev1 [seq s1] cycle 2/2 #2 in 1 min (socket did not open within 15s)');
    expect(lines[9]).toBe('bhyve-commands reachable again after 1 min (1 failed attempts; last error: socket did not open within 15s)');
    expect(lines[12]).toBe('watering completed dev1 [seq s1]: 20 min in 2 cycle(s)');
  });

  it('prefixes time in the requested zone and flags recovery events', () => {
    expect(formatEvent(INCIDENT[6] as AuditEvent, 'America/Chicago')).toMatch(/^2026-07-01 01:45:00 {2}! wave\.send_failed +send failed/);
    expect(formatEvent(INCIDENT[3] as AuditEvent, 'UTC')).toMatch(/^2026-07-01 06:05:01 {4}wave\.confirmed/);
  });

  it('shows times inside descriptions in the requested zone', () => {
    const resumed = ev('2026-07-01T11:50:00.000Z', 'sequence.resumed', { sequence: 'x', device: 'dev1', nextCycle: 3, of: 3, dueAt: '2026-07-01T11:56:00.000Z' });

    expect(describeEvent(resumed, 'America/Chicago')).toBe('watering resumed after restart dev1 [seq x] at cycle 3/3 (due 2026-07-01 06:56:00)');
  });

  it('shows the first 8 characters of a sequence id', () => {
    const id = '3f9a1c2e-7b4d-4e21-9c0a-5d6e7f801234';

    expect(shortId(id)).toBe('3f9a1c2e');
    expect(describeEvent(ev(NOW.toISOString(), 'sequence.completed', { sequence: id, device: 'dev1', cycles: 1, deliveredMinutes: 5 }))).toBe(
      'watering completed dev1 [seq 3f9a1c2e]: 5 min in 1 cycle(s)',
    );
    const summary = formatSummary(summarize([ev(NOW.toISOString(), 'sequence.started', { sequence: id, device: 'dev1', plannedMinutes: 5 })]), 'UTC');
    expect(summary).toContain('  3f9a1c2e  dev1 ');
    expect(summary).not.toContain(id);
  });

  it('describes storage events', () => {
    expect(describeEvent(ev(NOW.toISOString(), 'state.save_failed', { step: 'waveSending', error: 'database or disk is full' }))).toBe(
      'could not save state (waveSending): database or disk is full',
    );
    expect(describeEvent(ev(NOW.toISOString(), 'state.save_restored', { failures: 3, outageMinutes: 40, lastError: 'database or disk is full' }))).toBe(
      'saving state works again after 40 min (3 failed saves; last error: database or disk is full)',
    );
    expect(describeEvent(ev(NOW.toISOString(), 'storage.imported', { runs: 2, sequences: 1, alerts: 1, auditEvents: 300 }))).toBe(
      "imported the previous version's files: 2 runs, 1 pending sequences, 1 alerts, 300 audit events",
    );
    expect(formatEvent(ev(NOW.toISOString(), 'state.save_restored', { failures: 1, outageMinutes: 1 }), 'UTC')).toMatch(/ ! state\.save_restored/);
  });

  it('falls back to the raw fields for unknown event types', () => {
    expect(describeEvent({ ts: NOW.toISOString(), type: 'future.event' as AuditEvent['type'], x: 1 })).toBe('{"x":1}');
  });
});

describe('summarize', () => {
  it('lists outages (including ongoing ones) and the fate of each sequence', () => {
    const s = summarize(INCIDENT);

    expect(s.outages).toEqual([
      { service: 'bhyve-commands', from: '2026-07-01T06:45:00.000Z', to: '2026-07-01T06:46:00.000Z', minutes: 1, failures: 1, lastError: 'socket did not open within 15s' },
      { service: 'tuya', from: '2026-07-01T09:00:00.000Z', lastError: 'timed out after 20s' },
    ]);
    expect(s.sequences).toEqual([
      { sequence: 's1', device: 'dev1', started: '2026-07-01T06:05:00.000Z', status: 'completed', plannedMinutes: 20, deliveredMinutes: 20, retries: 1, unconfirmed: 0, assumed: 0, resumed: false },
    ]);
    expect(s.uncleanShutdowns).toBe(0);
  });

  it('handles outages and sequences that began before the reviewed period', () => {
    const s = summarize([
      ev('2026-07-01T10:00:00.000Z', 'connection.restored', { service: 'weather', downSince: '2026-07-01T02:00:00.000Z', outageMinutes: 480, failures: 32, lastError: 'HTTP 503' }),
      ev('2026-07-01T10:05:00.000Z', 'sequence.abandoned', { sequence: 'old', device: 'dev1', reason: 'the device was switched off', deliveredMinutes: 10, plannedMinutes: 30 }),
      ev('2026-07-01T10:06:00.000Z', 'service.unclean_shutdown', { lastEvent: 'wave.sent' }),
    ]);

    expect(s.outages[0]).toMatchObject({ service: 'weather', from: '2026-07-01T02:00:00.000Z', minutes: 480 });
    expect(s.sequences[0]).toMatchObject({ sequence: 'old', status: 'abandoned', started: '?', note: 'the device was switched off' });
    expect(s.uncleanShutdowns).toBe(1);
  });

  it('flags sequences that were resumed after a restart, even once completed', () => {
    const s = summarize([
      ev('2026-07-01T06:00:00.000Z', 'sequence.started', { sequence: 'r', device: 'dev1', plannedMinutes: 20 }),
      ev('2026-07-01T06:20:00.000Z', 'sequence.resumed', { sequence: 'r', device: 'dev1' }),
      ev('2026-07-01T06:40:00.000Z', 'sequence.completed', { sequence: 'r', device: 'dev1', deliveredMinutes: 20 }),
    ]);

    expect(s.sequences[0]).toMatchObject({ status: 'completed', resumed: true });
    expect(formatSummary(s, 'UTC')).toContain('COMPLETED   20 of 20 min  (resumed after restart)');
  });

  it('formats a readable report', () => {
    const text = formatSummary(summarize(INCIDENT), 'UTC');

    expect(text).toContain('bhyve-commands 2026-07-01 06:45:00 → 2026-07-01 06:46:00  (1 min, 1 failed attempts)');
    expect(text).toContain('tuya     2026-07-01 09:00:00 → ONGOING');
    expect(text).toContain('s1  dev1         2026-07-01 06:05:00  COMPLETED   20 of 20 min  (1 retries)');
  });
});
