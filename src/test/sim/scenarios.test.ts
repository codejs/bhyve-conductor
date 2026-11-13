import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../audit/audit.ts';
import { summarize } from '../../audit/report.ts';
import { log } from '../../log.ts';
import { runScenario, type SimResult } from '../../sim/runner.ts';
import { SCENARIOS, scenarioById } from '../../sim/scenarios.ts';

/**
 * End-to-end: every simulation scenario runs the real conductor against the simulated garden, and its
 * "what to look for" list is checked here, plus invariants that must hold in every scenario.
 */

const results = new Map<string, SimResult>();
const run = (id: string): SimResult => {
  const r = results.get(id);
  if (!r) throw new Error(`scenario ${id} did not run`);
  return r;
};
const types = (r: SimResult) => r.events.map((e) => e.type);
const ofType = (r: SimResult, type: AuditEvent['type']) => r.events.filter((e) => e.type === type);
const notified = (r: SimResult) => r.notifications.map((n) => n.type);
/** Local (Chicago) clock time of an ISO timestamp, "HH:MM". */
const hhmm = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

beforeAll(async () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  for (const s of SCENARIOS) results.set(s.id, await runScenario(s));
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(log, 'error').mockImplementation(() => {});
});

describe('every scenario', () => {
  it.each(SCENARIOS.map((s) => s.id))('%s: never delivers a cycle twice', (id) => {
    const delivered = new Map<string, number>();
    for (const e of run(id).events) {
      if (['wave.confirmed', 'wave.unconfirmed', 'wave.assumed_delivered'].includes(e.type)) {
        const key = `${String(e.sequence)}#${String(e.cycle)}`;
        delivered.set(key, (delivered.get(key) ?? 0) + 1);
      }
    }
    expect([...delivered.values()].every((n) => n === 1)).toBe(true);
  });

  it.each(SCENARIOS.map((s) => s.id))('%s: every watering ends (completed or abandoned), none left hanging', (id) => {
    const seqs = summarize(run(id).events).sequences;
    expect(seqs.every((q) => q.status === 'completed' || q.status === 'abandoned')).toBe(true);
  });

  it.each(SCENARIOS.map((s) => s.id))('%s: notifications are never sent before their event', (id) => {
    for (const n of run(id).notifications) expect(Date.parse(n.sentAt)).toBeGreaterThanOrEqual(Date.parse(n.ts));
  });

  it('every scenario is listed once', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(scenarioById('crash-mid-soak')?.title).toContain('crash');
  });
});

describe('scenario expectations', () => {
  it('normal-watering: one 3-cycle watering, only start and finish notified', () => {
    const r = run('normal-watering');

    expect(summarize(r.events).sequences).toEqual([expect.objectContaining({ status: 'completed', deliveredMinutes: 24 })]);
    expect(ofType(r, 'wave.confirmed')).toHaveLength(3);
    expect(hhmm(ofType(r, 'sequence.finished')[0]?.ts ?? '')).toBe('07:04');
    expect(notified(r)).toEqual(['service.started', 'sequence.started', 'sequence.finished']);
  });

  it('rain-forecast: waits for the forecast rain and never waters', () => {
    const r = run('rain-forecast');
    const front = ofType(r, 'zone.decision').filter((e) => e.name === 'Front lawn').map((e) => e.reason);

    expect(front).toEqual(['forecast-covered', 'moist']);
    expect(types(r)).not.toContain('sequence.started');
  });

  it('bhyve-socket-outage: retries cycle 2 until the socket is back; outage notified after the grace period', () => {
    const r = run('bhyve-socket-outage');

    expect(ofType(r, 'wave.retry_scheduled').map((e) => e.inMinutes)).toEqual([1, 2, 5, 10]);
    expect(ofType(r, 'wave.confirmed').map((e) => [e.cycle, hhmm(e.ts)])).toEqual([
      [1, '06:00'],
      [2, '06:46'],
      [3, '07:14'],
    ]);
    const lost = r.notifications.find((n) => n.type === 'connection.lost');
    expect([hhmm(lost?.ts ?? ''), hhmm(lost?.sentAt ?? '')]).toEqual(['06:28', '06:33']);
    expect(notified(r)).toContain('connection.restored');
  });

  it('bhyve-long-outage: gives up after the retry window, re-waters after the cooldown', () => {
    const r = run('bhyve-long-outage');
    const [abandoned, retried] = summarize(r.events).sequences;

    expect(abandoned).toMatchObject({ status: 'abandoned', deliveredMinutes: 8, note: expect.stringContaining('gave up on cycle 2/3') });
    expect(hhmm(ofType(r, 'sequence.abandoned')[0]?.ts ?? '')).toBe('06:58');
    expect(retried).toMatchObject({ status: 'completed' });
    expect(hhmm(retried?.started ?? '')).toBe('10:00');
    expect(r.notifications.find((n) => n.type === 'sequence.abandoned')?.severity).toBe('critical');
  });

  it('tuya-outage: no data means no watering; one outage message, not one per zone', () => {
    const r = run('tuya-outage');

    expect(hhmm(ofType(r, 'sequence.started')[0]?.ts ?? '')).toBe('09:15');
    expect(ofType(r, 'zone.no_data')).toHaveLength(2);
    expect(notified(r).filter((t) => t.startsWith('connection.') || t.startsWith('zone.'))).toEqual(['connection.lost', 'connection.restored']);
  });

  it('crash-mid-soak: resumes on schedule after the crash, exactly 3 cycles in total', () => {
    const r = run('crash-mid-soak');

    expect(ofType(r, 'service.unclean_shutdown')[0]).toMatchObject({ lastEvent: 'wave.confirmed' });
    expect(ofType(r, 'sequence.resumed')[0]).toMatchObject({ nextCycle: 3 });
    expect(ofType(r, 'wave.confirmed').map((e) => hhmm(e.ts))).toEqual(['06:00', '06:28', '06:56']);
    // the crash message says it's back; no separate "started" message right after it
    expect(notified(r)).toEqual(['service.started', 'sequence.started', 'service.unclean_shutdown', 'sequence.resumed', 'sequence.finished']);
  });

  it('owner-switches-off: stops without sending another cycle; a warning, not critical', () => {
    const r = run('owner-switches-off');

    expect(ofType(r, 'wave.sent')).toHaveLength(1);
    expect(ofType(r, 'sequence.abandoned')[0]?.reason).toBe('the device was switched off');
    expect(r.notifications.find((n) => n.type === 'sequence.abandoned')?.severity).toBe('warning');
  });

  it('command-lost: re-sends only after the device was idle twice; delivered once', () => {
    const r = run('command-lost');

    expect(types(r).filter((t) => t.startsWith('wave.')).slice(0, 5)).toEqual([
      'wave.sent',
      'wave.not_started',
      'wave.retry_scheduled',
      'wave.sent',
      'wave.confirmed',
    ]);
    expect(summarize(r.events).sequences[0]).toMatchObject({ status: 'completed', retries: 1 });
  });

  it('unconfirmed-command: counts the unconfirmable cycle as delivered and warns', () => {
    const r = run('unconfirmed-command');

    expect(ofType(r, 'wave.unconfirmed')).toEqual([expect.objectContaining({ cycle: 1 })]);
    expect(ofType(r, 'wave.sent').filter((e) => e.cycle === 1)).toHaveLength(1);
    expect(r.notifications.find((n) => n.type === 'wave.unconfirmed')?.severity).toBe('warning');
  });

  it('low-batteries: low and OK for both the sensor and the hose timer', () => {
    const r = run('low-batteries');

    expect(ofType(r, 'battery.low').map((e) => [e.kind, e.id])).toEqual([
      ['timer', 'hose-1'],
      ['sensor', 'front-a'],
    ]);
    expect(ofType(r, 'battery.ok').map((e) => e.id)).toEqual(['front-a', 'hose-1']);
  });

  it('critical-moisture: critically dry while blocked by the rain delay, then waterlogged, then normal', () => {
    const r = run('critical-moisture');

    expect(ofType(r, 'zone.decision').find((e) => e.name === 'Back lawn')?.reason).toBe('rain-delay');
    expect(ofType(r, 'moisture.critical_low').map((e) => e.sensor)).toEqual(['back-a']);
    expect(ofType(r, 'moisture.critical_high')).toHaveLength(3);
    expect(ofType(r, 'moisture.normal')).toHaveLength(3);
    expect(r.notifications.filter((n) => n.severity === 'critical')).toHaveLength(4);
    expect(types(r)).not.toContain('sequence.started');
  });

  it('controller-offline: no watering while offline; waters once it is back', () => {
    const r = run('controller-offline');

    expect(ofType(r, 'device.offline')).toHaveLength(1);
    expect(ofType(r, 'device.online')[0]).toMatchObject({ offlineMinutes: 135 });
    expect(hhmm(ofType(r, 'sequence.started')[0]?.ts ?? '')).toBe('08:15');
  });

  it('broken-valve: waters the full allowance, then flags that the zone is still dry', () => {
    const r = run('broken-valve');

    expect(summarize(r.events).sequences.map((q) => q.status)).toEqual(['completed', 'completed']);
    expect(ofType(r, 'zone.daily_limit_reached')).toEqual([expect.objectContaining({ name: 'Front lawn', maxMinutesPerDay: 48 })]);
    expect(notified(r)).toContain('zone.daily_limit_reached');
  });

  it('sensor-dies: battery low, then no data once stale, then both recover', () => {
    const r = run('sensor-dies');

    expect(types(r).filter((t) => t.startsWith('battery.') || t.startsWith('zone.no') || t.startsWith('zone.data'))).toEqual([
      'battery.low',
      'zone.no_data',
      'battery.ok',
      'zone.data_restored',
    ]);
    expect(notified(r)).toContain('zone.no_data'); // Tuya itself was fine, so this one is not folded
  });

  it('monitoring-stuck: the watchdog recovers the loop and watering still happens', () => {
    const r = run('monitoring-stuck');

    expect(ofType(r, 'poll.failed')[0]).toMatchObject({ error: expect.stringContaining('did not finish within 10 min') });
    expect(hhmm(ofType(r, 'poll.failed')[0]?.ts ?? '')).toBe('06:25');
    expect(hhmm(ofType(r, 'sequence.started')[0]?.ts ?? '')).toBe('06:40');
    expect(r.notifications.find((n) => n.type === 'poll.failed')?.severity).toBe('critical');
  });
});
