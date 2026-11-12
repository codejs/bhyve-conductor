import type { BhyveDevice } from '../../bhyve/types.ts';
import type { ZoneConfig } from '../../conductor/config.ts';
import type { MoistureReading } from '../../sensors/types.ts';

export const NOW = new Date('2026-07-01T12:00:00Z');

export const minutesAgo = (min: number, from = NOW): Date => new Date(from.getTime() - min * 60_000);

export const zone = (overrides: Partial<ZoneConfig> = {}): ZoneConfig => {
  const deviceId = overrides.deviceId ?? 'dev1';
  const station = overrides.station ?? 1;
  return {
    key: `${deviceId}:${station}`,
    name: `Zone ${station}`,
    deviceId,
    station,
    sensorIds: ['s1'],
    thresholdPct: 30,
    runMinutes: 10,
    cooldownMinutes: 240,
    maxMinutesPerDay: 30,
    maxReadingAgeMinutes: 180,
    ...overrides,
  };
};

export const reading = (sensorId: string, moisturePct: number, overrides: Partial<MoistureReading> = {}): MoistureReading => ({
  sensorId,
  sensorName: `Sensor ${sensorId}`,
  moisturePct,
  online: true,
  at: minutesAgo(10),
  ...overrides,
});

export const readingsMap = (...rs: MoistureReading[]): Map<string, MoistureReading> =>
  new Map(rs.map((r) => [r.sensorId, r]));

/** A connected, idle device in auto mode with stations 1–4. */
export const bhyveDevice = (id = 'dev1', overrides: Partial<BhyveDevice> = {}): BhyveDevice => ({
  id,
  name: `Timer ${id}`,
  type: 'sprinkler_timer',
  is_connected: true,
  zones: [1, 2, 3, 4].map((station) => ({ station })),
  status: { run_mode: 'auto', rain_delay: 0, watering_status: null },
  ...overrides,
});
