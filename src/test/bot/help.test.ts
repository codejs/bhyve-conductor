import { describe, expect, it, vi } from 'vitest';
import type { BotCommand, QueryCommand } from '../../bot/conversation.ts';
import { MAX_REPLY_CHARS } from '../../bot/format.ts';
import { BUILT_IN_HELP, helpFor, helpIndex } from '../../bot/help.ts';
import { buildBotCommands, unavailableCommands, type BotCommandsDeps } from '../../bot/registry.ts';
import { NOW } from '../utils/conductor.ts';

const wellFormed = (html: string) => expect(html.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);

/** The real commands, as the bot offers them (with or without a passphrase). */
const real = (withChanges = true): BotCommand[] => {
  const deps: BotCommandsDeps = {
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
  };
  return buildBotCommands(deps);
};

describe('helpIndex', () => {
  it('lists the read-only commands, then the changes, and how to get help on one', () => {
    expect(helpIndex(real())).toBe(
      [
        '🌱 <b>Lawn conductor commands</b>',
        '/status: What the conductor is doing: polls, zones, watering, connections, alerts',
        '/sensors_read: Read the soil sensors now <i>(like npm run sensors:read)</i>',
        '/bhyve_devices: B-hyve controllers: connection, battery, mode, rain delay, zones <i>(like npm run bhyve:devices)</i>',
        '/audit: What happened: the audit trail, a page at a time (e.g. /audit problems 7d)',
        '/help: this list, or how to use a command',
        '',
        '<b>Changes</b> (each asks for the passphrase):',
        '/pause: Pause automatic watering (asks for the passphrase)',
        '/resume: Resume automatic watering (asks for the passphrase)',
        "/config: Change a zone's watering settings (asks for the passphrase)",
        '/cancel: cancel a pending change',
        '',
        'Send <b>/help</b> <i>command</i> to see how to use one, e.g. /help audit.',
      ].join('\n'),
    );
  });

  it('says read-only when there are no changes', () => {
    const text = helpIndex(real(false));
    expect(text.split('\n')[0]).toBe('🌱 <b>Lawn conductor commands</b> (read-only)');
    expect(text).toContain('/cancel: close what is waiting for your answer'); // for /audit
    expect(text).not.toContain('/pause');
  });

  it('leaves out /cancel when nothing waits for an answer', () => {
    const status: QueryCommand = { kind: 'query', name: 'status', description: 'Status', cooldownSeconds: 0, run: async () => '' };
    expect(helpIndex([status])).not.toContain('/cancel');
  });
});

describe('helpFor', () => {
  it('shows how to use a read-only command, with what follows from its settings', () => {
    expect(helpFor('sensors_read', real())).toBe(
      [
        '❓ <b>/sensors_read</b>: Read the soil sensors now',
        '',
        '<b>Usage</b>',
        '<code>/sensors_read</code>: reads every soil sensor of the zones now',
        '',
        '• For each sensor: moisture, temperature, battery, whether it is online, how old the reading is, and its zone.',
        '• Sensors that could not be read are listed with the reason.',
        '',
        '🔍 Read-only.',
        '⏳ Runs at most once every 30 s (it asks a cloud service).',
        '💻 On the machine: <code>npm run sensors:read</code>',
      ].join('\n'),
    );
  });

  it('shows how to use a change, and that it asks for the passphrase', () => {
    const text = helpFor('config', real());
    expect(text).toContain('❓ <b>/config</b>: Change a zone\'s watering settings (asks for the passphrase)');
    expect(text).toContain('<code>/config</code>: changes a zone\'s watering settings, one at a time');
    expect(text).toContain('• Settings: thresholdPct, targetPct, runMinutes, maxMinutesPerDay, cooldownMinutes, maxCycleMinutes, soakMinutes.');
    expect(text).toContain('🔐 Changes something: it asks for the passphrase last, and nothing changes before that. Reply <b>cancel</b> (or /cancel) at any step.');
    expect(text).toContain('⌛ Each question waits 2 min for your answer.');
    expect(text).not.toContain('Read-only');
  });

  it('shows the examples of a command that takes arguments, and how to close a conversation', () => {
    const text = helpFor('audit', real());
    expect(text).toContain(
      [
        '<code>/audit</code>: everything from the last 24 h, newest first',
        '<code>/audit problems</code>: only failures and recoveries',
        '<code>/audit watering 7d</code>: watering of the last 7 days',
        '<code>/audit summary 7d</code>: outages, each watering and its outcome, crashes',
      ].join('\n'),
    );
    expect(text).toContain('🔍 Read-only.');
    expect(text).toContain('Reply <b>done</b> (or /cancel) to close it; it also closes after 2 min without an answer.');
  });

  it('uses the real answer timeout', () => {
    expect(helpFor('pause', real(), { answerTimeoutMs: 5 * 60_000 })).toContain('⌛ Each question waits 5 min for your answer.');
  });

  it.each(['audit', '/audit', 'AUDIT', '/Audit@LawnBot', '  audit  '])('understands %j', (arg) => {
    expect(helpFor(arg, real()).split('\n')[0]).toBe('❓ <b>/audit</b>: What happened: the audit trail, a page at a time (e.g. /audit problems 7d)');
  });

  it('explains the built-in commands', () => {
    expect(helpFor('help', real())).toBe(
      ['❓ <b>/help</b>: List the commands, or show how to use one', '', '<b>Usage</b>', '<code>/help</code>: lists the commands', '<code>/help &lt;command&gt;</code>: how to use that command, e.g. /help audit'].join('\n'),
    );
    expect(helpFor('start', real())).toBe(helpFor('help', real()));
    expect(helpFor('cancel', real())).toContain('<code>/cancel</code>: cancels the change waiting for your answer, or closes /audit');
    expect(BUILT_IN_HELP.cancel.description).toBe('Cancel a pending change (or close /audit)');
  });

  it.each(['nothing_like_it', 'water_now', 'x', 'bhyve:devices', '💧', '<b>', 'correct-horse-battery'])(
    'says there is no such command, without repeating %j back',
    (arg) => {
      const text = helpFor(arg, real());
      expect(text).toBe("🤷 There's no command by that name. Send /help for the list.");
    },
  );

  it('says why a known command is not available here', () => {
    const text = helpFor('pause', real(false), { unavailable: unavailableCommands({}) });
    expect(text).toBe('⛔ /pause is off here: changes need a passphrase (TELEGRAM_COMMAND_PASSPHRASE on the conductor).');
  });

  it('asks for one command at a time', () => {
    expect(helpFor('audit config', real())).toBe('⚠️ Send /help for the list, or /help <i>command</i> for one of them, e.g. /help audit.');
  });

  it('falls back to the description for a command without its own help', () => {
    const bare: QueryCommand = { kind: 'query', name: 'bare', description: 'Does <things>', cooldownSeconds: 0, run: async () => '' };
    expect(helpFor('bare', [bare])).toBe(['❓ <b>/bare</b>: Does &lt;things&gt;', '', '<b>Usage</b>', '<code>/bare</code>: Does &lt;things&gt;', '', '🔍 Read-only.'].join('\n'));
  });

  it('escapes and stays within one message, whatever a command says about itself', () => {
    const evil: QueryCommand = {
      kind: 'query',
      name: 'evil',
      description: '<script>',
      script: '<b>',
      cooldownSeconds: 5,
      help: { usage: Array.from({ length: 100 }, () => ({ call: '/evil <x>', does: `${'&'.repeat(150)}<i>` })), details: ['<b>bold</b>'] },
      run: async () => '',
    };
    const text = helpFor('evil', [evil]);
    wellFormed(text);
    expect(text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });
});

describe('every command documents itself', () => {
  it.each(real().map((c) => [c.name, c] as const))('/%s has usage, starting with the command', (name, command) => {
    expect(command.help?.usage.length).toBeGreaterThan(0);
    for (const u of command.help?.usage ?? []) {
      expect(u.call.startsWith(`/${name}`)).toBe(true);
      expect(u.does.length).toBeGreaterThan(5);
    }
    const text = helpFor(name, real());
    wellFormed(text);
    expect(text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });
});

describe('unavailableCommands', () => {
  it('names the changes when there is no passphrase, and nothing otherwise', () => {
    expect([...unavailableCommands({}).keys()]).toEqual(['pause', 'resume', 'config']);
    expect(unavailableCommands({ changes: { control: { status: vi.fn(), pause: vi.fn(), resume: vi.fn() }, editor: { zones: () => [], preview: vi.fn(), apply: vi.fn() } } }).size).toBe(0);
  });
});
