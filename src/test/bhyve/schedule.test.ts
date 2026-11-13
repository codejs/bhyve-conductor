import { describe, expect, it } from 'vitest';
import { upcomingRuns } from '../../bhyve/schedule.ts';
import type { BhyveProgram } from '../../bhyve/types.ts';
import { bhyveDevice } from '../utils/conductor.ts';

const TZ = 'America/Chicago';
// Wednesday 2026-07-01 07:00 CDT
const FROM = new Date('2026-07-01T12:00:00Z');
const hoursLater = (h: number) => new Date(FROM.getTime() + h * 3_600_000);
const TO = hoursLater(72); // until Saturday 07:00 CDT

const program = (overrides: Partial<BhyveProgram> = {}): BhyveProgram => ({
  id: 'p1',
  device_id: 'dev1',
  name: 'Lawn',
  program: 'a',
  enabled: true,
  frequency: { type: 'days', days: [0, 1, 2, 3, 4, 5, 6] },
  start_times: ['06:00'],
  run_times: [{ station: 1, run_time: 10 }],
  budget: 100,
  ...overrides,
});

const run = (programs: BhyveProgram[], devices = [bhyveDevice('dev1')], from = FROM, to = TO) =>
  upcomingRuns(programs, devices, from, to, TZ);
const starts = (programs: BhyveProgram[], devices?: Parameters<typeof run>[1]) =>
  run(programs, devices).runs.map((r) => r.start.toISOString());

describe('upcomingRuns', () => {
  describe('frequency', () => {
    it('runs every listed weekday (0 = Sunday), in local time', () => {
      // Daily at 06:00 CDT = 11:00Z. Today's 06:00 has passed; Thu, Fri, Sat remain.
      expect(starts([program()])).toEqual(['2026-07-02T11:00:00.000Z', '2026-07-03T11:00:00.000Z', '2026-07-04T11:00:00.000Z']);
    });

    it('only uses the selected weekdays', () => {
      // Thursday = 4, Saturday = 6
      expect(starts([program({ frequency: { type: 'days', days: [4, 6] } })])).toEqual([
        '2026-07-02T11:00:00.000Z',
        '2026-07-04T11:00:00.000Z',
      ]);
    });

    it('supports odd and even days of the month', () => {
      expect(starts([program({ frequency: { type: 'odd' } })])).toEqual(['2026-07-03T11:00:00.000Z']);
      expect(starts([program({ frequency: { type: 'even' } })])).toEqual(['2026-07-02T11:00:00.000Z', '2026-07-04T11:00:00.000Z']);
    });

    it('supports every-N-days intervals counted from the start date', () => {
      const every3 = program({ frequency: { type: 'interval', interval: 3, interval_start_time: '2026-06-26T05:00:00Z' } });
      // Jun 26 (local) + 3n → Jun 29, Jul 2, Jul 5
      expect(starts([every3])).toEqual(['2026-07-02T11:00:00.000Z']);
    });

    it('does not run an interval program before its start date', () => {
      const future = program({ frequency: { type: 'interval', interval: 1, interval_start_time: '2026-07-03T05:00:00Z' } });
      expect(starts([future])).toEqual(['2026-07-03T11:00:00.000Z', '2026-07-04T11:00:00.000Z']);
    });
  });

  describe('times and durations', () => {
    it('includes every start time of the day', () => {
      const twice = program({ start_times: ['05:30', '19:00'], frequency: { type: 'days', days: [3] } }); // Wednesdays
      // Today 05:30 is past, today 19:00 is ahead; next Wednesday is outside the window.
      expect(starts([twice])).toEqual(['2026-07-02T00:00:00.000Z']);
    });

    it('runs zones back to back, so later zones start after earlier ones finish', () => {
      const multi = program({
        frequency: { type: 'days', days: [4] },
        run_times: [
          { station: 2, run_time: 15 },
          { station: 1, run_time: 10 },
          { station: 3, run_time: 5 },
        ],
      });

      expect(run([multi]).runs.map((r) => [r.station, r.start.toISOString(), r.minutes])).toEqual([
        [2, '2026-07-02T11:00:00.000Z', 15],
        [1, '2026-07-02T11:15:00.000Z', 10],
        [3, '2026-07-02T11:25:00.000Z', 5],
      ]);
    });

    it('applies the seasonal budget to run times and to the zone start offsets', () => {
      const half = program({
        budget: 50,
        frequency: { type: 'days', days: [4] },
        run_times: [
          { station: 1, run_time: 20 },
          { station: 2, run_time: 10 },
        ],
      });

      expect(run([half]).runs.map((r) => [r.station, r.start.toISOString(), r.minutes])).toEqual([
        [1, '2026-07-02T11:00:00.000Z', 10],
        [2, '2026-07-02T11:10:00.000Z', 5],
      ]);
    });

    it('treats a missing budget as 100%', () => {
      const p = program();
      delete p.budget;
      expect(run([p]).runs[0]?.minutes).toBe(10);
    });

    it('keeps the remaining zones of a program that started just before the window', () => {
      // Started 06:50 today; zone 1 (15 min) began before FROM (07:00), zone 2 starts at 07:05.
      const started = program({
        start_times: ['06:50'],
        frequency: { type: 'days', days: [3] },
        run_times: [
          { station: 1, run_time: 15 },
          { station: 2, run_time: 10 },
        ],
      });

      expect(run([started]).runs.map((r) => [r.station, r.start.toISOString()])).toEqual([[2, '2026-07-01T12:05:00.000Z']]);
    });

    it('keeps runs inside [from, to) only', () => {
      // Exactly at FROM is included; exactly at TO is excluded.
      const atEdges = program({ start_times: ['07:00'] });
      expect(starts([atEdges])).toEqual([
        '2026-07-01T12:00:00.000Z',
        '2026-07-02T12:00:00.000Z',
        '2026-07-03T12:00:00.000Z',
      ]);
    });

    it('skips zones with a zero run time', () => {
      const p = program({ run_times: [{ station: 1, run_time: 0 }, { station: 2, run_time: 5 }] });
      expect(new Set(run([p]).runs.map((r) => r.station))).toEqual(new Set([2]));
    });

    it('reads start times in the lawn time zone across a DST change', () => {
      const from = new Date('2026-03-07T12:00:00Z'); // Sat 06:00 CST
      const { runs } = upcomingRuns([program()], [bhyveDevice('dev1')], from, new Date(from.getTime() + 48 * 3_600_000), TZ);

      // Sat 06:00 CST = 12:00Z (included, at `from`); Sun 06:00 CDT = 11:00Z (clocks sprang forward).
      // The window is 48 real hours, ending Mon 12:00Z = 07:00 CDT, so Monday's 06:00 CDT run is in it too.
      expect(runs.map((r) => r.start.toISOString())).toEqual([
        '2026-03-07T12:00:00.000Z',
        '2026-03-08T11:00:00.000Z',
        '2026-03-09T11:00:00.000Z',
      ]);
    });

    it('sorts runs from several programs by time', () => {
      const a = program({ id: 'a', name: 'A', start_times: ['20:00'], frequency: { type: 'days', days: [3] } });
      const b = program({ id: 'b', name: 'B', start_times: ['09:00'], frequency: { type: 'days', days: [3] } });

      expect(run([a, b]).runs.map((r) => r.program)).toEqual(['B', 'A']);
    });
  });

  describe('device state', () => {
    it('ignores disabled programs', () => {
      expect(run([program({ enabled: false })]).runs).toEqual([]);
    });

    it('produces nothing for a device that is switched off', () => {
      expect(run([program()], [bhyveDevice('dev1', { status: { run_mode: 'off' } })]).runs).toEqual([]);
    });

    it('ignores programs of devices not on the account', () => {
      expect(run([program({ device_id: 'gone' })]).runs).toEqual([]);
    });

    it('drops runs during an active rain delay', () => {
      // 30h delay from 07:00 Wed → until 13:00 Thu: Thursday's 06:00 run is cancelled.
      const delayed = bhyveDevice('dev1', { status: { run_mode: 'auto', rain_delay: 30 } });
      expect(starts([program()], [delayed])).toEqual(['2026-07-03T11:00:00.000Z', '2026-07-04T11:00:00.000Z']);
    });

    it('labels runs with the device, station and program name', () => {
      expect(run([program()]).runs[0]).toEqual({
        deviceId: 'dev1',
        station: 1,
        start: new Date('2026-07-02T11:00:00.000Z'),
        minutes: 10,
        program: 'Lawn',
      });
    });

    it('falls back to the program letter when there is no name', () => {
      const p = program();
      delete p.name;
      expect(run([p]).runs[0]?.program).toBe('program A');
    });
  });

  describe('programs it cannot read', () => {
    it.each([
      ['an unknown frequency type', { frequency: { type: 'weekly_smart' } }, 'unsupported frequency type "weekly_smart"'],
      ['an interval without a start', { frequency: { type: 'interval', interval: 2 } }, 'interval frequency without'],
      ['an invalid start time', { start_times: ['25:00'] }, 'unrecognised format (start_times.0'],
      ['a weekday outside 0-6', { frequency: { type: 'days', days: [7] } }, 'unrecognised format (frequency.days.0'],
      ['missing run times', { run_times: undefined }, 'unrecognised format (run_times'],
    ] as const)('skips %s with a warning', (_, overrides, warning) => {
      const { runs, warnings } = run([program(overrides as Partial<BhyveProgram>)]);

      expect(runs).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Skipping Lawn on Timer dev1');
      expect(warnings[0]).toContain(warning);
    });

    it('still reads the other programs', () => {
      const bad = program({ id: 'bad', frequency: { type: 'mystery' } });
      const good = program({ id: 'good', name: 'Good' });

      const { runs, warnings } = run([bad, good]);

      expect(runs).toHaveLength(3);
      expect(warnings).toHaveLength(1);
    });
  });
});
