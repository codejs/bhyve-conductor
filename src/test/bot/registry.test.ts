import { describe, expect, it, vi } from 'vitest';
import { buildBotCommands, type BotCommandsDeps } from '../../bot/registry.ts';
import { NOW } from '../utils/conductor.ts';

const deps = (withChanges: boolean): BotCommandsDeps => ({
  bhyve: { getDevices: vi.fn(async () => []) },
  sensors: { id: 'x', read: vi.fn(async () => []) },
  zonesBySensor: new Map(),
  status: vi.fn(),
  timeZone: 'UTC',
  now: () => NOW,
  readAudit: vi.fn(async () => ({ events: [], skipped: 0, truncated: false })),
  ...(withChanges
    ? { changes: { control: { status: vi.fn(), pause: vi.fn(), resume: vi.fn() }, editor: { zones: () => [], preview: vi.fn(), apply: vi.fn() } } }
    : {}),
});

describe('buildBotCommands', () => {
  it('offers only read-only commands without changes (no passphrase)', () => {
    const commands = buildBotCommands(deps(false));
    expect(commands.map((c) => [c.name, c.kind])).toEqual([
      ['status', 'query'],
      ['sensors_read', 'query'],
      ['bhyve_devices', 'query'],
      ['audit', 'interactive'],
    ]);
  });

  it('adds the commands that change something when given what they work on', () => {
    const commands = buildBotCommands(deps(true));
    expect(commands.map((c) => [c.name, c.kind])).toEqual([
      ['status', 'query'],
      ['sensors_read', 'query'],
      ['bhyve_devices', 'query'],
      ['audit', 'interactive'],
      ['pause', 'mutable'],
      ['resume', 'mutable'],
      ['config', 'mutable'],
    ]);
  });

  it('gives /audit the audit reader and the clock', async () => {
    const d = deps(false);
    const audit = buildBotCommands(d).find((c) => c.name === 'audit');
    if (audit?.kind !== 'interactive') throw new Error('no /audit');
    const step = await audit.begin({ id: 1 }, '');
    expect(d.readAudit).toHaveBeenCalledOnce();
    expect(step.text).toContain('Nothing recorded.');
  });
});
