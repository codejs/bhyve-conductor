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
  'TELEGRAM_COMMANDS',
  'TELEGRAM_COMMAND_USER_IDS',
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

  describe('Telegram commands', () => {
    const load = () => loadConfig(['TELEGRAM_COMMANDS', 'TELEGRAM_COMMAND_USER_IDS']);

    it('are off, with no allowed users, unless set', () => {
      expect(load()).toEqual({ TELEGRAM_COMMANDS: false, TELEGRAM_COMMAND_USER_IDS: [] });
      vi.stubEnv('TELEGRAM_COMMANDS', '');
      vi.stubEnv('TELEGRAM_COMMAND_USER_IDS', ' ');
      expect(load()).toEqual({ TELEGRAM_COMMANDS: false, TELEGRAM_COMMAND_USER_IDS: [] });
    });

    it.each([
      ['on', true],
      ['true', true],
      ['1', true],
      ['off', false],
      ['false', false],
      ['0', false],
    ])('TELEGRAM_COMMANDS=%s → %s', (value, expected) => {
      vi.stubEnv('TELEGRAM_COMMANDS', value);
      expect(load().TELEGRAM_COMMANDS).toBe(expected);
    });

    it.each(['yes', 'ON', 'enabled', '2'])('rejects TELEGRAM_COMMANDS=%s rather than guessing', (value) => {
      vi.stubEnv('TELEGRAM_COMMANDS', value);
      expect(load).toThrow(/TELEGRAM_COMMANDS: expected 'on' or 'off'/);
    });

    it('parses the allowed user ids', () => {
      vi.stubEnv('TELEGRAM_COMMAND_USER_IDS', ' 4242, 5151 ,,9007199254740991');
      expect(load().TELEGRAM_COMMAND_USER_IDS).toEqual([4242, 5151, 9007199254740991]);
    });

    it.each([
      ['@owner', /numeric Telegram user ids/],
      ['-4242', /numeric Telegram user ids/],
      ['0', /numeric Telegram user ids/],
      ['0042', /numeric Telegram user ids/],
      ['42.5', /numeric Telegram user ids/],
      ['1e6', /numeric Telegram user ids/],
      ['42;43', /numeric Telegram user ids/],
      ['12345678901234567', /numeric Telegram user ids/],
      // Would round to a different number, i.e. somebody else's id.
      ['9007199254740993', /out of range/],
    ])('rejects TELEGRAM_COMMAND_USER_IDS=%s', (value, message) => {
      vi.stubEnv('TELEGRAM_COMMAND_USER_IDS', value);
      expect(load).toThrow(message);
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
