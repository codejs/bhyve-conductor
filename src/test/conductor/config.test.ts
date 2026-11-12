import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConductorConfig, parseConductorConfig } from '../../conductor/config.ts';

const minimalZone = { deviceId: 'dev1', station: 1, sensorIds: ['s1'] };

describe('parseConductorConfig', () => {
  it('fills in built-in defaults', () => {
    expect(parseConductorConfig({ zones: [minimalZone] })).toEqual({
      pollIntervalMinutes: 15,
      dryRun: false,
      zones: [
        {
          key: 'dev1:1',
          name: 'zone 1',
          deviceId: 'dev1',
          station: 1,
          sensorIds: ['s1'],
          thresholdPct: 30,
          runMinutes: 10,
          cooldownMinutes: 240,
          maxMinutesPerDay: 30,
          maxReadingAgeMinutes: 180,
        },
      ],
    });
  });

  it('layers zone settings over file defaults over built-in defaults', () => {
    const cfg = parseConductorConfig({
      pollIntervalMinutes: 5,
      dryRun: true,
      defaults: { thresholdPct: 25, runMinutes: 8 },
      zones: [
        { ...minimalZone, name: 'Front', runMinutes: 12 },
        { ...minimalZone, station: 2 },
      ],
    });

    expect(cfg).toMatchObject({ pollIntervalMinutes: 5, dryRun: true });
    expect(cfg.zones[0]).toMatchObject({ name: 'Front', thresholdPct: 25, runMinutes: 12, cooldownMinutes: 240 });
    expect(cfg.zones[1]).toMatchObject({ key: 'dev1:2', thresholdPct: 25, runMinutes: 8 });
  });

  it('allows a zero cooldown and a zero threshold', () => {
    const cfg = parseConductorConfig({ zones: [{ ...minimalZone, cooldownMinutes: 0, thresholdPct: 0 }] });

    expect(cfg.zones[0]).toMatchObject({ cooldownMinutes: 0, thresholdPct: 0 });
  });

  it('removes duplicate sensor ids within a zone', () => {
    const cfg = parseConductorConfig({ zones: [{ ...minimalZone, sensorIds: ['a', 'b', 'a'] }] });

    expect(cfg.zones[0]?.sensorIds).toEqual(['a', 'b']);
  });

  it.each([
    ['no zones', { zones: [] }, 'zones'],
    ['missing zones', {}, 'zones'],
    ['a zone without sensors', { zones: [{ ...minimalZone, sensorIds: [] }] }, 'zones.0.sensorIds'],
    ['a station of 0', { zones: [{ ...minimalZone, station: 0 }] }, 'zones.0.station'],
    ['a fractional station', { zones: [{ ...minimalZone, station: 1.5 }] }, 'zones.0.station'],
    ['an empty device id', { zones: [{ ...minimalZone, deviceId: '' }] }, 'zones.0.deviceId'],
    ['a threshold over 100', { zones: [{ ...minimalZone, thresholdPct: 101 }] }, 'zones.0.thresholdPct'],
    ['a run longer than B-hyve allows', { zones: [{ ...minimalZone, runMinutes: 241 }] }, 'zones.0.runMinutes'],
    ['a zero-minute run', { defaults: { runMinutes: 0 }, zones: [minimalZone] }, 'defaults.runMinutes'],
    ['a negative cooldown', { zones: [{ ...minimalZone, cooldownMinutes: -1 }] }, 'zones.0.cooldownMinutes'],
    ['a zero poll interval', { pollIntervalMinutes: 0, zones: [minimalZone] }, 'pollIntervalMinutes'],
    ['a string where a number belongs', { zones: [{ ...minimalZone, thresholdPct: '30' }] }, 'zones.0.thresholdPct'],
    ['the same zone twice', { zones: [minimalZone, { ...minimalZone, sensorIds: ['s2'] }] }, 'duplicate zone dev1:1'],
    ['a non-object', 'zones', '(root)'],
  ])('rejects %s', (_, raw, mention) => {
    expect(() => parseConductorConfig(raw)).toThrow(/^Invalid conductor config:/);
    expect(() => parseConductorConfig(raw)).toThrow(mention);
  });

  it('accepts the shipped example config', async () => {
    const cfg = await loadConductorConfig(join(import.meta.dirname, '../../../conductor.example.json'));

    expect(cfg.zones.map((z) => z.key)).toEqual(['bhyve-device-id:1', 'bhyve-device-id:2']);
  });
});

describe('loadConductorConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and validates a JSON file', async () => {
    const path = join(dir, 'conductor.json');
    await writeFile(path, JSON.stringify({ zones: [minimalZone] }));

    await expect(loadConductorConfig(path)).resolves.toMatchObject({ zones: [{ key: 'dev1:1' }] });
  });

  it('explains a missing file', async () => {
    await expect(loadConductorConfig(join(dir, 'nope.json'))).rejects.toThrow(/Cannot read conductor config .*nope\.json/);
  });

  it('explains invalid JSON', async () => {
    const path = join(dir, 'conductor.json');
    await writeFile(path, '{ zones: ');

    await expect(loadConductorConfig(path)).rejects.toThrow('is not valid JSON');
  });
});
