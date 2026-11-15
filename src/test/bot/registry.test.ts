import { describe, expect, it } from 'vitest';
import { buildBotCommands, type BotCommandsDeps } from '../../bot/registry.ts';
import { fakeBotDeps } from '../utils/bot.ts';

const deps = (withChanges: boolean): BotCommandsDeps => fakeBotDeps({ changes: withChanges });

describe('buildBotCommands', () => {
  it('offers read-only commands and /stop without changes (no passphrase)', () => {
    const commands = buildBotCommands(deps(false));
    expect(commands.map((c) => [c.name, c.kind])).toEqual([
      ['health', 'query'],
      ['zone', 'interactive'],
      ['sensors_read', 'query'],
      ['bhyve_devices', 'query'],
      ['audit', 'interactive'],
      ['stop', 'safety'],
    ]);
  });

  it('adds the commands that change something when given what they work on', () => {
    const commands = buildBotCommands(deps(true));
    expect(commands.map((c) => [c.name, c.kind])).toEqual([
      ['health', 'query'],
      ['zone', 'interactive'],
      ['sensors_read', 'query'],
      ['bhyve_devices', 'query'],
      ['audit', 'interactive'],
      ['stop', 'safety'],
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
