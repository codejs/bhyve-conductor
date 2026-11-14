import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLegacyStateFile } from '../../conductor/state.ts';
import { log } from '../../log.ts';
import { minutesAgo, NOW } from '../utils/conductor.ts';

/** The state file as versions before the database wrote it (JSON, ISO times). */
const legacyFile = {
  runs: [
    { zoneKey: 'dev1:1', at: minutesAgo(30).toISOString(), minutes: 10 },
    { zoneKey: 'dev1:2', at: minutesAgo(5).toISOString(), minutes: 2.5 },
  ],
  sequences: [
    {
      id: 'seq1',
      deviceId: 'dev1',
      waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]],
      soakMinutes: 30,
      zoneNames: ['Front'],
      createdAt: minutesAgo(45).toISOString(),
      nextWave: 1,
      dueAt: minutesAgo(5).toISOString(),
      attempts: 2,
      inFlight: { wave: 1, since: minutesAgo(1).toISOString() },
    },
  ],
  alerts: { 'battery:sensor:s1': { state: 'low', since: '2026-07-01T10:00:00.000Z' } },
};

describe('readLegacyStateFile', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-state-'));
    path = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is empty when there is no file', async () => {
    const state = await readLegacyStateFile(path);

    expect(state.history.runs).toEqual([]);
    expect(state.sequences).toEqual([]);
    expect(state.alerts).toEqual({});
  });

  it('reads history, pending sequences (with an in-flight marker) and alerts', async () => {
    await writeFile(path, JSON.stringify(legacyFile));

    const state = await readLegacyStateFile(path);

    expect(state.history.runs).toEqual([
      { zoneKey: 'dev1:1', at: minutesAgo(30), minutes: 10 },
      { zoneKey: 'dev1:2', at: minutesAgo(5), minutes: 2.5 },
    ]);
    expect(state.sequences).toEqual([
      {
        id: 'seq1',
        deviceId: 'dev1',
        waves: [[{ station: 1, runTime: 10 }], [{ station: 1, runTime: 10 }]],
        soakMinutes: 30,
        zoneNames: ['Front'],
        createdAt: minutesAgo(45),
        nextWave: 1,
        dueAt: minutesAgo(5),
        attempts: 2,
        inFlight: { wave: 1, since: minutesAgo(1) },
      },
    ]);
    expect(state.alerts).toEqual(legacyFile.alerts);
  });

  it('reads state files written before pending sequences and alerts were saved', async () => {
    await writeFile(path, JSON.stringify({ runs: [{ zoneKey: 'dev1:1', at: NOW.toISOString(), minutes: 10 }] }));

    const state = await readLegacyStateFile(path);

    expect(state.history.runs).toHaveLength(1);
    expect(state.sequences).toEqual([]);
    expect(state.alerts).toEqual({});
  });

  it.each([
    ['invalid JSON', '{ runs: '],
    ['the wrong shape', JSON.stringify({ runs: [{ zoneKey: 'a', at: 'yesterday', minutes: 5 }] })],
    ['a malformed sequence', JSON.stringify({ runs: [], sequences: [{ id: 'x', waves: [] }] })],
  ])('warns and reads it as empty on %s', async (_, content) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await writeFile(path, content);

    const state = await readLegacyStateFile(path);

    expect(state.history.runs).toEqual([]);
    expect(state.sequences).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'), expect.anything());
  });

  it('propagates errors other than a missing file', async () => {
    // Reading a directory fails with EISDIR.
    await expect(readLegacyStateFile(dir)).rejects.toThrow();
  });
});
