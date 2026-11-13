import { describe, expect, it } from 'vitest';
import { WateringHistory } from '../../conductor/history.ts';
import { minutesAgo, NOW } from '../utils/conductor.ts';

const DAY_MIN = 24 * 60;

describe('WateringHistory', () => {
  it('finds the latest run per zone regardless of insertion order', () => {
    const h = new WateringHistory([
      { zoneKey: 'a', at: minutesAgo(10), minutes: 5 },
      { zoneKey: 'a', at: minutesAgo(60), minutes: 7 },
      { zoneKey: 'b', at: minutesAgo(1), minutes: 9 },
    ]);
    h.record({ zoneKey: 'a', at: minutesAgo(120), minutes: 3 });

    expect(h.lastRun('a')?.minutes).toBe(5);
    expect(h.lastRun('b')?.minutes).toBe(9);
    expect(h.lastRun('c')).toBeUndefined();
  });

  it('sums minutes over the rolling 24 hours for one zone', () => {
    const h = new WateringHistory([
      { zoneKey: 'a', at: minutesAgo(10), minutes: 5 },
      { zoneKey: 'a', at: minutesAgo(DAY_MIN - 1), minutes: 7 },
      { zoneKey: 'a', at: minutesAgo(DAY_MIN), minutes: 100 }, // exactly 24h ago: out of the window
      { zoneKey: 'b', at: minutesAgo(10), minutes: 100 },
    ]);

    expect(h.minutesInLastDay('a', NOW)).toBe(12);
    expect(h.minutesInLastDay('c', NOW)).toBe(0);
  });

  it('does not count runs after `now`', () => {
    const h = new WateringHistory([{ zoneKey: 'a', at: minutesAgo(-5), minutes: 5 }]);

    expect(h.minutesInLastDay('a', NOW)).toBe(0);
  });

  it('prunes runs older than both a day and the given window', () => {
    const h = new WateringHistory([
      { zoneKey: 'a', at: minutesAgo(3 * DAY_MIN), minutes: 1 },
      { zoneKey: 'a', at: minutesAgo(DAY_MIN + 60), minutes: 2 },
      { zoneKey: 'a', at: minutesAgo(60), minutes: 3 },
    ]);

    h.prune(NOW, 0); // a short cooldown still keeps a full day for the daily limit
    expect(h.runs.map((r) => r.minutes)).toEqual([3]);

    const h2 = new WateringHistory([
      { zoneKey: 'a', at: minutesAgo(3 * DAY_MIN), minutes: 1 },
      { zoneKey: 'a', at: minutesAgo(DAY_MIN + 60), minutes: 2 },
    ]);
    h2.prune(NOW, 2 * DAY_MIN * 60_000); // a long cooldown keeps runs it still depends on
    expect(h2.runs.map((r) => r.minutes)).toEqual([2]);
  });
});
