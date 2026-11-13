import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WateringHistory } from '../../conductor/history.ts';
import { FileStateStore, type PendingSequence } from '../../conductor/state.ts';
import { log } from '../../log.ts';
import { minutesAgo, NOW } from '../utils/conductor.ts';

const sequence = (overrides: Partial<PendingSequence> = {}): PendingSequence => ({
  id: 'seq1',
  deviceId: 'dev1',
  waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]],
  soakMinutes: 30,
  createdAt: minutesAgo(45),
  nextWave: 1,
  dueAt: minutesAgo(5),
  attempts: 2,
  ...overrides,
});

describe('FileStateStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-state-'));
    path = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty when there is no file yet', async () => {
    const state = await new FileStateStore(path).load();

    expect(state.history.runs).toEqual([]);
    expect(state.sequences).toEqual([]);
  });

  it('round-trips history and pending sequences, including an in-flight marker', async () => {
    const store = new FileStateStore(path);
    const history = new WateringHistory([
      { zoneKey: 'dev1:1', at: minutesAgo(30), minutes: 10 },
      { zoneKey: 'dev1:2', at: minutesAgo(5), minutes: 2.5 },
    ]);
    const sequences = [sequence(), sequence({ id: 'seq2', deviceId: 'dev2', inFlight: { wave: 1, since: minutesAgo(1) } })];

    const alerts = { 'battery:sensor:s1': { state: 'low', since: '2026-07-01T10:00:00.000Z' } };
    await store.save({ history, sequences: [...sequences, sequence({ id: 'seq3', deviceId: 'dev3', zoneNames: ['Front'] })], alerts });
    const loaded = await store.load();

    expect(loaded.history.runs).toEqual(history.runs);
    expect(loaded.sequences).toEqual([...sequences, sequence({ id: 'seq3', deviceId: 'dev3', zoneNames: ['Front'] })]);
    expect(loaded.alerts).toEqual(alerts);
  });

  it('reads state files written before pending sequences were saved', async () => {
    await writeFile(path, JSON.stringify({ runs: [{ zoneKey: 'dev1:1', at: NOW.toISOString(), minutes: 10 }] }));

    const state = await new FileStateStore(path).load();

    expect(state.history.runs).toHaveLength(1);
    expect(state.sequences).toEqual([]);
    expect(state.alerts).toEqual({});
  });

  it('writes readable JSON and leaves no temp file behind', async () => {
    await new FileStateStore(path).save({
      history: new WateringHistory([{ zoneKey: 'dev1:1', at: NOW, minutes: 10 }]),
      sequences: [],
      alerts: {},
    });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      runs: [{ zoneKey: 'dev1:1', at: '2026-07-01T12:00:00.000Z', minutes: 10 }],
      sequences: [],
      alerts: {},
    });
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it.each([
    ['invalid JSON', '{ runs: '],
    ['the wrong shape', JSON.stringify({ runs: [{ zoneKey: 'a', at: 'yesterday', minutes: 5 }] })],
    ['a malformed sequence', JSON.stringify({ runs: [], sequences: [{ id: 'x', waves: [] }] })],
  ])('warns and starts empty on %s', async (_, content) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await writeFile(path, content);

    const state = await new FileStateStore(path).load();

    expect(state.history.runs).toEqual([]);
    expect(state.sequences).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'), expect.anything());
  });

  it('propagates errors other than a missing file', async () => {
    // Reading a directory fails with EISDIR.
    await expect(new FileStateStore(dir).load()).rejects.toThrow();
  });
});
