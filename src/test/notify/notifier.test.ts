import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditType } from '../../audit/audit.ts';
import { VirtualClock } from '../../clock.ts';
import type { NotificationOptions } from '../../conductor/config.ts';
import { log } from '../../log.ts';
import { Notifier, type Notification } from '../../notify/notifier.ts';

const START = new Date('2026-07-01T12:00:00Z'); // 07:00 in Chicago
const MIN = 60_000;

const setup = (options: Partial<NotificationOptions> = {}) => {
  const clock = new VirtualClock(START);
  const sent: Notification[] = [];
  const notifier = new Notifier({
    options: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5, timeZone: 'America/Chicago', ...options },
    deliver: (n) => sent.push(n),
    clock,
  });
  const record = (type: AuditType, data: Record<string, unknown> = {}) => notifier.record(type, data);
  return { clock, sent, notifier, record, texts: () => sent.map((n) => n.text) };
};

describe('Notifier', () => {
  beforeEach(() => {
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  describe('watering', () => {
    it('announces the start with the plan per zone, and the finish', () => {
      const t = setup();

      t.record('sequence.started', {
        device: 'dev1',
        zoneNames: ['Front lawn', 'Back <lawn>'],
        waves: [[], [], []],
        soakMinutes: 30,
        plannedMinutes: 36,
        zones: [
          { name: 'Front lawn', moisturePct: 22.44, minutes: 24 },
          { name: 'Back <lawn>', moisturePct: 25, minutes: 12 },
        ],
      });
      t.record('sequence.finished', { zoneNames: ['Front lawn'], cycles: 3, deliveredMinutes: 36, startedAt: START.toISOString() });

      expect(t.texts()).toEqual([
        '💧 <b>Watering started</b>: Front lawn, Back &lt;lawn&gt;\n36 min in 3 cycles (30 min soak)\n• Front lawn: soil 22.4% → 24 min\n• Back &lt;lawn&gt;: soil 25% → 12 min',
        '✅ <b>Watering finished</b>: Front lawn\n36 min in 3 cycles, started Jul 1, 07:00',
      ]);
      expect(t.sent.map((n) => n.severity)).toEqual(['info', 'info']);
    });

    it('does not announce routine plumbing (sends, confirmations, retries)', () => {
      const t = setup();
      for (const type of ['wave.sent', 'wave.confirmed', 'wave.retry_scheduled', 'wave.deferred', 'wave.send_failed', 'wave.not_started', 'socket.disconnected', 'sequence.completed'] as const) {
        t.record(type, { cycle: 2, of: 3 });
      }

      expect(t.sent).toEqual([]);
    });

    it('announces each cycle when asked to', () => {
      const t = setup({ cycles: true });

      t.record('wave.confirmed', { zoneNames: ['Front'], cycle: 2, of: 3 });
      t.record('wave.confirmed', { zoneNames: ['Front'], cycle: 1, of: 1 }); // single-cycle runs: the start message covers it

      expect(t.texts()).toEqual(['💧 Cycle 2/3 started: Front']);
    });

    it('rates an early stop by its cause: owner intervention is a warning, connectivity is critical', () => {
      const t = setup();

      t.record('sequence.abandoned', { zoneNames: ['Front'], reason: 'the device was switched off', deliveredMinutes: 10, plannedMinutes: 20, cyclesDelivered: 1, of: 2 });
      t.record('sequence.abandoned', { zoneNames: ['Front'], reason: 'gave up on cycle 2/2 after 7 attempt(s) over 30 min: socket down', deliveredMinutes: 10, plannedMinutes: 20, cyclesDelivered: 1, of: 2 });

      expect(t.sent.map((n) => n.severity)).toEqual(['warning', 'critical']);
      expect(t.texts()[1]).toContain('🛑 <b>Watering stopped early</b>: Front\n10 of 20 min delivered (1/2 cycles)\nReason: gave up');
    });

    it('warns about a cycle that could not be confirmed', () => {
      const t = setup();
      t.record('wave.unconfirmed', { zoneNames: ['Front'], cycle: 2, of: 3 });

      expect(t.sent[0]).toMatchObject({ severity: 'warning', text: expect.stringContaining('Couldn’t confirm</b> cycle 2/3 started: Front') });
    });
  });

  describe('connections', () => {
    it('says nothing about a blip that heals within the grace period', async () => {
      const t = setup({ connectionGraceMinutes: 5 });

      t.record('connection.lost', { service: 'tuya', error: 'timed out' });
      await t.clock.advanceBy(4 * MIN);
      t.record('connection.restored', { service: 'tuya', outageMinutes: 4, failures: 1 });
      await t.clock.advanceBy(10 * MIN);

      expect(t.sent).toEqual([]);
    });

    it('reports an outage that outlasts the grace period, then its end', async () => {
      const t = setup({ connectionGraceMinutes: 5 });

      t.record('connection.lost', { service: 'bhyve-commands', error: 'socket did not open within 15s' });
      await t.clock.advanceBy(5 * MIN);
      t.record('connection.restored', { service: 'bhyve-commands', outageMinutes: 135, failures: 9 });

      expect(t.sent.map((n) => [n.type, n.severity])).toEqual([
        ['connection.lost', 'critical'],
        ['connection.restored', 'info'],
      ]);
      expect(t.texts()[0]).toBe(
        '🔴 <b>B-hyve command connection unreachable</b> since Jul 1, 07:00\nWatering commands can’t be sent; pending cycles are being retried.\nError: socket did not open within 15s',
      );
      expect(t.texts()[1]).toBe('🟢 <b>B-hyve command connection reachable again</b> after 2.3 h (9 failed attempts)');
    });

    it('reports immediately with no grace period', () => {
      const t = setup({ connectionGraceMinutes: 0 });
      t.record('connection.lost', { service: 'weather', error: 'HTTP 503' });

      expect(t.sent).toEqual([expect.objectContaining({ type: 'connection.lost', severity: 'warning' })]);
    });

    it('folds per-zone "no sensor data" into a Tuya outage', async () => {
      const t = setup({ connectionGraceMinutes: 5 });

      t.record('connection.lost', { service: 'tuya', error: 'HTTP 500' });
      t.record('zone.no_data', { zone: 'dev1:1', name: 'Front', detail: 'no reading' });
      t.record('zone.no_data', { zone: 'dev1:2', name: 'Back', detail: 'no reading' });
      await t.clock.advanceBy(20 * MIN);
      t.record('connection.restored', { service: 'tuya', outageMinutes: 20, failures: 2 });
      t.record('zone.data_restored', { zone: 'dev1:1', name: 'Front', outageMinutes: 20 });

      expect(t.sent.map((n) => n.type)).toEqual(['connection.lost', 'connection.restored']);
    });

    it('still reports a single sensor going quiet while Tuya is fine', () => {
      const t = setup();
      t.record('zone.no_data', { zone: 'dev1:1', name: 'Front', detail: 'no usable readings (s1: offline)' });
      t.record('zone.data_restored', { zone: 'dev1:1', name: 'Front', outageMinutes: 300 });

      expect(t.texts()).toEqual([
        '📵 <b>No sensor data</b> for Front: not watered until readings return\nno usable readings (s1: offline)',
        '📶 Sensor data back for Front after 5 h',
      ]);
    });

    it('stop() cancels a pending outage report', async () => {
      const t = setup();
      t.record('connection.lost', { service: 'tuya', error: 'x' });
      t.notifier.stop();
      await t.clock.advanceBy(60 * MIN);

      expect(t.sent).toEqual([]);
    });
  });

  describe('health and safety', () => {
    it.each([
      ['moisture.critical_low', { name: 'Front', sensorName: 'Probe A', moisturePct: 12.04, limitPct: 20 }, 'critical', '🏜️ <b>Critically dry</b>: Front\nProbe A reads 12% (alert below 20%)'],
      ['moisture.critical_high', { name: 'Front', sensorName: 'Probe A', moisturePct: 71, limitPct: 60 }, 'critical', '🌊 <b>Waterlogged</b>: Front\nProbe A reads 71% (alert above 60%)\nPossible leak, stuck valve, overwatering or heavy rain.'],
      ['battery.low', { kind: 'sensor', name: 'Probe A', batteryPct: 15 }, 'warning', '🪫 <b>Low battery</b>: Probe A (soil sensor) at 15%. Replace it soon.'],
      ['battery.low', { kind: 'timer', name: 'Hose timer', batteryPct: 9 }, 'warning', '🪫 <b>Low battery</b>: Hose timer (B-hyve timer) at 9%. Replace it soon.'],
      ['device.offline', { name: 'Lawn timer' }, 'critical', '📴 <b>Lawn timer is offline</b>: B-hyve can’t reach it, so no watering is possible.'],
      ['device.online', { name: 'Lawn timer', offlineMinutes: 45 }, 'info', '📶 Lawn timer is back online after 45 min'],
      ['zone.daily_limit_reached', { name: 'Front', moisturePct: 22, thresholdPct: 30, maxMinutesPerDay: 30 }, 'warning', '⏱️ <b>Front is still dry</b> after its full daily allowance (30 min): 22%, threshold 30%\nCheck for a broken valve, clogged nozzle or misplaced sensor, or raise maxMinutesPerDay.'],
      ['service.unclean_shutdown', { lastEvent: 'wave.sent', lastEventAt: START.toISOString() }, 'critical', '💥 <b>Lawn conductor restarted after a crash or power loss</b>\nLast activity: wave.sent at Jul 1, 07:00. Unfinished watering is resumed if still due.'],
      ['poll.failed', { error: 'poll did not finish within 10 min (something is hanging); moving on' }, 'critical', '⏳ <b>Monitoring got stuck</b> and was restarted: poll did not finish within 10 min (something is hanging); moving on'],
      ['state.save_failed', { error: 'ENOSPC' }, 'critical', '💾 <b>Can’t save state</b>: ENOSPC\nCooldowns and pending cycles won’t survive a restart.'],
    ] as const)('%s → %s', (type, data, severity, text) => {
      const t = setup();
      t.record(type, data);

      expect(t.sent).toEqual([expect.objectContaining({ severity, text })]);
    });

    it('does not notify ordinary poll failures (connection events cover them) or dry runs', () => {
      const t = setup();
      t.record('poll.failed', { error: 'Tuya GET /v1.0/token timed out after 20s' });
      t.record('service.started', { dryRun: true, zones: 2 });
      t.record('service.stopped', { reason: 'once' });

      expect(t.sent).toEqual([]);
    });
  });

  it('filters by minimum severity', () => {
    const t = setup({ minSeverity: 'warning', connectionGraceMinutes: 0 });

    t.record('sequence.started', { plannedMinutes: 10, zones: [] });
    t.record('battery.low', { kind: 'sensor', name: 'A', batteryPct: 10 });
    t.record('connection.lost', { service: 'tuya', error: 'x' });
    t.record('connection.restored', { service: 'tuya', outageMinutes: 9, failures: 2 }); // info

    expect(t.sent.map((n) => n.type)).toEqual(['battery.low', 'connection.lost']);
  });

  it('does not send "restored" when the loss was filtered out', () => {
    const t = setup({ minSeverity: 'critical', connectionGraceMinutes: 0 });

    t.record('connection.lost', { service: 'weather', error: 'x' }); // warning: filtered
    t.record('connection.restored', { service: 'weather', outageMinutes: 9, failures: 2 });

    expect(t.sent).toEqual([]);
  });

  it('never announces a "reachable again" without the matching "unreachable"', () => {
    const t = setup({ connectionGraceMinutes: 0 });

    t.record('connection.restored', { service: 'tuya', outageMinutes: 3, failures: 1 }); // no loss on record

    expect(t.sent).toEqual([]);
  });

  it('never throws into the caller (the audit trail and watering must not fail because of a notification)', () => {
    const notifier = new Notifier({
      options: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 0 },
      deliver: () => {
        throw new Error('queue exploded');
      },
    });

    expect(() => notifier.record('battery.low', { kind: 'sensor', name: 'A', batteryPct: 5 })).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('battery.low'), expect.any(Error));
  });
});
