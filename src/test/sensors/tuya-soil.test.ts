import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { log } from '../../log.ts';
import type { TuyaClient, TuyaDataPoint, TuyaDevice, TuyaSpecification } from '../../tuya/client.ts';
import { TuyaSoilSource } from '../../sensors/tuya-soil.ts';

const intSpec = (code: string, scale: number) => ({
  code,
  type: 'Integer',
  values: JSON.stringify({ min: 0, max: 1000, scale, step: 1 }),
});

const SPEC: TuyaSpecification = {
  category: 'zwjcy',
  status: [intSpec('humidity', 0), intSpec('temp_current', 1), intSpec('battery_percentage', 0)],
};

const device = (id: string, status: TuyaDataPoint[] | undefined, extra: Partial<TuyaDevice> = {}): TuyaDevice => ({
  id,
  name: `Sensor ${id}`,
  online: true,
  update_time: 1_780_000_000,
  ...(status ? { status } : {}),
  ...extra,
});

const fakeTuya = (devices: Record<string, TuyaDevice>, spec: TuyaSpecification = SPEC) => {
  const client = {
    getDevice: vi.fn(async (id: string) => {
      const d = devices[id];
      if (!d) throw new Error(`unknown device ${id}`);
      return d;
    }),
    getStatus: vi.fn(async (_id: string): Promise<TuyaDataPoint[]> => []),
    getSpecification: vi.fn(async (_id: string) => spec),
  };
  return { client, tuya: client as unknown as TuyaClient };
};

describe('TuyaSoilSource', () => {
  let warn: MockInstance<typeof log.warn>;

  beforeEach(() => {
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  it('converts data points into a reading, applying scales', async () => {
    const { tuya } = fakeTuya({
      s1: device('s1', [
        { code: 'humidity', value: 37 },
        { code: 'temp_current', value: 215 },
        { code: 'battery_percentage', value: 80 },
      ]),
    });
    const source = new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'humidity' });

    expect(await source.read()).toEqual([
      {
        sensorId: 's1',
        sensorName: 'Sensor s1',
        moisturePct: 37,
        temperatureC: 21.5,
        batteryPct: 80,
        online: true,
        at: new Date(1_780_000_000 * 1000),
      },
    ]);
  });

  it('omits temperature and battery when the sensor has no such data points', async () => {
    const { tuya } = fakeTuya({ s1: device('s1', [{ code: 'humidity', value: 50 }]) });
    const [reading] = await new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'humidity' }).read();

    expect(reading).not.toHaveProperty('temperatureC');
    expect(reading).not.toHaveProperty('batteryPct');
  });

  it('supports a custom moisture code and alternative temperature/battery codes', async () => {
    const spec: TuyaSpecification = { category: 'x', status: [intSpec('soil_moisture', 1), intSpec('va_temperature', 0)] };
    const { tuya } = fakeTuya(
      {
        s1: device('s1', [
          { code: 'soil_moisture', value: 425 },
          { code: 'va_temperature', value: 18 },
          { code: 'va_battery', value: 60 },
        ]),
      },
      spec,
    );
    const [reading] = await new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'soil_moisture' }).read();

    expect(reading).toMatchObject({ moisturePct: 42.5, temperatureC: 18, batteryPct: 60 });
  });

  it('fetches status separately when the device details do not include it', async () => {
    const { client, tuya } = fakeTuya({ s1: device('s1', undefined) });
    client.getStatus.mockResolvedValueOnce([{ code: 'humidity', value: 22 }]);

    const [reading] = await new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'humidity' }).read();

    expect(client.getStatus).toHaveBeenCalledWith('s1');
    expect(reading?.moisturePct).toBe(22);
  });

  it('treats a missing online flag as offline and uses the current time without update_time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
    const d = device('s1', [{ code: 'humidity', value: 30 }]);
    delete d.online;
    delete d.update_time;
    const { tuya } = fakeTuya({ s1: d });

    const [reading] = await new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'humidity' }).read();

    expect(reading).toMatchObject({ online: false, at: new Date('2026-07-01T12:00:00Z') });
    vi.useRealTimers();
  });

  it('caches the specification per device', async () => {
    const { client, tuya } = fakeTuya({
      s1: device('s1', [{ code: 'humidity', value: 30 }]),
      s2: device('s2', [{ code: 'humidity', value: 40 }]),
    });
    const source = new TuyaSoilSource(tuya, { sensorIds: ['s1', 's2'], moistureCode: 'humidity' });

    await source.read();
    await source.read();

    expect(client.getSpecification).toHaveBeenCalledTimes(2); // once per device, not per read
    expect(client.getDevice).toHaveBeenCalledTimes(4);
  });

  it('skips sensors that fail and still returns the others', async () => {
    const { tuya } = fakeTuya({
      good: device('good', [{ code: 'humidity', value: 30 }]),
      nomoisture: device('nomoisture', [{ code: 'temp_current', value: 200 }]),
    });
    const source = new TuyaSoilSource(tuya, { sensorIds: ['good', 'nomoisture', 'unknown'], moistureCode: 'humidity' });

    const readings = await source.read();

    expect(readings.map((r) => r.sensorId)).toEqual(['good']);
    const warnings = warn.mock.calls.map(([msg]) => msg);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('nomoisture');
  });

  it('reports which data points exist when the moisture code is wrong', async () => {
    const { tuya } = fakeTuya({ s1: device('s1', [{ code: 'temp_current', value: 200 }, { code: 'battery_state', value: 'low' }]) });
    const source = new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'humidity' });

    await source.read();

    const [, reason] = warn.mock.calls[0] ?? [];
    expect(String(reason)).toContain('available codes: temp_current, battery_state');
  });

  it('ignores non-numeric moisture values', async () => {
    const { tuya } = fakeTuya({ s1: device('s1', [{ code: 'humidity', value: 'wet' }]) });

    await expect(new TuyaSoilSource(tuya, { sensorIds: ['s1'], moistureCode: 'humidity' }).read()).resolves.toEqual([]);
  });
});
