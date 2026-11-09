import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep a developer's real .env out of the tests.
vi.hoisted(() => {
  process.loadEnvFile = () => {};
});

const { loadConfig } = await import('../config.ts');

const ALL_KEYS = [
  'BHYVE_EMAIL',
  'BHYVE_PASSWORD',
  'TUYA_CLIENT_ID',
  'TUYA_CLIENT_SECRET',
  'TUYA_BASE_URL',
  'TUYA_SOIL_SENSOR_IDS',
  'TUYA_MOISTURE_CODE',
  'LOG_LEVEL',
] as const;

describe('loadConfig', () => {
  beforeEach(() => {
    for (const key of ALL_KEYS) vi.stubEnv(key, undefined);
  });

  it('returns only the requested keys', () => {
    vi.stubEnv('BHYVE_EMAIL', 'me@example.com');
    vi.stubEnv('BHYVE_PASSWORD', 'secret');
    vi.stubEnv('TUYA_CLIENT_ID', 'should-not-appear');

    expect(loadConfig(['BHYVE_EMAIL', 'BHYVE_PASSWORD'])).toEqual({
      BHYVE_EMAIL: 'me@example.com',
      BHYVE_PASSWORD: 'secret',
    });
  });

  it('does not require keys that were not requested', () => {
    vi.stubEnv('TUYA_CLIENT_ID', 'id');
    vi.stubEnv('TUYA_CLIENT_SECRET', 'secret');

    expect(() => loadConfig(['TUYA_CLIENT_ID', 'TUYA_CLIENT_SECRET'])).not.toThrow();
  });

  it('applies defaults', () => {
    expect(loadConfig(['TUYA_BASE_URL', 'TUYA_MOISTURE_CODE', 'TUYA_SOIL_SENSOR_IDS', 'LOG_LEVEL'])).toEqual({
      TUYA_BASE_URL: 'https://openapi.tuyaus.com',
      TUYA_MOISTURE_CODE: 'humidity',
      TUYA_SOIL_SENSOR_IDS: [],
      LOG_LEVEL: 'info',
    });
  });

  it('splits sensor IDs on commas and trims blanks', () => {
    vi.stubEnv('TUYA_SOIL_SENSOR_IDS', ' abc, def ,,ghi ');

    expect(loadConfig(['TUYA_SOIL_SENSOR_IDS']).TUYA_SOIL_SENSOR_IDS).toEqual(['abc', 'def', 'ghi']);
  });

  it('lists every problem in one error', () => {
    vi.stubEnv('BHYVE_EMAIL', 'not-an-email');

    expect(() => loadConfig(['BHYVE_EMAIL', 'BHYVE_PASSWORD'])).toThrow(
      /Invalid environment[\s\S]*BHYVE_EMAIL[\s\S]*BHYVE_PASSWORD/,
    );
  });

  it.each([
    ['TUYA_BASE_URL', 'not a url'],
    ['LOG_LEVEL', 'verbose'],
    ['BHYVE_PASSWORD', ''],
  ] as const)('rejects invalid %s=%j', (key, value) => {
    vi.stubEnv(key, value);

    expect(() => loadConfig([key])).toThrow(key);
  });
});
