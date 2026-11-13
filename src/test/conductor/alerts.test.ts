import { describe, expect, it } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import { AlertTracker } from '../../conductor/alerts.ts';
import type { ZoneDecision } from '../../conductor/plan.ts';
import type { MoistureReading } from '../../sensors/types.ts';
import { bhyveDevice, minutesAgo, NOW, reading, zone } from '../utils/conductor.ts';

const setup = (initial = {}) => {
  let now = NOW;
  const audit = new MemoryAuditLog(() => now);
  const tracker = new AlertTracker(audit, { lowBatteryPct: 20, deviceCheckMinutes: 60 }, () => now, initial);
  return {
    audit,
    tracker,
    types: () => audit.events.map((e) => e.type),
    advance: (min: number) => {
      now = new Date(now.getTime() + min * 60_000);
    },
    now: () => now,
  };
};
const map = (...rs: MoistureReading[]) => new Map(rs.map((r) => [r.sensorId, r]));
// zone fixture: threshold 30, target 40, critical low 20, critical high 60
const Z = zone({ name: 'Front', sensorIds: ['s1', 's2'] });

describe('AlertTracker', () => {
  describe('sensor batteries', () => {
    it('reports low once, and ok only after a real recovery (hysteresis)', () => {
      const t = setup();

      const changes = [25, 20, 15, 18, 25, 29, 30, 12].map((battery) =>
        t.tracker.checkReadings([Z], map(reading('s1', 35, { batteryPct: battery }))),
      );

      expect(changes).toEqual([false, true, false, false, false, false, true, true]);
      expect(t.audit.events.map((e) => [e.type, e.batteryPct])).toEqual([
        ['battery.low', 20],
        ['battery.ok', 30],
        ['battery.low', 12],
      ]);
      expect(t.audit.events[0]).toMatchObject({ kind: 'sensor', id: 's1', name: 'Sensor s1', thresholdPct: 20 });
    });

    it('checks batteries even on stale readings (the battery may be why it went quiet)', () => {
      const t = setup();
      t.tracker.checkReadings([Z], map(reading('s1', 35, { batteryPct: 3, at: minutesAgo(900) })));

      expect(t.types()).toEqual(['battery.low']);
    });
  });

  describe('critical moisture', () => {
    it('alerts on each sensor outside the zone limits, once, and when it recovers', () => {
      const t = setup();

      t.tracker.checkReadings([Z], map(reading('s1', 19.5), reading('s2', 35)));
      t.tracker.checkReadings([Z], map(reading('s1', 15), reading('s2', 35)));
      t.advance(90);
      t.tracker.checkReadings([Z], map(reading('s1', 21, { at: NOW }), reading('s2', 35))); // inside, but within hysteresis
      t.tracker.checkReadings([Z], map(reading('s1', 22, { at: t.now() }), reading('s2', 35, { at: t.now() })));

      expect(t.audit.events).toEqual([
        expect.objectContaining({ type: 'moisture.critical_low', zone: 'dev1:1', name: 'Front', sensor: 's1', moisturePct: 19.5, limitPct: 20 }),
        expect.objectContaining({ type: 'moisture.normal', sensor: 's1', moisturePct: 22, was: 'low', minutes: 90 }),
      ]);
    });

    it('alerts on waterlogged soil', () => {
      const t = setup();

      t.tracker.checkReadings([Z], map(reading('s2', 61)));
      t.tracker.checkReadings([Z], map(reading('s2', 59))); // within hysteresis
      t.tracker.checkReadings([Z], map(reading('s2', 58)));

      expect(t.audit.events.map((e) => [e.type, e.moisturePct])).toEqual([
        ['moisture.critical_high', 61],
        ['moisture.normal', 58],
      ]);
    });

    it('goes straight from critically low to critically high (e.g. a burst pipe after a drought)', () => {
      const t = setup();

      t.tracker.checkReadings([Z], map(reading('s1', 10)));
      t.tracker.checkReadings([Z], map(reading('s1', 80)));

      expect(t.types()).toEqual(['moisture.critical_low', 'moisture.critical_high']);
    });

    it('ignores readings that cannot be trusted (stale, offline, invalid)', () => {
      const t = setup();

      t.tracker.checkReadings(
        [Z],
        map(reading('s1', 2, { at: minutesAgo(500) }), reading('s2', 95, { online: false })),
      );

      expect(t.audit.events).toEqual([]);
    });

    it('uses each zone’s own limits for a sensor shared by two zones', () => {
      const t = setup();
      const strict = zone({ station: 2, name: 'Strict', sensorIds: ['s1'], criticalLowPct: 28, thresholdPct: 30 });

      t.tracker.checkReadings([Z, strict], map(reading('s1', 25)));

      expect(t.audit.events.map((e) => [e.type, e.name])).toEqual([['moisture.critical_low', 'Strict']]);
    });
  });

  describe('controllers', () => {
    it('reports a controller going offline and back online with the duration', () => {
      const t = setup();

      t.tracker.checkDevices([bhyveDevice('dev1', { is_connected: false })]);
      t.tracker.checkDevices([bhyveDevice('dev1', { is_connected: false })]);
      t.advance(125);
      t.tracker.checkDevices([bhyveDevice('dev1')]);

      expect(t.audit.events).toEqual([
        expect.objectContaining({ type: 'device.offline', device: 'dev1', name: 'Timer dev1' }),
        expect.objectContaining({ type: 'device.online', device: 'dev1', offlineMinutes: 125 }),
      ]);
    });

    it('watches hose-timer batteries', () => {
      const t = setup();

      t.tracker.checkDevices([bhyveDevice('dev1', { battery: { percent: 14 } })]);
      t.tracker.checkDevices([bhyveDevice('dev1', { battery: { percent: 95 } })]);

      expect(t.audit.events).toEqual([
        expect.objectContaining({ type: 'battery.low', kind: 'timer', id: 'dev1', batteryPct: 14 }),
        expect.objectContaining({ type: 'battery.ok', kind: 'timer', id: 'dev1', batteryPct: 95 }),
      ]);
    });

    it('ignores controllers without a battery (mains powered)', () => {
      const t = setup();
      t.tracker.checkDevices([bhyveDevice('dev1')]);

      expect(t.audit.events).toEqual([]);
    });
  });

  describe('zones still dry after the daily allowance', () => {
    const decision = (reason: ZoneDecision['reason']): ZoneDecision => ({
      zone: Z,
      action: reason === 'daily-limit' ? 'skip' : 'none',
      reason,
      reading: reading('s1', 22.04),
      detail: '',
    });

    it('reports it once per episode', () => {
      const t = setup();

      const changes = [decision('daily-limit'), decision('daily-limit'), decision('no-data'), decision('moist'), decision('daily-limit')].map((d) =>
        t.tracker.checkDecisions([d]),
      );

      expect(changes).toEqual([true, false, false, true, true]);
      expect(t.audit.events).toEqual([
        expect.objectContaining({ type: 'zone.daily_limit_reached', zone: 'dev1:1', moisturePct: 22, maxMinutesPerDay: 30, thresholdPct: 30 }),
        expect.objectContaining({ type: 'zone.daily_limit_reached' }),
      ]);
    });
  });

  describe('persistence', () => {
    it('does not report conditions again after a restart, but does report their end', () => {
      const first = setup();
      first.tracker.checkReadings([Z], map(reading('s1', 10, { batteryPct: 5 })));
      first.tracker.checkDevices([bhyveDevice('dev1', { is_connected: false })]);
      const saved = first.tracker.state;

      const restarted = setup(saved);
      restarted.tracker.checkReadings([Z], map(reading('s1', 10, { batteryPct: 5 })));
      restarted.tracker.checkDevices([bhyveDevice('dev1', { is_connected: false })]);
      expect(restarted.audit.events).toEqual([]);

      restarted.tracker.checkReadings([Z], map(reading('s1', 35, { batteryPct: 100 })));
      expect(restarted.types()).toEqual(['battery.ok', 'moisture.normal']);
      expect(Object.keys(saved).sort()).toEqual(['battery:sensor:s1', 'device:dev1', 'moisture:dev1:1:s1']);
    });
  });
});
