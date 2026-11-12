import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryStore, WateringHistory } from '../../conductor/history.ts';
import { log } from '../../log.ts';
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

describe('FileHistoryStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-history-'));
    path = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty when there is no file yet', async () => {
    const h = await new FileHistoryStore(path).load();

    expect(h.runs).toEqual([]);
  });

  it('round-trips runs through the file', async () => {
    const store = new FileHistoryStore(path);
    const h = new WateringHistory([
      { zoneKey: 'dev1:1', at: minutesAgo(30), minutes: 10 },
      { zoneKey: 'dev1:2', at: minutesAgo(5), minutes: 2.5 },
    ]);

    await store.save(h);
    const loaded = await store.load();

    expect(loaded.runs).toEqual(h.runs);
    expect(loaded.lastRun('dev1:1')?.at).toEqual(minutesAgo(30));
  });

  it('writes readable JSON and leaves no temp file behind', async () => {
    await new FileHistoryStore(path).save(new WateringHistory([{ zoneKey: 'dev1:1', at: NOW, minutes: 10 }]));

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      runs: [{ zoneKey: 'dev1:1', at: '2026-07-01T12:00:00.000Z', minutes: 10 }],
    });
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it.each([
    ['invalid JSON', '{ runs: '],
    ['the wrong shape', JSON.stringify({ runs: [{ zoneKey: 'a', at: 'yesterday', minutes: 5 }] })],
  ])('warns and starts empty on %s', async (_, content) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await writeFile(path, content);

    const h = await new FileHistoryStore(path).load();

    expect(h.runs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'), expect.anything());
  });

  it('propagates errors other than a missing file', async () => {
    // Reading a directory fails with EISDIR.
    await expect(new FileHistoryStore(dir).load()).rejects.toThrow();
  });
});
