import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertForecastReady, loadConductorConfig, parseConductorConfig } from '../../conductor/config.ts';

const minimalZone = { deviceId: 'dev1', station: 1, sensorIds: ['s1'] };

describe('parseConductorConfig', () => {
  it('fills in built-in defaults', () => {
    expect(parseConductorConfig({ zones: [minimalZone] })).toEqual({
      pollIntervalMinutes: 15,
      dryRun: false,
      forecastHours: 72,
      recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
      alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
      notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
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
          sensorAggregation: 'driest',
          maxCycleMinutes: 20,
          soakMinutes: 30,
          targetPct: 40,
          criticalLowPct: 20,
          criticalHighPct: 60,
          rootDepthIn: 6,
          cropCoefficient: 0.8,
          rainEfficiency: 0.8,
          maxWaitHours: 6,
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

  it('layers the cycle-and-soak and aggregation settings the same way', () => {
    const cfg = parseConductorConfig({
      defaults: { maxCycleMinutes: 15, sensorAggregation: 'median' },
      zones: [minimalZone, { ...minimalZone, station: 2, soakMinutes: 45, sensorAggregation: 'average' }],
    });

    expect(cfg.zones[0]).toMatchObject({ maxCycleMinutes: 15, soakMinutes: 30, sensorAggregation: 'median' });
    expect(cfg.zones[1]).toMatchObject({ maxCycleMinutes: 15, soakMinutes: 45, sensorAggregation: 'average' });
  });

  it('derives critical moisture limits from the threshold and target, at most 0–100', () => {
    const cfg = parseConductorConfig({
      zones: [
        { ...minimalZone, thresholdPct: 25, targetPct: 35 },
        { ...minimalZone, station: 2, thresholdPct: 5, targetPct: 90 },
        { ...minimalZone, station: 3, criticalLowPct: 12, criticalHighPct: 75 },
      ],
    });

    expect(cfg.zones.map((z) => [z.criticalLowPct, z.criticalHighPct])).toEqual([
      [15, 55],
      [0, 100],
      [12, 75],
    ]);
  });

  it('fills in alert and notification settings', () => {
    const cfg = parseConductorConfig({
      alerts: { lowBatteryPct: 15 },
      notifications: { minSeverity: 'warning', timeZone: 'America/Denver' },
      zones: [minimalZone],
    });

    expect(cfg.alerts).toEqual({ lowBatteryPct: 15, deviceCheckMinutes: 60 });
    expect(cfg.notifications).toEqual({ minSeverity: 'warning', cycles: false, connectionGraceMinutes: 5, timeZone: 'America/Denver' });
  });

  it('fills in recovery defaults field by field', () => {
    expect(parseConductorConfig({ recovery: { retryWindowMinutes: 90 }, zones: [minimalZone] }).recovery).toEqual({
      confirmTimeoutSeconds: 20,
      retryWindowMinutes: 90,
      resumeWindowMinutes: 60,
    });
  });

  it('layers the forecast settings the same way', () => {
    const cfg = parseConductorConfig({
      forecastHours: 48,
      defaults: { rootDepthIn: 4, precipRateInPerHour: 1.5, cropCoefficient: 0.6 },
      zones: [
        { ...minimalZone, precipRateInPerHour: 0.5, targetPct: 45, maxWaitHours: 0 },
        { ...minimalZone, station: 2, rainEfficiency: 0.7 },
      ],
    });

    expect(cfg.forecastHours).toBe(48);
    expect(cfg.zones[0]).toMatchObject({ rootDepthIn: 4, precipRateInPerHour: 0.5, cropCoefficient: 0.6, targetPct: 45, maxWaitHours: 0 });
    expect(cfg.zones[1]).toMatchObject({ precipRateInPerHour: 1.5, rainEfficiency: 0.7, targetPct: 40 });
  });

  it('defaults the target to threshold + 10, at most 100', () => {
    const cfg = parseConductorConfig({ zones: [{ ...minimalZone, thresholdPct: 25 }, { ...minimalZone, station: 2, thresholdPct: 95 }] });

    expect(cfg.zones.map((z) => z.targetPct)).toEqual([35, 100]);
  });

  it('leaves the sprinkler rate unset when not configured (there is no safe default)', () => {
    expect(parseConductorConfig({ zones: [minimalZone] }).zones[0]).not.toHaveProperty('precipRateInPerHour');
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
    ['a target at the threshold', { zones: [{ ...minimalZone, thresholdPct: 30, targetPct: 30 }] }, 'zones.0.targetPct: targetPct (30) must be above thresholdPct (30)'],
    ['a default target below a zone threshold', { defaults: { targetPct: 35 }, zones: [{ ...minimalZone, thresholdPct: 40 }] }, 'zones.0.targetPct'],
    ['a zero sprinkler rate', { zones: [{ ...minimalZone, precipRateInPerHour: 0 }] }, 'zones.0.precipRateInPerHour'],
    ['a crop coefficient of 0', { defaults: { cropCoefficient: 0 }, zones: [minimalZone] }, 'defaults.cropCoefficient'],
    ['a rain efficiency above 1', { zones: [{ ...minimalZone, rainEfficiency: 1.2 }] }, 'zones.0.rainEfficiency'],
    ['a root depth of 0', { zones: [{ ...minimalZone, rootDepthIn: 0 }] }, 'zones.0.rootDepthIn'],
    ['a negative wait', { zones: [{ ...minimalZone, maxWaitHours: -1 }] }, 'zones.0.maxWaitHours'],
    ['an unknown sensor aggregation', { zones: [{ ...minimalZone, sensorAggregation: 'wettest' }] }, 'zones.0.sensorAggregation'],
    ['a zero cycle length', { zones: [{ ...minimalZone, maxCycleMinutes: 0 }] }, 'zones.0.maxCycleMinutes'],
    ['a negative soak', { defaults: { soakMinutes: -5 }, zones: [minimalZone] }, 'defaults.soakMinutes'],
    ['a forecast window under 12h', { forecastHours: 6, zones: [minimalZone] }, 'forecastHours'],
    ['a critical low at the threshold', { zones: [{ ...minimalZone, criticalLowPct: 30 }] }, 'zones.0.criticalLowPct: criticalLowPct (30) must be below thresholdPct (30)'],
    ['a critical high at the target', { zones: [{ ...minimalZone, criticalHighPct: 40 }] }, 'zones.0.criticalHighPct: criticalHighPct (40) must be above targetPct (40)'],
    ['an unknown notification severity', { notifications: { minSeverity: 'loud' }, zones: [minimalZone] }, 'notifications.minSeverity'],
    ['an unknown notification time zone', { notifications: { timeZone: 'Mars/Base' }, zones: [minimalZone] }, 'notifications.timeZone'],
    ['a battery level over 100', { alerts: { lowBatteryPct: 120 }, zones: [minimalZone] }, 'alerts.lowBatteryPct'],
    ['a retry window of 0', { recovery: { retryWindowMinutes: 0 }, zones: [minimalZone] }, 'recovery.retryWindowMinutes'],
    ['a negative confirm timeout', { recovery: { confirmTimeoutSeconds: -1 }, zones: [minimalZone] }, 'recovery.confirmTimeoutSeconds'],
    ['a forecast window over 5 days', { forecastHours: 121, zones: [minimalZone] }, 'forecastHours'],
    ['a non-object', 'zones', '(root)'],
  ])('rejects %s', (_, raw, mention) => {
    expect(() => parseConductorConfig(raw)).toThrow(/^Invalid conductor config:/);
    expect(() => parseConductorConfig(raw)).toThrow(mention);
  });

  it('accepts the shipped example config', async () => {
    const cfg = await loadConductorConfig(join(import.meta.dirname, '../../../conductor.example.json'));

    expect(cfg.zones.map((z) => z.key)).toEqual(['bhyve-device-id:1', 'bhyve-device-id:2']);
    expect(() => assertForecastReady(cfg)).not.toThrow();
  });
});

describe('assertForecastReady', () => {
  it('passes when every zone has a sprinkler rate', () => {
    const cfg = parseConductorConfig({ defaults: { precipRateInPerHour: 1.2 }, zones: [minimalZone] });

    expect(() => assertForecastReady(cfg)).not.toThrow();
  });

  it('names the zones that are missing one', () => {
    const cfg = parseConductorConfig({
      zones: [
        { ...minimalZone, name: 'Front', precipRateInPerHour: 1 },
        { ...minimalZone, name: 'Back', station: 2 },
      ],
    });

    expect(() => assertForecastReady(cfg)).toThrow(/no precipRateInPerHour .*: Back \[dev1:2\]$/);
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
