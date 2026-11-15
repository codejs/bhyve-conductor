import { describe, expect, it, vi } from 'vitest';
import { buildCommands, zonesBySensor, type CommandDeps } from '../../bot/commands.ts';
import { COMMAND_NAME } from '../../bot/conversation.ts';
import { bhyveDevice, NOW, reading } from '../utils/conductor.ts';
import { conductorStatus, serviceInfo } from '../utils/bot.ts';
import { fakeBhyve } from '../utils/fake-bhyve.ts';

const setup = (overrides: Partial<CommandDeps> = {}) => {
  const fake = fakeBhyve([bhyveDevice('dev1', { name: 'Front timer', zones: [{ station: 1, name: 'Front lawn' }] })]);
  const sensors = {
    id: 'fake',
    read: vi.fn(async () => [reading('s1', 31.25, { sensorName: 'Probe A' })]),
    lastErrors: [] as { sensorId: string; error: string }[],
  };
  const status = vi.fn(() => conductorStatus({ startedAt: NOW }));
  const deps: CommandDeps = {
    bhyve: fake.bhyve,
    sensors,
    zonesBySensor: new Map([['s1', ['Front lawn']]]),
    status,
    service: () => serviceInfo(),
    timeZone: 'UTC',
    now: () => NOW,
    ...overrides,
  };
  const commands = buildCommands(deps);
  const get = (name: string) => {
    const c = commands.find((x) => x.name === name);
    if (!c) throw new Error(`no /${name}`);
    return c;
  };
  return { fake, sensors, status, commands, get };
};

describe('buildCommands', () => {
  it('offers /health, /sensors_read and /bhyve_devices, mirroring the npm scripts', () => {
    const t = setup();
    expect(t.commands.map((c) => [c.name, c.script])).toEqual([
      ['health', undefined],
      ['sensors_read', 'sensors:read'],
      ['bhyve_devices', 'bhyve:devices'],
    ]);
    for (const c of t.commands) {
      expect(c.name).toMatch(COMMAND_NAME);
      expect(c.kind).toBe('query');
    }
  });

  it('puts a cooldown on the commands that call cloud APIs, none on /health', () => {
    const t = setup();
    expect(t.get('health').cooldownSeconds).toBe(0);
    expect(t.get('sensors_read').cooldownSeconds).toBeGreaterThanOrEqual(30);
    expect(t.get('bhyve_devices').cooldownSeconds).toBeGreaterThanOrEqual(30);
  });

  it('/bhyve_devices lists the devices', async () => {
    const t = setup();
    const html = await t.get('bhyve_devices').run();
    expect(html).toContain('<b>Front timer</b> [sprinkler_timer]');
    expect(html).toContain('zone 1: Front lawn');
    expect(t.fake.bhyve.getDevices).toHaveBeenCalledTimes(1);
  });

  it('/sensors_read reads the sensors now and labels them with their zones', async () => {
    const t = setup();
    const html = await t.get('sensors_read').run();
    expect(t.sensors.read).toHaveBeenCalledTimes(1);
    expect(html).toContain('• <b>Probe A</b> (Front lawn): 💧 31.3%');
  });

  it('/sensors_read includes the sensors that could not be read', async () => {
    const t = setup();
    t.sensors.read.mockImplementationOnce(async () => {
      t.sensors.lastErrors = [{ sensorId: 's2', error: 'Tuya GET /v1.0/devices/s2 failed: code 1106 permission deny' }];
      return [];
    });
    const html = await t.get('sensors_read').run();
    expect(html).toContain('(0 of 1 read)');
    expect(html).toContain('• ❌ <code>s2</code>: Tuya GET /v1.0/devices/s2 failed: code 1106 permission deny');
  });

  it('/sensors_read works with a source that does not report errors', async () => {
    const { lastErrors: _, ...plain } = setup().sensors;
    const t = setup({ sensors: plain });
    expect(await t.get('sensors_read').run()).toContain('(1 of 1 read)');
  });

  it('/health formats the monitor snapshot and the service, and makes no network calls', async () => {
    const t = setup();
    const html = await t.get('health').run();
    expect(t.status).toHaveBeenCalledTimes(1);
    expect(html.split('\n')[0]).toBe('🩺 <b>Health</b>: ✅ all good');
    expect(html).toContain('<b>Service</b>\nv1.0.0 · Node v22.21.0');
    expect(t.fake.bhyve.getDevices).not.toHaveBeenCalled();
    expect(t.sensors.read).not.toHaveBeenCalled();
  });

  it('passes API errors on to the bot (which reports them)', async () => {
    const t = setup();
    t.fake.bhyve.getDevices.mockRejectedValueOnce(new Error('B-hyve GET /devices failed: HTTP 502'));
    await expect(t.get('bhyve_devices').run()).rejects.toThrow('HTTP 502');
  });

  it('is read-only: running every command never sends a B-hyve command', async () => {
    const t = setup();
    for (const c of t.commands) await c.run();
    expect(t.fake.bhyve.startWatering).not.toHaveBeenCalled();
    // Only the read calls were used.
    expect(t.fake.bhyve.getDevice).not.toHaveBeenCalled();
    expect(t.fake.bhyve.getPrograms).not.toHaveBeenCalled();
    expect(t.fake.bhyve.onEvent).not.toHaveBeenCalled();
  });

  it('works with nothing but getDevices (the object index.ts hands over)', async () => {
    const getDevices = vi.fn(async () => [bhyveDevice('dev9')]);
    const t = setup({ bhyve: { getDevices } });
    expect(await t.get('bhyve_devices').run()).toContain('dev9');
  });
});

describe('zonesBySensor', () => {
  it('maps each sensor to the zones it is in, once each', () => {
    const map = zonesBySensor([
      { name: 'Front', sensorIds: ['a', 'b'] },
      { name: 'Back', sensorIds: ['b'] },
      { name: 'Front', sensorIds: ['a'] },
    ]);
    expect(Object.fromEntries(map)).toEqual({ a: ['Front'], b: ['Front', 'Back'] });
  });
});
