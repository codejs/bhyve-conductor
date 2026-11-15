import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { CommandPolicy } from '../../bot/auth.ts';
import { CommandBot, parseCommand, SlidingWindowLimiter, type CommandBotOptions } from '../../bot/bot.ts';
import type { QueryCommand as BotCommand } from '../../bot/conversation.ts';
import { VirtualClock } from '../../clock.ts';
import { log } from '../../log.ts';
import { TelegramConflictError, TelegramPermanentError, TelegramRateLimitError, type TelegramMessage, type TelegramUpdate } from '../../notify/telegram.ts';
import { fakeBotApi, FAMILY, GROUP_ID, OWNER, STRANGER, updates } from '../utils/fake-telegram.ts';

const START = new Date('2026-07-01T12:00:00Z');
const SEC = 1000;

const PRIVATE: CommandPolicy = { chatId: OWNER.id, userIds: new Set([OWNER.id]) };
const GROUP: CommandPolicy = { chatId: GROUP_ID, userIds: new Set([OWNER.id, FAMILY.id]) };
const inGroup = (from = OWNER): Partial<TelegramMessage> => ({ chat: { id: GROUP_ID, type: 'supergroup' }, from });

const command = (name: string, cooldownSeconds = 0, reply = `<b>${name}</b> ok`): BotCommand & { run: ReturnType<typeof vi.fn> } => ({
  kind: 'query',
  name,
  description: `Does ${name}`,
  cooldownSeconds,
  run: vi.fn(async () => reply),
});

const setup = (opts: { policy?: CommandPolicy; commands?: BotCommand[]; options?: Partial<CommandBotOptions> } = {}) => {
  const clock = new VirtualClock(START);
  const fake = fakeBotApi();
  const audit = new MemoryAuditLog(() => clock.now());
  const replies: string[] = [];
  const status = command('status');
  const sensors = command('sensors_read', 30, '🌱 readings');
  const devices = command('bhyve_devices', 30, '📟 devices');
  const commands = opts.commands ?? [status, sensors, devices];
  const bot = new CommandBot({
    api: fake.bot,
    policy: opts.policy ?? PRIVATE,
    commands,
    reply: (html) => replies.push(html),
    audit,
    clock,
    ...(opts.options ? { options: opts.options } : {}),
  });
  const msg = updates(clock);
  return {
    clock,
    fake,
    audit,
    replies,
    bot,
    msg,
    status,
    sensors,
    devices,
    /** Starts the bot and lets it reach its first long poll. */
    start: async () => {
      bot.start();
      await clock.advanceBy(0);
    },
    /** Delivers messages in one batch and lets the bot handle them. */
    send: async (...items: (string | Parameters<ReturnType<typeof updates>> | TelegramUpdate)[]) => {
      fake.push(...items.map((t) => (typeof t === 'string' ? msg(t) : Array.isArray(t) ? msg(...t) : t)));
      await clock.advanceBy(0);
    },
  };
};

describe('parseCommand', () => {
  it.each([
    ['/status', { name: 'status', args: '' }],
    ['/Status', { name: 'status', args: '' }],
    ['/status@LawnBot', { name: 'status', target: 'LawnBot', args: '' }],
    ['/status   now please ', { name: 'status', args: 'now please' }],
    ['/bhyve_devices\nmore', { name: 'bhyve_devices', args: 'more' }],
    ['  /status  ', { name: 'status', args: '' }],
  ])('%j', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it.each([
    'status',
    '/',
    '/ status',
    '/bhyve:devices', // npm script names aren't valid Telegram commands
    '/sensors-read',
    '/статус',
    '/a@',
    `/${'a'.repeat(33)}`,
    `/status ${'x'.repeat(300)}`, // longer than any real command
    '/status@bot@bot',
  ])('rejects %j', (text) => {
    expect(parseCommand(text)).toBeUndefined();
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows at most max events in any window', () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.tryTake(0)).toBe(true);
    expect(limiter.tryTake(500)).toBe(true);
    expect(limiter.tryTake(999)).toBe(false);
    expect(limiter.tryTake(1000)).toBe(true); // the first one has left the window
    expect(limiter.tryTake(1499)).toBe(false);
    expect(limiter.tryTake(1500)).toBe(true);
  });

  it('does not count refused attempts', () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    expect(limiter.tryTake(0)).toBe(true);
    for (let t = 1; t < 1000; t += 100) expect(limiter.tryTake(t)).toBe(false);
    expect(limiter.tryTake(1000)).toBe(true);
  });
});

describe('CommandBot', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    error = vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  let active: CommandBot[] = [];
  const track = <T extends { bot: CommandBot }>(t: T): T => {
    active.push(t.bot);
    return t;
  };
  afterEach(async () => {
    for (const bot of active) await bot.stop();
    active = [];
  });

  describe('answering commands', () => {
    it('runs a command from the owner and replies with its output', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/status');

      expect(t.status.run).toHaveBeenCalledTimes(1);
      expect(t.replies).toEqual(['<b>status</b> ok']);
    });

    it('runs each of the configured commands', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/status', '/sensors_read', '/bhyve_devices');

      expect(t.replies).toEqual(['<b>status</b> ok', '🌱 readings', '📟 devices']);
    });

    it('accepts commands addressed to this bot (case-insensitive) and ignores those for other bots', async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/status@LawnBot', inGroup()], ['/status@lawnbot', inGroup()], ['/status@OtherBot', inGroup()]);

      expect(t.status.run).toHaveBeenCalledTimes(2);
      expect(t.replies).toHaveLength(2);
    });

    it('lists the commands for /help and /start, saying they are read-only', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/help', '/start');

      expect(t.replies[0]).toBe(
        [
          '🌱 <b>Lawn conductor commands</b> (read-only)',
          '/status: Does status',
          '/sensors_read: Does sensors_read',
          '/bhyve_devices: Does bhyve_devices',
          '/help: this list, or how to use a command',
          '',
          'Send <b>/help</b> <i>command</i> to see how to use one, e.g. /help audit.',
        ].join('\n'),
      );
      expect(t.replies[1]).toBe(t.replies[0]);
    });

    it('mentions the npm script a command mirrors', async () => {
      const t = track(setup({ commands: [{ ...command('sensors_read'), script: 'sensors:read' }] }));
      await t.start();

      await t.send('/help');

      expect(t.replies[0]).toContain('/sensors_read: Does sensors_read <i>(like npm run sensors:read)</i>');
    });

    it('answers an unknown command without running anything', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/water_now', '/bhyve:devices');

      expect(t.replies).toEqual(['🤷 Unknown command /water_now. Send /help for the list.', '🤷 Unknown command. Send /help for the list.']);
      for (const c of [t.status, t.sensors, t.devices]) expect(c.run).not.toHaveBeenCalled();
    });

    it('refuses arguments instead of ignoring them', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/bhyve_devices start dev1 1 240');

      expect(t.replies).toEqual(['⚠️ /bhyve_devices takes no arguments.']);
      expect(t.devices.run).not.toHaveBeenCalled();
    });

    it('ignores ordinary chat messages and other non-commands silently', async () => {
      const t = track(setup());
      await t.start();

      await t.send('hello', 'status', ' ', '');
      t.fake.push(t.msg(undefined)); // a photo, sticker...: no text at all
      t.fake.push({ update_id: 5000 }); // another kind of update (or a message that didn't parse)
      await t.clock.advanceBy(0);

      expect(t.replies).toEqual([]);
      expect(t.audit.events).toEqual([]);
    });

    it('reports a failing command with its (escaped) error, and keeps going', async () => {
      const t = track(setup());
      t.devices.run.mockRejectedValueOnce(new Error('B-hyve GET /devices failed: HTTP 502 <html>Bad Gateway</html>'));
      await t.start();

      await t.send('/bhyve_devices', '/status');

      expect(t.replies).toEqual([
        '❌ /bhyve_devices failed: B-hyve GET /devices failed: HTTP 502 &lt;html&gt;Bad Gateway&lt;/html&gt;',
        '<b>status</b> ok',
      ]);
    });

    it('clips a very long error message', async () => {
      const t = track(setup());
      t.devices.run.mockRejectedValueOnce(new Error('x'.repeat(5000)));
      await t.start();

      await t.send('/bhyve_devices');

      expect(t.replies[0]?.length).toBeLessThan(400);
      expect(t.audit.ofType('command.handled')[0]?.error).toHaveLength(300);
    });

    it('handles a command that throws synchronously', async () => {
      const bad: BotCommand = {
        kind: 'query',
        name: 'status',
        description: 'x',
        cooldownSeconds: 0,
        run: () => {
          throw new Error('boom');
        },
      };
      const t = track(setup({ commands: [bad] }));
      await t.start();

      await t.send('/status');

      expect(t.replies).toEqual(['❌ /status failed: boom']);
    });

    it('times out a command that hangs, and survives it failing later (no unhandled rejection)', async () => {
      const t = track(setup({ options: { commandTimeoutMs: 10 * SEC } }));
      let failLater: (err: Error) => void = () => {};
      t.sensors.run.mockImplementationOnce(() => new Promise((_, reject) => (failLater = reject)));
      await t.start();

      await t.send('/sensors_read');
      expect(t.replies).toEqual([]);
      await t.clock.advanceBy(10 * SEC);

      expect(t.replies).toEqual(['⌛ /sensors_read timed out (no answer within 10 s). Try again later.']);
      expect(t.audit.ofType('command.handled')).toEqual([expect.objectContaining({ command: 'sensors_read', outcome: 'timed_out' })]);

      failLater(new Error('too late'));
      await t.clock.advanceBy(0);
      await t.send('/status'); // still answering
      expect(t.replies).toHaveLength(2);
    });

    it('runs commands one at a time, in order', async () => {
      const t = track(setup());
      let finish: (v: string) => void = () => {};
      t.sensors.run.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
      await t.start();

      await t.send('/sensors_read', '/status');
      expect(t.status.run).not.toHaveBeenCalled();

      finish('first');
      await t.clock.advanceBy(0);
      expect(t.replies).toEqual(['first', '<b>status</b> ok']);
    });

    it('keeps going when handling one update throws unexpectedly', async () => {
      const t = track(setup());
      let calls = 0;
      const bot = new CommandBot({
        api: t.fake.bot,
        policy: PRIVATE,
        commands: [command('status')],
        reply: () => {
          calls++;
          if (calls === 1) throw new Error('reply failed');
        },
        clock: t.clock,
      });
      active.push(bot);
      bot.start();
      await t.clock.advanceBy(0);

      t.fake.push(t.msg('/status'), t.msg('/status'));
      await t.clock.advanceBy(0);

      expect(calls).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not handle update \d+/), expect.any(Error));
      expect(bot.running).toBe(true);
    });

    it('refuses two commands with the same name, or one that shadows /help', () => {
      const { bot: api } = fakeBotApi();
      const make = (commands: BotCommand[]) => new CommandBot({ api, policy: PRIVATE, commands, reply: () => {} });
      expect(() => make([command('status'), command('status')])).toThrow('duplicate bot command /status');
      expect(() => make([command('help')])).toThrow('duplicate bot command /help');
      expect(() => make([command('start')])).toThrow('duplicate bot command /start');
    });
  });

  describe('authorization', () => {
    it('ignores a stranger: nothing runs, no reply, and the owner is told (audit → notification)', async () => {
      const t = track(setup());
      await t.start();

      await t.send(['/bhyve_devices', { chat: { id: STRANGER.id, type: 'private' }, from: STRANGER }]);

      expect(t.devices.run).not.toHaveBeenCalled();
      expect(t.replies).toEqual([]);
      expect(t.audit.ofType('command.rejected')).toEqual([
        expect.objectContaining({
          reason: 'other-chat',
          chat: STRANGER.id,
          chatType: 'private',
          user: STRANGER.id,
          userName: 'mallory',
          command: 'bhyve_devices',
          notify: true,
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(`Telegram commands: rejected a command (other-chat) from user ${STRANGER.id} in chat ${STRANGER.id}`);
    });

    it('ignores group members who are not on the allowlist', async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/status', inGroup(STRANGER)], ['/status', inGroup(FAMILY)]);

      expect(t.status.run).toHaveBeenCalledTimes(1); // FAMILY only
      expect(t.audit.ofType('command.rejected')).toEqual([expect.objectContaining({ reason: 'user-not-allowed', user: STRANGER.id, notify: true })]);
    });

    it.each([
      ['anonymous', { sender_chat: { id: GROUP_ID, type: 'supergroup' } }, true],
      ['bot-sender', { from: { ...OWNER, is_bot: true } }, true],
      ['forwarded', { forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'x' } }, false],
      ['via-bot', { via_bot: { id: 1, is_bot: true } }, false],
    ] as const)('rejects %s messages in the group', async (reason, overrides, notify) => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/status', { ...inGroup(), ...overrides }]);

      expect(t.status.run).not.toHaveBeenCalled();
      expect(t.replies).toEqual([]);
      expect(t.audit.ofType('command.rejected')).toEqual([expect.objectContaining({ reason, notify })]);
    });

    it('keeps only the command word of a rejected message, never the rest of its text', async () => {
      const t = track(setup());
      await t.start();

      await t.send(
        ['/status <script>alert(1)</script> secret', { chat: { id: STRANGER.id, type: 'private' }, from: STRANGER }],
        ['/<b>', { chat: { id: 7, type: 'private' }, from: { ...STRANGER, id: 7 } }],
      );

      const [first, second] = t.audit.ofType('command.rejected');
      expect(first?.command).toBe('status');
      expect(JSON.stringify(t.audit.events)).not.toMatch(/script|secret|<b>/);
      expect(second).not.toHaveProperty('command');
    });

    it('ignores non-command messages from strangers without any record (nothing to report)', async () => {
      const t = track(setup());
      await t.start();

      await t.send(['hi, is this the lawn bot?', { chat: { id: STRANGER.id, type: 'private' }, from: STRANGER }]);

      expect(t.audit.events).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('records a persistent sender once per interval, not once per message', async () => {
      const t = track(setup({ options: { rejectionAuditIntervalMs: 60 * 60 * SEC } }));
      await t.start();
      const spam = () => ['/status', { chat: { id: STRANGER.id, type: 'private' }, from: STRANGER }] as Parameters<typeof t.msg>;

      await t.send(spam(), spam(), spam());
      await t.clock.advanceBy(30 * 60 * SEC);
      await t.send(spam());
      expect(t.audit.ofType('command.rejected')).toHaveLength(1);

      await t.clock.advanceBy(30 * 60 * SEC);
      await t.send(spam());
      expect(t.audit.ofType('command.rejected')).toHaveLength(2);
    });

    it('caps how many rejections are recorded per interval, so a flood from many accounts cannot fill the disk', async () => {
      const t = track(setup({ options: { maxRejectionAuditsPerInterval: 3 } }));
      await t.start();

      for (let id = 1; id <= 50; id++) await t.send(['/status', { chat: { id, type: 'private' }, from: { ...STRANGER, id } }]);

      expect(t.audit.ofType('command.rejected')).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it('still answers the owner while being flooded by strangers', async () => {
      const t = track(setup());
      await t.start();

      const flood = Array.from({ length: 30 }, (_, i) => ['/status', { chat: { id: 100 + i, type: 'private' }, from: { ...STRANGER, id: 100 + i } }] as Parameters<typeof t.msg>);
      await t.send(...flood, '/status');

      expect(t.status.run).toHaveBeenCalledTimes(1);
      expect(t.replies).toEqual(['<b>status</b> ok']); // strangers don't use up the rate limit either
    });
  });

  describe('freshness', () => {
    it('ignores commands older than the limit (sent while the conductor was down, or replayed)', async () => {
      const t = track(setup({ options: { maxMessageAgeSeconds: 120 } }));
      await t.start();
      const now = Math.floor(START.getTime() / 1000);

      await t.send(['/status', { date: now - 121 }], ['/sensors_read', { date: now - 120 }]);

      expect(t.status.run).not.toHaveBeenCalled();
      expect(t.sensors.run).toHaveBeenCalledTimes(1);
      expect(t.replies).toEqual(['🌱 readings']);
    });

    it('accepts a message dated slightly in the future (clock skew)', async () => {
      const t = track(setup());
      await t.start();

      await t.send(['/status', { date: Math.floor(START.getTime() / 1000) + 30 }]);

      expect(t.status.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limits', () => {
    it('answers at most maxCommandsPerWindow commands, says so once, then recovers', async () => {
      const t = track(setup({ options: { maxCommandsPerWindow: 3, rateWindowMs: 60 * SEC } }));
      await t.start();

      await t.send(...Array.from({ length: 8 }, () => '/status'));

      expect(t.status.run).toHaveBeenCalledTimes(3);
      expect(t.replies).toEqual([...Array.from({ length: 3 }, () => '<b>status</b> ok'), '🐢 Too many commands; ignoring them for up to 60 s.']);

      await t.clock.advanceBy(60 * SEC);
      await t.send('/status');
      expect(t.status.run).toHaveBeenCalledTimes(4);
    });

    it('counts unknown commands and /help too (every reply costs)', async () => {
      const t = track(setup({ options: { maxCommandsPerWindow: 2 } }));
      await t.start();

      await t.send('/nope', '/help', '/status');

      expect(t.status.run).not.toHaveBeenCalled();
    });

    it('enforces a per-command cooldown that protects the APIs', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/sensors_read');
      await t.clock.advanceBy(12 * SEC);
      await t.send('/sensors_read');

      expect(t.sensors.run).toHaveBeenCalledTimes(1);
      expect(t.replies[1]).toBe('⏳ /sensors_read ran 12 s ago; it can run again in 18 s (this keeps API use down).');

      await t.clock.advanceBy(18 * SEC);
      await t.send('/sensors_read');
      expect(t.sensors.run).toHaveBeenCalledTimes(2);
    });

    it('keeps cooldowns separate per command, and none for /status', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/sensors_read', '/bhyve_devices', '/status', '/status');

      expect(t.sensors.run).toHaveBeenCalledTimes(1);
      expect(t.devices.run).toHaveBeenCalledTimes(1);
      expect(t.status.run).toHaveBeenCalledTimes(2);
    });

    it('starts the cooldown even when the command fails (no hammering a failing API)', async () => {
      const t = track(setup());
      t.devices.run.mockRejectedValueOnce(new Error('HTTP 503'));
      await t.start();

      await t.send('/bhyve_devices', '/bhyve_devices');

      expect(t.devices.run).toHaveBeenCalledTimes(1);
      expect(t.replies[1]).toMatch(/^⏳/);
    });
  });

  describe('audit', () => {
    it('records who ran which command and how it went, without the reply', async () => {
      const t = track(setup({ policy: GROUP }));
      t.devices.run.mockRejectedValueOnce(new Error('HTTP 502'));
      await t.start();

      await t.send(['/status', inGroup(FAMILY)], ['/bhyve_devices', inGroup(OWNER)]);

      expect(t.audit.ofType('command.handled')).toEqual([
        { ts: START.toISOString(), type: 'command.handled', command: 'status', user: FAMILY.id, userName: 'family', outcome: 'ok', ms: 0 },
        { ts: START.toISOString(), type: 'command.handled', command: 'bhyve_devices', user: OWNER.id, userName: 'owner', outcome: 'failed', ms: 0, error: 'HTTP 502' },
      ]);
    });

    it('does not record commands that never ran (unknown, cooldown, rate limit)', async () => {
      const t = track(setup({ options: { maxCommandsPerWindow: 3 } }));
      await t.start();

      await t.send('/nope', '/sensors_read', '/sensors_read', '/status');

      expect(t.audit.ofType('command.handled').map((e) => e.command)).toEqual(['sensors_read']);
    });
  });

  describe('polling', () => {
    it('identifies itself, sets the command menu for the configured chat only, then long-polls', async () => {
      const t = track(setup({ options: { pollTimeoutSeconds: 50 } }));
      await t.start();

      expect(t.fake.api.getMe).toHaveBeenCalledTimes(1);
      expect(t.fake.api.setMyCommands).toHaveBeenCalledWith(
        [
          { command: 'help', description: 'List the commands, or show how to use one' },
          { command: 'status', description: 'Does status' },
          { command: 'sensors_read', description: 'Does sensors_read' },
          { command: 'bhyve_devices', description: 'Does bhyve_devices' },
        ],
        OWNER.id,
      );
      expect(t.fake.api.getUpdates).toHaveBeenCalledWith({ timeoutSeconds: 50, signal: expect.any(AbortSignal) });
      expect(t.bot.username).toBe('LawnBot');
      expect(t.bot.running).toBe(true);
    });

    it('works without the command menu if setting it fails', async () => {
      const t = track(setup());
      t.fake.api.setMyCommands.mockRejectedValueOnce(new Error('Telegram setMyCommands failed: 400 Bad Request'));
      await t.start();

      await t.send('/status');

      expect(t.replies).toEqual(['<b>status</b> ok']);
      expect(warn).toHaveBeenCalledWith('Telegram commands: could not set the command menu: Telegram setMyCommands failed: 400 Bad Request');
    });

    it('confirms updates by asking for the next id, and never handles one twice', async () => {
      const t = track(setup());
      await t.start();
      const first = t.msg('/status');

      t.fake.push(first, t.msg('hello'));
      await t.clock.advanceBy(0);
      expect(t.fake.api.getUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ offset: first.update_id + 2 }));

      t.fake.push(first); // Telegram re-sends an old one
      await t.clock.advanceBy(0);
      expect(t.status.run).toHaveBeenCalledTimes(1);
    });

    it('does not busy-loop if empty polls come back at once', async () => {
      const t = track(setup({ options: { minEmptyPollIntervalMs: 1000 } }));
      t.fake.api.getUpdates.mockImplementation(async () => []);
      await t.start();
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);

      await t.clock.advanceBy(10 * SEC);

      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(11);
    });

    it('moves past an update it could not read', async () => {
      const t = track(setup());
      await t.start();

      t.fake.push({ update_id: 77 });
      await t.clock.advanceBy(0);

      expect(t.fake.api.getUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 78 }));
    });

    it('retries with back-off after network errors, warning once per outage', async () => {
      const t = track(setup({ options: { retryDelaysMs: [1 * SEC, 5 * SEC] } }));
      await t.start();

      t.fake.fail(new Error('Telegram getUpdates timed out after 65s'));
      await t.clock.advanceBy(0);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);
      await t.clock.advanceBy(1 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(2);

      t.fake.fail(new Error('fetch failed'));
      await t.clock.advanceBy(4.9 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(2);
      await t.clock.advanceBy(0.1 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(3);

      t.fake.fail(new Error('fetch failed'));
      await t.clock.advanceBy(5 * SEC); // the last delay repeats
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Telegram commands: Telegram getUpdates timed out after 65s; retrying in 1 s');

      await t.send('/status');
      expect(t.replies).toEqual(['<b>status</b> ok']);
    });

    it('retries getMe until Telegram answers', async () => {
      const t = track(setup({ options: { retryDelaysMs: [2 * SEC] } }));
      t.fake.api.getMe.mockRejectedValueOnce(new Error('fetch failed'));
      await t.start();
      expect(t.fake.api.getUpdates).not.toHaveBeenCalled();

      await t.clock.advanceBy(2 * SEC);

      expect(t.fake.api.getMe).toHaveBeenCalledTimes(2);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);
    });

    it('waits as long as Telegram asks when rate-limited', async () => {
      const t = track(setup());
      await t.start();

      t.fake.fail(new TelegramRateLimitError(30));
      await t.clock.advanceBy(29.9 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);
      await t.clock.advanceBy(0.1 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(2);
    });

    it('backs off on a conflict (another poller or a webhook) and explains it', async () => {
      const t = track(setup({ options: { conflictDelayMs: 60 * SEC } }));
      await t.start();

      t.fake.fail(new TelegramConflictError('Telegram getUpdates failed: 409 Conflict: terminated by other getUpdates request'));
      await t.clock.advanceBy(59 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);
      await t.clock.advanceBy(1 * SEC);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is another conductor running with this bot token, or a webhook set?'));
    });

    it('stops for good on a permanent error such as a revoked token (fails closed)', async () => {
      const t = track(setup());
      await t.start();

      t.fake.fail(new TelegramPermanentError('Telegram getUpdates failed: 401 Unauthorized'));
      await t.clock.advanceBy(10 * 60 * SEC);

      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);
      expect(t.bot.running).toBe(false);
      expect(error).toHaveBeenCalledWith('Telegram commands are off until restart: Telegram getUpdates failed: 401 Unauthorized');
    });

    it('stops for good if getMe says the token is bad', async () => {
      const t = track(setup());
      t.fake.api.getMe.mockRejectedValueOnce(new TelegramPermanentError('Telegram getMe failed: 401 Unauthorized'));
      await t.start();

      expect(t.bot.running).toBe(false);
      expect(t.fake.api.getUpdates).not.toHaveBeenCalled();
    });
  });

  describe('start and stop', () => {
    it('stop() ends a long poll at once', async () => {
      const t = setup();
      await t.start();
      expect(t.fake.polling).toBe(true);

      await t.bot.stop();

      expect(t.fake.polling).toBe(false);
      expect(t.bot.running).toBe(false);
      expect(warn).not.toHaveBeenCalled(); // a shutdown is not an error
    });

    it('stop() ends a back-off wait at once', async () => {
      const t = setup({ options: { retryDelaysMs: [60 * SEC] } });
      await t.start();
      t.fake.fail(new Error('fetch failed'));
      await t.clock.advanceBy(0);

      await t.bot.stop();

      expect(t.bot.running).toBe(false);
      expect(t.clock.pendingTimers).toBe(0);
    });

    it('stop() does not wait for a hanging command, and nothing is replied afterwards', async () => {
      const t = setup();
      let finish: (v: string) => void = () => {};
      t.sensors.run.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
      await t.start();
      await t.send('/sensors_read', '/status');

      await t.bot.stop();
      finish('late');
      await t.clock.advanceBy(60 * SEC);

      expect(t.bot.running).toBe(false);
      expect(t.replies).toEqual([]);
      expect(t.status.run).not.toHaveBeenCalled();
      expect(t.audit.ofType('command.handled')).toEqual([expect.objectContaining({ outcome: 'stopped' })]);
    });

    it('ignores a second start(), and can be stopped before it starts', async () => {
      const t = setup();
      await t.bot.stop();
      await t.start();
      t.bot.start();
      await t.clock.advanceBy(0);

      expect(t.fake.api.getMe).toHaveBeenCalledTimes(1);
      expect(t.fake.api.getUpdates).toHaveBeenCalledTimes(1);
      await t.bot.stop();
    });

    it('can be started again after stop(), keeping its place in the update stream', async () => {
      const t = setup();
      await t.start();
      const first = t.msg('/status');
      await t.send(first);
      await t.bot.stop();

      await t.start();

      expect(t.fake.api.getMe).toHaveBeenCalledTimes(1);
      expect(t.fake.api.getUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ offset: first.update_id + 1 }));
      await t.bot.stop();
    });
  });

  describe('hostile input', () => {
    const texts = [
      '/',
      '//status',
      '/status\u0000',
      '/status\u202e',
      '/ＳＴＡＴＵＳ',
      '/status@',
      '/status@LawnBot@LawnBot',
      '/status@LawnBot extra',
      '/__proto__',
      '/constructor',
      '/toString',
      '/hasOwnProperty',
      `/${'x'.repeat(10_000)}`,
      `/status${' '.repeat(10_000)}`,
      '/<b>status</b>',
      '/status & rm -rf /',
      '/bhyve_cmd start dev1 1 240',
      '/start_watering',
      '/stop',
      '/delay',
    ];

    it('never runs a command for anything but the exact command, and never crashes', async () => {
      const t = track(setup({ options: { maxCommandsPerWindow: 1000 } }));
      await t.start();

      for (const text of texts) await t.send(text);

      expect(t.status.run).not.toHaveBeenCalled();
      expect(t.sensors.run).not.toHaveBeenCalled();
      expect(t.devices.run).not.toHaveBeenCalled();
      expect(t.bot.running).toBe(true);
      expect(error).not.toHaveBeenCalled();
      // Every reply is well-formed: no raw "<" from the input ever reaches Telegram's HTML parser.
      for (const r of t.replies) expect(r.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);
      expect(t.replies.every((r) => r.length < 200)).toBe(true);
    });

    it('treats /start as help only: it never starts anything', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/start');

      expect(t.replies[0]).toMatch(/^🌱 <b>Lawn conductor commands<\/b>/);
      for (const c of [t.status, t.sensors, t.devices]) expect(c.run).not.toHaveBeenCalled();
    });
  });
});
