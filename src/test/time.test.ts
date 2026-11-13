import { describe, expect, it } from 'vitest';
import { addDays, assertTimeZone, daysBetween, localParts, zonedTime } from '../time.ts';

const CHICAGO = 'America/Chicago';
const at = (y: number, m: number, d: number, h: number, min: number, tz = CHICAGO) =>
  zonedTime({ year: y, month: m, day: d }, h, min, tz).toISOString();

describe('zonedTime', () => {
  it.each([
    ['summer (CDT, UTC-5)', [2026, 7, 1, 6, 0], '2026-07-01T11:00:00.000Z'],
    ['winter (CST, UTC-6)', [2026, 1, 15, 6, 0], '2026-01-15T12:00:00.000Z'],
    ['midnight', [2026, 7, 1, 0, 0], '2026-07-01T05:00:00.000Z'],
    ['late evening', [2026, 7, 1, 23, 45], '2026-07-02T04:45:00.000Z'],
    ['spring-forward day, after the switch', [2026, 3, 8, 6, 0], '2026-03-08T11:00:00.000Z'],
    ['spring-forward day, before the switch', [2026, 3, 8, 1, 0], '2026-03-08T07:00:00.000Z'],
    ['fall-back day, after the switch', [2026, 11, 1, 6, 0], '2026-11-01T12:00:00.000Z'],
  ] as const)('converts local wall time to UTC: %s', (_, [y, m, d, h, min], expected) => {
    expect(at(y, m, d, h, min)).toBe(expected);
  });

  it('moves a time inside the spring-forward gap an hour later (02:30 → 03:30 CDT)', () => {
    expect(at(2026, 3, 8, 2, 30)).toBe('2026-03-08T08:30:00.000Z');
  });

  it('resolves an ambiguous fall-back time to its first occurrence (01:30 CDT)', () => {
    expect(at(2026, 11, 1, 1, 30)).toBe('2026-11-01T06:30:00.000Z');
  });

  it('handles zones without DST', () => {
    expect(at(2026, 7, 1, 6, 0, 'America/Phoenix')).toBe('2026-07-01T13:00:00.000Z');
    expect(at(2026, 1, 1, 6, 0, 'America/Phoenix')).toBe('2026-01-01T13:00:00.000Z');
  });

  it('round-trips through localParts', () => {
    for (const tz of [CHICAGO, 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu']) {
      const t = zonedTime({ year: 2026, month: 5, day: 17 }, 6, 15, tz);
      expect(localParts(t, tz)).toMatchObject({ year: 2026, month: 5, day: 17, hour: 6, minute: 15 });
    }
  });
});

describe('localParts', () => {
  it('gives the wall-clock date, time and weekday in the zone', () => {
    // 04:30Z on Jul 1 is still Tuesday Jun 30 in Chicago.
    expect(localParts(new Date('2026-07-01T04:30:00Z'), CHICAGO)).toEqual({
      year: 2026,
      month: 6,
      day: 30,
      hour: 23,
      minute: 30,
      second: 0,
      weekday: 2,
    });
  });

  it('reports midnight as hour 0, not 24', () => {
    expect(localParts(new Date('2026-07-01T05:00:00Z'), CHICAGO).hour).toBe(0);
  });
});

describe('civil date arithmetic', () => {
  it('adds days across month and leap-year boundaries, with the weekday', () => {
    expect(addDays({ year: 2026, month: 2, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 1, weekday: 0 });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29, weekday: 2 });
    expect(addDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({ year: 2025, month: 12, day: 31, weekday: 3 });
  });

  it('counts days between dates, ignoring DST', () => {
    expect(daysBetween({ year: 2026, month: 1, day: 1 }, { year: 2026, month: 3, day: 1 })).toBe(59);
    expect(daysBetween({ year: 2026, month: 3, day: 7 }, { year: 2026, month: 3, day: 9 })).toBe(2);
    expect(daysBetween({ year: 2026, month: 3, day: 9 }, { year: 2026, month: 3, day: 7 })).toBe(-2);
  });
});

describe('assertTimeZone', () => {
  it('accepts IANA zones and rejects unknown ones', () => {
    expect(() => assertTimeZone(CHICAGO)).not.toThrow();
    expect(() => assertTimeZone('Mars/Olympus_Mons')).toThrow(RangeError);
  });
});
