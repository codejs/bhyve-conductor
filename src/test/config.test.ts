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
  'CONDUCTOR_CONFIG',
  'CONDUCTOR_STATE',
  'LOCATION',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'LOG_LEVEL',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_ALLOWED_HOSTS',
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

  it('defaults the conductor config and state paths', () => {
    expect(loadConfig(['CONDUCTOR_CONFIG', 'CONDUCTOR_STATE'])).toEqual({
      CONDUCTOR_CONFIG: 'conductor.json',
      CONDUCTOR_STATE: '.conductor-state.json',
    });
  });

  it('treats LOCATION as optional and trims it', () => {
    expect(loadConfig(['LOCATION'])).toEqual({});

    vi.stubEnv('LOCATION', '  Austin, TX ');
    expect(loadConfig(['LOCATION'])).toEqual({ LOCATION: 'Austin, TX' });
  });

  it('treats a blank LOCATION (as copied from .env.example) as not set', () => {
    vi.stubEnv('LOCATION', '   ');

    expect(loadConfig(['LOCATION'])).toEqual({});
  });

  it('accepts Telegram settings, and treats blanks as not set', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    vi.stubEnv('TELEGRAM_CHAT_ID', '-1001234567890');
    expect(loadConfig(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])).toEqual({
      TELEGRAM_BOT_TOKEN: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      TELEGRAM_CHAT_ID: '-1001234567890',
    });

    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_CHAT_ID', '@lawn_alerts');
    expect(loadConfig(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])).toEqual({ TELEGRAM_CHAT_ID: '@lawn_alerts' });
  });

  it.each([
    ['TELEGRAM_BOT_TOKEN', 'not-a-token'],
    ['TELEGRAM_CHAT_ID', 'my chat'],
  ] as const)('rejects a malformed %s', (key, value) => {
    vi.stubEnv(key, value);

    expect(() => loadConfig([key])).toThrow(key);
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
  describe('web app (npm run web)', () => {
    const WEB = ['WEB_HOST', 'WEB_PORT', 'WEB_ALLOWED_HOSTS'] as const;

    it('defaults to this machine only, on port 8787', () => {
      expect(loadConfig(WEB)).toEqual({ WEB_HOST: '127.0.0.1', WEB_PORT: 8787, WEB_ALLOWED_HOSTS: [] });
    });

    it('treats blanks (as copied from .env.example) as not set', () => {
      vi.stubEnv('WEB_HOST', ' ');
      vi.stubEnv('WEB_PORT', '');
      vi.stubEnv('WEB_ALLOWED_HOSTS', '');
      expect(loadConfig(WEB)).toEqual({ WEB_HOST: '127.0.0.1', WEB_PORT: 8787, WEB_ALLOWED_HOSTS: [] });
    });

    it('reads an address, a port and a list of host names', () => {
      vi.stubEnv('WEB_HOST', ' 0.0.0.0 ');
      vi.stubEnv('WEB_PORT', '9000');
      vi.stubEnv('WEB_ALLOWED_HOSTS', ' garden-pi.local, 192.168.1.10 ,,[fd00::5]');
      expect(loadConfig(WEB)).toEqual({ WEB_HOST: '0.0.0.0', WEB_PORT: 9000, WEB_ALLOWED_HOSTS: ['garden-pi.local', '192.168.1.10', '[fd00::5]'] });

      vi.stubEnv('WEB_HOST', '::1');
      expect(loadConfig(['WEB_HOST'])).toEqual({ WEB_HOST: '::1' });
    });

    it.each([
      ['WEB_HOST', 'my host'],
      ['WEB_HOST', 'http://localhost'],
      ['WEB_HOST', 'a/b'],
      ['WEB_PORT', 'http'],
      ['WEB_PORT', '0'],
      ['WEB_PORT', '65536'],
      ['WEB_PORT', '80.5'],
      ['WEB_PORT', '-1'],
      ['WEB_ALLOWED_HOSTS', 'garden pi'],
      ['WEB_ALLOWED_HOSTS', 'ok.local,evil/path'],
      ['WEB_ALLOWED_HOSTS', 'user@evil.example'],
    ] as const)('rejects %s=%j', (key, value) => {
      vi.stubEnv(key, value);
      expect(() => loadConfig([key])).toThrow(key);
    });
  });
});
