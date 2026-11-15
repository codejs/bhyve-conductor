import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { CommandPolicy } from '../../bot/auth.ts';
import { CommandBot, type CommandBotOptions } from '../../bot/bot.ts';
import { ask, type BotCommand, type InteractiveCommand, type MutableCommand, type QueryCommand, type Step } from '../../bot/conversation.ts';
import { VirtualClock } from '../../clock.ts';
import { log } from '../../log.ts';
import type { TelegramMessage, TelegramUpdate } from '../../notify/telegram.ts';
import { fakeBotApi, FAMILY, GROUP_ID, OWNER, STRANGER, updates } from '../utils/fake-telegram.ts';

const START = new Date('2026-07-01T12:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;
const PASS = 'open sesame 42';

const PRIVATE: CommandPolicy = { chatId: OWNER.id, userIds: new Set([OWNER.id]) };
const GROUP: CommandPolicy = { chatId: GROUP_ID, userIds: new Set([OWNER.id, FAMILY.id]) };
const inGroup = (from = OWNER): Partial<TelegramMessage> => ({ chat: { id: GROUP_ID, type: 'supergroup' }, from });

/**
 * Scripted commands, so the conversation engine is tested on its own:
 *   /pause:  "Pause anyway?" yes → passphrase → run
 *   /resume: continue / discard → passphrase → run (records the choice)
 *   /now:    straight to the passphrase
 *   /noop:   nothing to do
 */
const scripted = () => {
  const pauseRun = vi.fn(async () => '⏸️ <b>Paused</b>');
  const resumeRun = vi.fn(async (held: string) => `▶️ <b>Resumed</b> (${held})`);
  const nowRun = vi.fn(async () => '✅ done now');
  const passphraseStep = (text: string, run: () => Promise<string>): Step => ({ kind: 'passphrase', text, run });
  const pause: MutableCommand = {
    kind: 'mutable',
    name: 'pause',
    description: 'Pause watering',
    begin: vi.fn(
      (): Step =>
        ask({
          text: '⚠️ Watering in progress. Pause anyway? Reply <b>yes</b> or <b>cancel</b>.',
          hint: 'Reply yes to pause, or cancel.',
          choices: [{ words: ['yes', 'y', 'confirm', 'ok'], label: 'yes', next: () => passphraseStep('🔐 Send the passphrase to pause.', pauseRun) }],
        }),
    ),
  };
  const resume: MutableCommand = {
    kind: 'mutable',
    name: 'resume',
    description: 'Resume watering',
    begin: vi.fn(
      (): Step =>
        ask({
          text: 'Reply <b>continue</b>, <b>discard</b> or <b>cancel</b>.',
          hint: 'Reply continue, discard or cancel.',
          choices: [
            { words: ['continue', '1'], label: 'continue', next: () => passphraseStep('🔐 Passphrase to resume and continue.', () => resumeRun('continue')) },
            { words: ['discard', '2'], label: 'discard', next: () => passphraseStep('🔐 Passphrase to resume and discard.', () => resumeRun('discard')) },
          ],
        }),
    ),
  };
  const now: MutableCommand = { kind: 'mutable', name: 'now', description: 'Do it now', begin: () => passphraseStep('🔐 Passphrase?', nowRun) };
  const noop: MutableCommand = { kind: 'mutable', name: 'noop', description: 'Nothing', begin: () => ({ kind: 'done', text: '⏸️ Already paused.' }) };
  return { pause, resume, now, noop, pauseRun, resumeRun, nowRun };
};

const statusCommand = (): QueryCommand & { run: ReturnType<typeof vi.fn> } => ({
  kind: 'query',
  name: 'status',
  description: 'Status',
  cooldownSeconds: 0,
  run: vi.fn(async () => '🌱 status'),
});

const setup = (opts: { policy?: CommandPolicy; options?: Partial<CommandBotOptions>; commands?: BotCommand[] } = {}) => {
  const clock = new VirtualClock(START);
  const fake = fakeBotApi();
  const audit = new MemoryAuditLog(() => clock.now());
  const replies: string[] = [];
  const s = scripted();
  const status = statusCommand();
  const bot = new CommandBot({
    api: fake.bot,
    policy: opts.policy ?? PRIVATE,
    commands: opts.commands ?? [status, s.pause, s.resume, s.now, s.noop],
    passphrase: PASS,
    reply: (html) => replies.push(html),
    audit,
    clock,
    options: { conversationTimeoutMs: 2 * MIN, maxMessageAgeSeconds: 120, ...opts.options },
  });
  const msg = updates(clock);
  /** Sends messages (text, or [text, overrides], or a prepared update) in one batch and lets the bot handle them. */
  const send = async (...items: (string | Parameters<typeof msg> | TelegramUpdate)[]) => {
    const batch = items.map((t) => (typeof t === 'string' ? msg(t) : Array.isArray(t) ? msg(...t) : t));
    fake.push(...batch);
    await clock.advanceBy(0);
    return batch;
  };
  return {
    ...s,
    clock,
    fake,
    audit,
    replies,
    bot,
    msg,
    status,
    send,
    start: async () => {
      bot.start();
      await clock.advanceBy(0);
    },
    /** Texts of the conversation messages (sent directly). */
    said: () => fake.texts(),
    handled: () => audit.ofType('command.handled').filter((e) => e.command !== 'status'),
  };
};

type T = ReturnType<typeof setup>;

describe('CommandBot conversations', () => {
  let logs: MockInstance[];
  beforeEach(() => {
    logs = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(log, level).mockImplementation(() => {}));
  });

  let active: CommandBot[] = [];
  const track = (t: T): T => {
    active.push(t.bot);
    return t;
  };
  afterEach(async () => {
    for (const bot of active) await bot.stop();
    active = [];
  });

  /** The passphrase must never be written anywhere but the (deleted) message itself. */
  const expectNoLeak = (t: T) => {
    const everything = JSON.stringify([t.audit.events, t.replies, t.fake.sent, logs.map((l) => l.mock.calls)]);
    expect(everything).not.toContain(PASS);
  };

  describe('the happy path', () => {
    it('confirm → passphrase → runs, and the passphrase message is deleted', async () => {
      const t = track(setup());
      await t.start();

      const [cmd] = await t.send('/pause');
      expect(t.fake.sent).toEqual([
        {
          html: '⚠️ Watering in progress. Pause anyway? Reply <b>yes</b> or <b>cancel</b>.',
          opts: { replyToMessageId: cmd?.message?.message_id, forceReply: true, placeholder: 'your answer' },
        },
      ]);
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });

      const [yes] = await t.send('yes');
      expect(t.fake.sent.at(-1)).toEqual({
        html: '🔐 Send the passphrase to pause.',
        opts: { replyToMessageId: yes?.message?.message_id, forceReply: true, placeholder: 'passphrase or cancel' },
      });
      expect(t.pauseRun).not.toHaveBeenCalled();

      const [secret] = await t.send(PASS);
      expect(t.pauseRun).toHaveBeenCalledOnce();
      expect(t.fake.deleted).toEqual([secret?.message?.message_id]);
      expect(t.said().at(-1)).toBe('⏸️ <b>Paused</b>');
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'pause', user: OWNER.id, userName: 'owner', outcome: 'ok', choice: 'yes' })]);
      expect(t.replies).toEqual([]); // conversation messages don't go through the notification queue
      expectNoLeak(t);
    });

    it('goes straight to the passphrase when the command needs no confirmation', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/now');
      expect(t.said()).toEqual(['🔐 Passphrase?']);
      await t.send(PASS);

      expect(t.nowRun).toHaveBeenCalledOnce();
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'now', outcome: 'ok' })]);
    });

    it('ends at once, without the passphrase, when there is nothing to do', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/noop');

      expect(t.said()).toEqual(['⏸️ Already paused.']);
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'noop', outcome: 'nothing-to-do' })]);
    });

    it.each([
      ['continue', 'continue'],
      ['1', 'continue'],
      ['Discard!', 'discard'],
      ['  2 ', 'discard'],
    ])('routes the choice %j to %s', async (answer, held) => {
      const t = track(setup());
      await t.start();

      await t.send('/resume', answer, PASS);

      expect(t.resumeRun).toHaveBeenCalledWith(held);
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'ok', choice: held })]);
    });

    it.each(['YES', 'Yes!', ' y ', 'ok', 'confirm.'])('accepts %j as yes', async (answer) => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', answer, PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it('accepts the passphrase with surrounding spaces', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/now', `  ${PASS}  `);

      expect(t.nowRun).toHaveBeenCalledOnce();
    });

    it('handles answers that arrive in the same batch, in order', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it('works in a group, for the allowed user who started it', async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/pause', inGroup(FAMILY)], ['yes', inGroup(FAMILY)], [PASS, inGroup(FAMILY)]);

      expect(t.pauseRun).toHaveBeenCalledOnce();
      expect(t.handled()).toEqual([expect.objectContaining({ user: FAMILY.id, outcome: 'ok' })]);
    });
  });

  describe('cancelling', () => {
    it.each(['cancel', 'Cancel', 'no', 'NO!', 'n', 'stop', 'abort', 'nope'])('%j at the question cancels', async (answer) => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', answer);

      expect(t.said().at(-1)).toBe('✋ /pause cancelled. Nothing changed.');
      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
    });

    it('"cancel" at the passphrase cancels (it is not a wrong passphrase)', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', 'cancel');

      expect(t.said().at(-1)).toBe('✋ /pause cancelled. Nothing changed.');
      expect(t.audit.ofType('command.auth_failed')).toEqual([]);
      expect(t.pauseRun).not.toHaveBeenCalled();
    });

    it('/cancel cancels at any step', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', '/cancel');
      await t.send('/pause', 'yes', '/cancel');

      expect(t.said().filter((s) => s === '✋ /pause cancelled. Nothing changed.')).toHaveLength(2);
      expect(t.pauseRun).not.toHaveBeenCalled();
    });

    it('/cancel with nothing pending says so', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/cancel');

      expect(t.said()).toEqual(['Nothing to cancel.']);
    });

    it("/cancel cannot cancel someone else's conversation", async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ['/cancel', inGroup(FAMILY)]);

      expect(t.said().at(-1)).toBe('Nothing of yours to cancel (@owner is answering /pause).');
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
    });
  });

  describe('wrong passphrase', () => {
    it('does not run the command, ends the conversation, deletes the message, and records it', async () => {
      const t = track(setup());
      await t.start();

      const [, , wrong] = await t.send('/pause', 'yes', 'open sesame 41');

      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.said().at(-1)).toBe('❌ Wrong passphrase: /pause was not run.');
      expect(t.fake.deleted).toEqual([wrong?.message?.message_id]);
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.audit.ofType('command.auth_failed')).toEqual([expect.objectContaining({ command: 'pause', user: OWNER.id, userName: 'owner', failures: 1 })]);
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'denied' })]);
      expect(JSON.stringify(t.audit.events)).not.toContain('open sesame 41');
    });

    it('gives no second try: the passphrase typed again afterwards runs nothing, and is deleted (whatever it is)', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', 'wrong-passphrase');
      const [retyped] = await t.send(PASS);

      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.fake.deleted).toContain(retyped?.message?.message_id);
      expect(t.said().at(-1)).toBe('Nothing was waiting for an answer, so nothing was run. I deleted your message in case it was the passphrase.');
      expectNoLeak(t);
    });

    it('deletes only the next message after a wrong passphrase, and only if it could be one', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', 'wrong-passphrase');
      await t.send('ok'); // too short / an answer word: left alone, and nothing said
      const [again] = await t.send('wrong-again-1');
      const [chat] = await t.send('and then some ordinary chat');

      expect(t.fake.deleted).toEqual([expect.any(Number), again?.message?.message_id]); // the wrong answer itself, then the retry
      expect(t.fake.deleted).not.toContain(chat?.message?.message_id);
    });

    it('does not delete what follows a change that worked', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/now', PASS);
      const [thanks] = await t.send('thanks, that was quick');

      expect(t.fake.deleted).not.toContain(thanks?.message?.message_id);
    });

    it.each(['x'.repeat(5000), PASS.toUpperCase(), `${PASS}.`, PASS.replace(' ', '  '), 'abcdefgh'])('treats %j as wrong', async (answer) => {
      const t = track(setup());
      await t.start();

      await t.send('/now', answer);

      expect(t.nowRun).not.toHaveBeenCalled();
      expect(t.audit.ofType('command.auth_failed')).toHaveLength(1);
    });

    it('locks changes after too many wrong passphrases, and unlocks later', async () => {
      const t = track(setup({ options: { maxPassphraseFailures: 3, lockoutMs: 15 * MIN } }));
      await t.start();

      await t.send('/now', 'wrong-one-1');
      await t.send('/now', 'wrong-one-2');
      await t.send('/now', 'wrong-one-3');

      expect(t.said().at(-1)).toBe(
        '❌ Wrong passphrase: /now was not run.\n🔒 Changes are now locked for 15 min. If that wasn\'t you, someone can post as an allowed user: ' +
          'end their Telegram sessions and change the passphrase.',
      );
      expect(t.audit.ofType('command.locked')).toEqual([
        expect.objectContaining({ until: new Date(START.getTime() + 15 * MIN).toISOString(), failures: 3, user: OWNER.id }),
      ]);

      await t.clock.advanceBy(14 * MIN);
      await t.send('/pause');
      expect(t.said().at(-1)).toBe('🔒 Changes are locked for another 60 s after too many wrong passphrases. /pause was not run.');
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled().at(-1)).toMatchObject({ command: 'pause', outcome: 'locked' });

      await t.send('/status'); // read-only commands are not locked
      expect(t.status.run).toHaveBeenCalledOnce();

      await t.clock.advanceBy(1 * MIN);
      await t.send('/now', PASS);
      expect(t.nowRun).toHaveBeenCalledOnce();
    });

    it('locks for longer each time, and starts afresh after the right passphrase', async () => {
      const t = track(setup({ options: { maxPassphraseFailures: 1, lockoutMs: 15 * MIN } }));
      await t.start();

      await t.send('/now', 'wrong-one-1');
      expect(t.said().at(-1)).toContain('🔒 Changes are now locked for 15 min.');
      await t.clock.advanceBy(15 * MIN);
      await t.send('/now', 'wrong-one-2');
      expect(t.said().at(-1)).toContain('🔒 Changes are now locked for 30 min.');
      await t.clock.advanceBy(29 * MIN);
      await t.send('/now');
      expect(t.said().at(-1)).toBe('🔒 Changes are locked for another 60 s after too many wrong passphrases. /now was not run.');
      await t.clock.advanceBy(MIN);
      await t.send('/now', PASS);
      expect(t.nowRun).toHaveBeenCalledOnce();
      await t.send('/now', 'wrong-one-3');
      expect(t.said().at(-1)).toContain('🔒 Changes are now locked for 15 min.');
      expect(t.audit.ofType('command.locked').map((e) => e.until)).toEqual([
        new Date(START.getTime() + 15 * MIN).toISOString(),
        new Date(START.getTime() + 45 * MIN).toISOString(),
        new Date(START.getTime() + 60 * MIN).toISOString(),
      ]);
    });

    it('only counts recent failures towards the lock', async () => {
      const t = track(setup({ options: { maxPassphraseFailures: 3, passphraseFailureWindowMs: 15 * MIN } }));
      await t.start();

      await t.send('/now', 'wrong-one-1');
      await t.send('/now', 'wrong-one-2');
      await t.clock.advanceBy(16 * MIN);
      await t.send('/now', 'wrong-one-3');

      expect(t.audit.ofType('command.locked')).toEqual([]);
      expect(t.audit.ofType('command.auth_failed').at(-1)?.failures).toBe(1);
    });

    it('forgets earlier failures after the right passphrase', async () => {
      const t = track(setup({ options: { maxPassphraseFailures: 3 } }));
      await t.start();

      await t.send('/now', 'wrong-one-1');
      await t.send('/now', 'wrong-one-2');
      await t.send('/now', PASS);
      await t.send('/now', 'wrong-one-3');

      expect(t.audit.ofType('command.locked')).toEqual([]);
    });
  });

  describe('unexpected answers', () => {
    it.each(['maybe', 'sure', '👍', 'resume', 'discard'])('asks again after %j, then gives up', async (answer) => {
      const t = track(setup({ options: { maxInvalidAnswers: 3 } }));
      await t.start();

      const [, first] = await t.send('/pause', answer);
      expect(t.fake.sent.at(-1)).toEqual({
        html: "🤔 I didn't get that. Reply yes to pause, or cancel.",
        opts: { replyToMessageId: first?.message?.message_id, forceReply: true, placeholder: 'your answer' },
      });
      await t.send(answer);
      expect(t.bot.pendingConversation).toBeDefined();
      await t.send(answer);

      expect(t.said().at(-1)).toBe('🤷 Too many unexpected answers: /pause cancelled. Nothing changed.');
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'aborted' })]);
    });

    it('deletes any long answer that fits nothing in a change (it could be the passphrase), never looking at what it is', async () => {
      const t = track(setup());
      await t.start();

      const [, a] = await t.send('/pause', 'yes please');
      const [b] = await t.send(PASS);

      expect(t.fake.deleted).toEqual([a?.message?.message_id, b?.message?.message_id]); // the same for both
      expect(t.said().at(-1)).toBe(t.said().at(-2));
      expect(t.pauseRun).not.toHaveBeenCalled();
    });

    it('still accepts a valid answer after an unexpected one', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'hmm', 'yes', PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it('counts unexpected answers per question', async () => {
      const t = track(setup({ options: { maxInvalidAnswers: 3 } }));
      await t.start();

      await t.send('/pause', 'hmm', 'what', 'yes', 'y', 'ok', PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it.each(['28', ' ', 'abc', '1234567'])(
      'asks again after %j at the passphrase question (too short to be the passphrase, e.g. a late answer to a question)',
      async (answer) => {
        const t = track(setup());
        await t.start();

        const [, short] = await t.send('/now', answer);

        expect(t.fake.sent.at(-1)).toEqual({
          html: "🔐 That's too short to be the passphrase. Send the passphrase, or <b>cancel</b>.",
          opts: { replyToMessageId: short?.message?.message_id, forceReply: true, placeholder: 'passphrase or cancel' },
        });
        expect(t.audit.ofType('command.auth_failed')).toEqual([]);
        expect(t.fake.deleted).toEqual([]);
        await t.send(PASS);
        expect(t.nowRun).toHaveBeenCalledOnce();
      },
    );

    it('still gives up after too many short answers at the passphrase question', async () => {
      const t = track(setup({ options: { maxInvalidAnswers: 3 } }));
      await t.start();

      await t.send('/now', '1', '2', '3');

      expect(t.said().at(-1)).toBe('🤷 Too many unexpected answers: /now cancelled. Nothing changed.');
      expect(t.nowRun).not.toHaveBeenCalled();
    });

    it('"yes" (an answer word) at the passphrase question is asked again, not counted as a wrong passphrase', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', 'yes');

      expect(t.said().at(-1)).toBe('🔐 That was an answer word, not the passphrase. Send the passphrase, or <b>cancel</b>.');
      expect(t.audit.ofType('command.auth_failed')).toEqual([]);
      expect(t.fake.deleted).toEqual([]);
      await t.send(PASS);
      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it('"yes" for a question that wants continue/discard is asked again', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/resume', 'yes');

      expect(t.said().at(-1)).toBe("🤔 I didn't get that. Reply continue, discard or cancel.");
      expect(t.resumeRun).not.toHaveBeenCalled();
    });

    it('the passphrase sent too early (at the confirmation) is deleted and does not confirm anything', async () => {
      const t = track(setup());
      await t.start();

      const [, early] = await t.send('/pause', PASS);

      expect(t.fake.deleted).toEqual([early?.message?.message_id]);
      expect(t.said().at(-1)).toBe(
        '🔐 I deleted your message in case it was the passphrase. Answer this question first; the passphrase comes last. ' +
          'Reply yes to pause, or cancel.',
      );
      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.bot.pendingConversation).toBeDefined();
      await t.send('yes', PASS);
      expect(t.pauseRun).toHaveBeenCalledOnce();
      expectNoLeak(t);
    });
  });

  describe('answer rate limit', () => {
    it('ignores answers beyond the limit (saying so once), then takes them again', async () => {
      const t = track(setup({ options: { maxAnswersPerWindow: 5, rateWindowMs: 60 * SEC, maxInvalidAnswers: 100 } }));
      await t.start();

      await t.send('/resume');
      await t.send(...Array.from({ length: 8 }, () => 'hmm'));

      expect(t.said().filter((x) => x.startsWith('🤔'))).toHaveLength(5);
      expect(t.replies).toEqual(['🐢 Too many answers; ignoring them for up to 60 s.']);
      await t.clock.advanceBy(60 * SEC);
      await t.send('continue', PASS);
      expect(t.resumeRun).toHaveBeenCalledWith('continue');
    });

    it('counts only answers, not other people chatting', async () => {
      const t = track(setup({ policy: GROUP, options: { maxAnswersPerWindow: 2 } }));
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ...Array.from({ length: 10 }, () => ['chat', inGroup(FAMILY)] as Parameters<typeof t.msg>));
      await t.send(['yes', inGroup(OWNER)], [PASS, inGroup(OWNER)]);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });
  });

  describe('no answer', () => {
    it('gives up after the timeout, changing nothing', async () => {
      const t = track(setup({ options: { conversationTimeoutMs: 2 * MIN } }));
      await t.start();

      await t.send('/pause');
      await t.clock.advanceBy(2 * MIN - 1);
      expect(t.bot.pendingConversation).toBeDefined();
      await t.clock.advanceBy(1);

      expect(t.said().at(-1)).toBe('⌛ No answer within 2 min: /pause cancelled. Nothing changed.');
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'expired' })]);
      expect(t.pauseRun).not.toHaveBeenCalled();
    });

    it('gives up at the passphrase question too', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes');
      await t.clock.advanceBy(2 * MIN);

      expect(t.said().at(-1)).toBe('⌛ No answer within 2 min: /pause cancelled. Nothing changed.');
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'expired', choice: 'yes' })]);
    });

    it('gives each question its own time', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause');
      await t.clock.advanceBy(110 * SEC);
      await t.send('yes');
      await t.clock.advanceBy(110 * SEC);
      await t.send(PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it('restarts the wait after asking again', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause');
      await t.clock.advanceBy(110 * SEC);
      await t.send('hmm');
      await t.clock.advanceBy(110 * SEC);

      expect(t.bot.pendingConversation).toBeDefined();
    });

    it('tells a late "yes" that it came too late, once, and does nothing', async () => {
      const t = track(setup({ options: { lateAnswerMs: 10 * MIN } }));
      await t.start();

      await t.send('/pause');
      await t.clock.advanceBy(3 * MIN);
      await t.send('yes');
      await t.send('yes');

      expect(t.said().filter((s) => s.startsWith('⌛ That question had expired'))).toEqual([
        '⌛ That question had expired, so nothing was done. Send /pause again if you still want to.',
      ]);
      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.bot.pendingConversation).toBeUndefined();
    });

    it('stays quiet about ordinary chat, and about answers long after expiry', async () => {
      const t = track(setup({ options: { lateAnswerMs: 10 * MIN } }));
      await t.start();

      await t.send('/pause');
      await t.clock.advanceBy(2 * MIN);
      const before = t.said().length;
      await t.send('thanks!');
      await t.clock.advanceBy(11 * MIN);
      await t.send('yes');

      expect(t.said()).toHaveLength(before);
    });

    it('deletes a late passphrase and runs nothing', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes');
      await t.clock.advanceBy(3 * MIN);
      const [late] = await t.send(PASS);

      expect(t.fake.deleted).toEqual([late?.message?.message_id]);
      expect(t.pauseRun).not.toHaveBeenCalled();
      expectNoLeak(t);
    });
  });

  describe('other messages during a conversation', () => {
    it('answers read-only commands and keeps the conversation going', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/resume', '/status', '/help');
      expect(t.replies[0]).toBe('🌱 status');
      expect(t.bot.pendingConversation).toEqual({ command: 'resume', userId: OWNER.id });

      await t.send('continue', PASS);
      expect(t.resumeRun).toHaveBeenCalledWith('continue');
    });

    it('replaces a pending change with a new one from the same person', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', '/resume');

      expect(t.said()).toContain('✋ The pending /pause was cancelled.');
      expect(t.bot.pendingConversation).toEqual({ command: 'resume', userId: OWNER.id });
      expect(t.handled()[0]).toMatchObject({ command: 'pause', outcome: 'superseded' });
      await t.send('yes'); // an answer to /pause no longer means anything
      expect(t.said().at(-1)).toBe("🤔 I didn't get that. Reply continue, discard or cancel.");
    });

    it('restarts the same command from the beginning', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', '/pause');

      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
      expect(t.said().at(-1)).toMatch(/^⚠️ Watering in progress/);
    });

    it("makes someone else wait rather than interfere with another person's change", async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ['/resume', inGroup(FAMILY)]);

      expect(t.said().at(-1)).toBe("⏳ @owner is answering /pause. Try again when that's done.");
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
      await t.send(['yes', inGroup(OWNER)], [PASS, inGroup(OWNER)]);
      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it("ignores other people's answers", async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ['yes', inGroup(FAMILY)], ['cancel', inGroup(FAMILY)]);

      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
      expect(t.said()).toHaveLength(1); // just the question
    });

    it("never compares someone else's message with the passphrase (nothing is deleted, nothing said)", async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ['yes', inGroup(OWNER)]);
      const before = t.said().length;
      await t.send([PASS, inGroup(FAMILY)]);

      expect(t.fake.deleted).toEqual([]);
      expect(t.said()).toHaveLength(before);
      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
    });

    it.each([
      ['forwarded', { forward_origin: { type: 'user', date: 1 } }],
      ['sent via a bot', { via_bot: { id: 1, is_bot: true } }],
      ['from another chat', { chat: { id: 999, type: 'private' } }],
      ['from a bot', { from: { ...OWNER, is_bot: true } }],
    ])('ignores an answer %s', async (_, overrides) => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', ['yes', overrides as Partial<TelegramMessage>]);

      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
      expect(t.said()).toHaveLength(1);
    });

    it('ignores a stale answer, but still deletes a stale passphrase', async () => {
      const t = track(setup());
      await t.start();
      const old = Math.floor(START.getTime() / 1000) - 600;

      await t.send('/pause', ['yes', { date: old }]);
      expect(t.said()).toHaveLength(1);
      await t.send('yes');
      const [stale] = await t.send([PASS, { date: old }]);

      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.fake.deleted).toEqual([stale?.message?.message_id]);
      expect(t.said().at(-1)).toBe('🔐 Your message was too old to act on; nothing was run. I deleted your message in case it was the passphrase.');
      expectNoLeak(t);
    });

    it('leaves a stale message alone when no passphrase was asked for', async () => {
      const t = track(setup());
      await t.start();
      const [stale] = await t.send([PASS, { date: Math.floor(START.getTime() / 1000) - 600 }]);

      expect(t.fake.deleted).not.toContain(stale?.message?.message_id);
      expect(t.said()).toEqual([]);
    });

    it('ignores a stranger typing the passphrase (never even compared), and records nothing', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes');
      await t.send([PASS, { chat: { id: STRANGER.id, type: 'private' }, from: STRANGER }]);

      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.audit.ofType('command.auth_failed')).toEqual([]);
      expect(t.bot.pendingConversation).toBeDefined();
    });
  });

  describe('the passphrase is never a guessing oracle', () => {
    /**
     * If the bot deleted messages that contain the passphrase, an attacker holding an allowed account could
     * send thousands of guesses and watch which message disappears, without ever touching the lockout. So
     * outside the passphrase question, the passphrase is never compared with anything: a message holding it
     * must be treated exactly like one that doesn't.
     */
    const behaviour = async (text: string) => {
      const t = track(setup());
      await t.start();
      await t.send(text);
      return { deleted: t.fake.deleted.length, said: t.said(), replies: t.replies, audit: t.audit.events.map((e) => e.type) };
    };

    it.each([
      (p: string) => p,
      (p: string) => `btw the passphrase is ${p}`,
      (p: string) => Array.from({ length: 50 }, (_, i) => `guess${i}`).concat(p).join(' '),
      (p: string) => `${p.toUpperCase()} ${p}`,
    ])('treats an ordinary message holding the passphrase like any other (%#)', async (make) => {
      expect(await behaviour(make(PASS))).toEqual(await behaviour(make('not the passphrase!')));
      expect((await behaviour(make(PASS))).deleted).toBe(0);
    });

    it('treats a read-only command holding it like any other', async () => {
      expect(await behaviour(`/status ${PASS}`)).toEqual(await behaviour('/status not-the-passphrase'));
    });

    it('deletes a right and a wrong passphrase at the passphrase question alike (and only the wrong one counts)', async () => {
      const t = track(setup());
      await t.start();

      const [, wrong] = await t.send('/now', 'not-the-passphrase');
      const [, right] = await t.send('/now', PASS);

      expect(t.fake.deleted).toEqual([wrong?.message?.message_id, right?.message?.message_id]);
      expect(t.audit.ofType('command.auth_failed')).toHaveLength(1);
    });

    it('deletes text after a change command if it could be the passphrase, whatever it is, and starts nothing', async () => {
      const t = track(setup());
      await t.start();

      const [a] = await t.send(`/pause ${PASS}`);
      const [b] = await t.send('/pause not-the-passphrase');
      const [c] = await t.send('/pause now'); // too short to be one: left alone

      expect(t.fake.deleted).toEqual([a?.message?.message_id, b?.message?.message_id]);
      expect(t.fake.deleted).not.toContain(c?.message?.message_id);
      expect(t.replies[0]).toBe(
        "⚠️ /pause takes no arguments. Send it alone; I ask for the passphrase when it's needed. I deleted your message in case it was the passphrase.",
      );
      expect(t.replies[1]).toBe(t.replies[0]);
      expect(t.replies[2]).toBe('⚠️ /pause takes no arguments.');
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.pauseRun).not.toHaveBeenCalled();
      expectNoLeak(t);
    });

    it('says when it could not delete something that could be the passphrase', async () => {
      const t = track(setup());
      t.fake.api.deleteMessage.mockRejectedValue(new Error("Telegram deleteMessage failed: 400 Bad Request: message can't be deleted"));
      await t.start();

      await t.send(`/pause ${PASS}`);

      expect(t.replies[0]).toMatch(/⚠️ I couldn't delete your message \(in a group I need the “Delete messages” admin right\): please delete it yourself, in case it was the passphrase\.$/);
    });
  });

  describe('failures', () => {
    it('still runs the command when its passphrase message cannot be deleted, and asks the user to delete it', async () => {
      const t = track(setup());
      t.fake.api.deleteMessage.mockRejectedValueOnce(new Error('Telegram deleteMessage failed: 400'));
      await t.start();

      await t.send('/now', PASS);

      expect(t.nowRun).toHaveBeenCalledOnce();
      expect(t.said().at(-1)).toBe(
        '✅ done now\n\n⚠️ I couldn\'t delete your passphrase message (in a group I need the “Delete messages” admin right): please delete it yourself.',
      );
    });

    it('reports a failing first step; nothing is left pending', async () => {
      const broken: MutableCommand = {
        kind: 'mutable',
        name: 'pause',
        description: 'x',
        begin: () => {
          throw new Error('status unavailable');
        },
      };
      const t = track(setup({ commands: [broken] }));
      await t.start();

      await t.send('/pause');

      expect(t.said()).toEqual(['❌ /pause failed: status unavailable. Nothing changed.']);
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'failed', error: 'status unavailable' })]);
    });

    it('reports a failing choice', async () => {
      const t = track(setup());
      vi.mocked(t.pause.begin).mockReturnValueOnce(
        ask({
          text: 'Pause?',
          hint: 'yes or cancel',
          choices: [
            {
              words: ['yes'],
              label: 'yes',
              next: () => {
                throw new Error('boom');
              },
            },
          ],
        }),
      );
      await t.start();

      await t.send('/pause', 'yes');

      expect(t.said().at(-1)).toBe('❌ /pause failed: boom. Nothing changed.');
      expect(t.bot.pendingConversation).toBeUndefined();
    });

    it('reports a failing change, without pretending to know whether it happened', async () => {
      const t = track(setup());
      t.nowRun.mockRejectedValueOnce(new Error('could not save state'));
      await t.start();

      await t.send('/now', PASS);

      expect(t.said().at(-1)).toBe('❌ /now failed: could not save state. It may or may not have taken effect: check /status.');
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'failed', error: 'could not save state' })]);
    });

    it('times out a change that hangs', async () => {
      const t = track(setup({ options: { commandTimeoutMs: 10 * SEC } }));
      t.nowRun.mockImplementationOnce(() => new Promise(() => {}));
      await t.start();

      await t.send('/now', PASS);
      await t.clock.advanceBy(10 * SEC);

      expect(t.said().at(-1)).toBe('❌ /now failed: no answer within 10 s. It may or may not have taken effect: check /status.');
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'timed_out' })]);
      expect(t.bot.pendingConversation).toBeUndefined();
    });

    it('falls back to the notification queue when a question cannot be sent directly, and keeps waiting', async () => {
      const t = track(setup());
      t.fake.api.sendMessage.mockRejectedValueOnce(new Error('Telegram sendMessage failed: 502'));
      await t.start();

      await t.send('/pause');
      expect(t.replies).toEqual(['⚠️ Watering in progress. Pause anyway? Reply <b>yes</b> or <b>cancel</b>.']);
      await t.send('yes', PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });
  });

  describe('stopping', () => {
    it('drops a pending conversation quietly, and nothing fires later', async () => {
      const t = setup();
      await t.start();
      await t.send('/pause');

      await t.bot.stop();
      const before = t.said().length;
      await t.clock.advanceBy(10 * MIN);

      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.said()).toHaveLength(before);
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'stopped' })]);
      expect(t.clock.pendingTimers).toBe(0);
    });

    it('abandons a change that is still running', async () => {
      const t = setup();
      t.nowRun.mockImplementationOnce(() => new Promise(() => {}));
      await t.start();
      await t.send('/now', PASS);

      await t.bot.stop();

      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'stopped' })]);
    });

    it('ends the conversation when Telegram rejects the token', async () => {
      const t = setup();
      await t.start();
      await t.send('/pause');

      const { TelegramPermanentError } = await import('../../notify/telegram.ts');
      t.fake.fail(new TelegramPermanentError('Telegram getUpdates failed: 401 Unauthorized'));
      await t.clock.advanceBy(10 * MIN);

      expect(t.bot.running).toBe(false);
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.clock.pendingTimers).toBe(0);
    });
  });

  describe('setup', () => {
    it('refuses commands that change something without a passphrase (fails closed)', () => {
      const { bot: api } = fakeBotApi();
      const { pause } = scripted();
      expect(() => new CommandBot({ api, policy: PRIVATE, commands: [pause], reply: () => {} })).toThrow(
        '/pause need a passphrase (TELEGRAM_COMMAND_PASSPHRASE)',
      );
    });

    it('refuses an unusable passphrase', () => {
      const { bot: api } = fakeBotApi();
      const { pause } = scripted();
      expect(() => new CommandBot({ api, policy: PRIVATE, commands: [pause], passphrase: 'short', reply: () => {} })).toThrow(
        'TELEGRAM_COMMAND_PASSPHRASE must be at least 8 characters',
      );
    });

    it('refuses a command named like a built-in', () => {
      const { bot: api } = fakeBotApi();
      const cancel: MutableCommand = { kind: 'mutable', name: 'cancel', description: 'x', begin: () => ({ kind: 'done', text: '' }) };
      expect(() => new CommandBot({ api, policy: PRIVATE, commands: [cancel], passphrase: PASS, reply: () => {} })).toThrow(
        'duplicate bot command /cancel',
      );
    });

    it('lists the changes separately in /help and in the command menu, with /cancel', async () => {
      const t = track(setup({ commands: [statusCommand(), scripted().pause, scripted().resume] }));
      await t.start();

      await t.send('/help');

      expect(t.replies[0]).toBe(
        [
          '🌱 <b>Lawn conductor commands</b>',
          '/status: Status',
          '/help: this list, or how to use a command',
          '',
          '<b>Changes</b> (each asks for the passphrase):',
          '/pause: Pause watering',
          '/resume: Resume watering',
          '/cancel: cancel a pending change',
          '',
          'Send <b>/help</b> <i>command</i> to see how to use one, e.g. /help audit.',
        ].join('\n'),
      );
      expect(t.fake.api.setMyCommands.mock.calls[0]?.[0].map((c) => c.command)).toEqual(['help', 'status', 'pause', 'resume', 'cancel']);
    });

    it('counts changes towards the rate limit', async () => {
      const t = track(setup({ options: { maxCommandsPerWindow: 2 } }));
      await t.start();

      await t.send('/pause', '/pause', '/pause');

      expect(t.replies).toEqual(['🐢 Too many commands; ignoring them for up to 60 s.']);
      expect(t.pause.begin).toHaveBeenCalledTimes(2);
    });
  });

  describe('read-only conversations and free-form answers', () => {
    /** /browse: an interactive (read-only) command with pages; "/browse 2" starts on page 2. */
    const browse = () => {
      const read = vi.fn();
      const page = (n: number): Step => ({
        kind: 'input',
        text: `📜 page ${n}`,
        hint: 'Reply more or done.',
        placeholder: 'more or done',
        read: (answer) => {
          read(answer);
          const word = answer.trim().toLowerCase();
          if (word === 'done') return { next: { kind: 'done', text: '👋 closed' } };
          if (word === 'more') return n < 3 ? { next: page(n + 1) } : { invalid: 'That was the last page.' };
          if (word === 'boom') throw new Error('cannot read the audit file');
          return { invalid: 'Say more or done.' };
        },
      });
      const command: InteractiveCommand = {
        kind: 'interactive',
        name: 'browse',
        description: 'Browse',
        acceptsArgs: true,
        begin: vi.fn((_actor, args: string) => page(args === '' ? 1 : Number(args))),
      };
      return { command, read };
    };
    /** /tune: a mutable command with a free-form answer before the passphrase. */
    const tune = () => {
      const apply = vi.fn(async (value: number): Promise<string | { text: string; error: string }> => `✅ set to ${value}`);
      const command: MutableCommand = {
        kind: 'mutable',
        name: 'tune',
        description: 'Tune',
        begin: () => ({
          kind: 'input',
          text: 'New value?',
          hint: 'Reply a number from 1 to 9.',
          read: (answer) => {
            const value = Number(answer.trim());
            if (!/^\d$/.test(answer.trim()) || value < 1) return { invalid: 'That is not a number from 1 to 9.' };
            return { next: { kind: 'passphrase', text: `🔐 Passphrase to set ${value}?`, run: () => apply(value) } };
          },
        }),
      };
      return { command, apply };
    };
    const setupWith = (opts: Parameters<typeof setup>[0] = {}) => {
      const b = browse();
      const u = tune();
      const s = scripted();
      const t = setup({ ...opts, commands: [statusCommand(), b.command, u.command, s.pause] });
      return { ...t, browse: b, tune: u, pauseRun: s.pauseRun };
    };

    it('pages through a read-only conversation without any passphrase', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      const [cmd] = await t.send('/browse');
      expect(t.fake.sent[0]).toEqual({ html: '📜 page 1', opts: { replyToMessageId: cmd?.message?.message_id, forceReply: true, placeholder: 'more or done' } });
      await t.send('more', 'MORE');
      expect(t.said().at(-1)).toBe('📜 page 3');
      await t.send('done');

      expect(t.said().at(-1)).toBe('👋 closed');
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'browse', outcome: 'ok' })]);
    });

    it('passes arguments to commands that accept them', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/browse 2');

      expect(t.browse.command.begin).toHaveBeenCalledWith({ id: OWNER.id, username: 'owner' }, '2');
      expect(t.said()).toEqual(['📜 page 2']);
    });

    it('still refuses arguments for commands that do not accept them', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/tune 5');

      expect(t.replies).toEqual(['⚠️ /tune takes no arguments.']);
      expect(t.bot.pendingConversation).toBeUndefined();
    });

    it('passes arguments to a read-only command without ever comparing them with the passphrase', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send(`/browse ${PASS}`);

      expect(t.browse.command.begin).toHaveBeenCalledWith(expect.anything(), PASS);
      expect(t.fake.deleted).toEqual([]);
    });

    it('asks again, saying why, when a free-form answer is refused; gives up after too many', async () => {
      const t = setupWith({ options: { maxInvalidAnswers: 3 } });
      active.push(t.bot);
      await t.start();

      await t.send('/browse', 'more', 'more', 'more');
      expect(t.said().at(-1)).toBe('⚠️ That was the last page. Reply more or done.');
      await t.send('hmm', 'what');

      expect(t.said().at(-1)).toBe('🤷 Too many unexpected answers: /browse closed.');
      expect(t.bot.pendingConversation).toBeUndefined();
    });

    it('escapes the reason a free-form answer was refused', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();
      const evil: MutableCommand = {
        kind: 'mutable',
        name: 'evil',
        description: 'x',
        begin: () => ({ kind: 'input', text: 'Q?', hint: '<i>hint</i>', read: () => ({ invalid: '<b>bad</b> & <script>' }) }),
      };
      const bot = new CommandBot({ api: t.fake.bot, policy: PRIVATE, commands: [evil], passphrase: PASS, reply: () => {}, clock: t.clock });
      await t.bot.stop();
      active.push(bot);
      bot.start();
      await t.clock.advanceBy(0);

      await t.send('/evil', 'x');

      expect(t.said().at(-1)).toBe('⚠️ &lt;b&gt;bad&lt;/b&gt; &amp; &lt;script&gt; &lt;i&gt;hint&lt;/i&gt;');
    });

    it('reports a free-form answer that cannot be read, and ends', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/browse', 'boom');

      expect(t.said().at(-1)).toBe('❌ /browse failed: cannot read the audit file. Nothing changed.');
      expect(t.handled()).toEqual([expect.objectContaining({ outcome: 'failed', error: 'cannot read the audit file' })]);
      expect(t.bot.pendingConversation).toBeUndefined();
    });

    it('deletes a long answer to a free-form question of a change that it cannot read (it could be the passphrase)', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/tune');
      const [leak] = await t.send(`my pass: ${PASS}`);

      expect(t.fake.deleted).toEqual([leak?.message?.message_id]);
      expect(t.said().at(-1)).toBe(
        '⚠️ That is not a number from 1 to 9. 🔐 I deleted your message in case it was the passphrase. Answer this question first; the passphrase comes last. ' +
          'Reply a number from 1 to 9.',
      );
      expect(t.bot.pendingConversation).toEqual({ command: 'tune', userId: OWNER.id });
      expectNoLeak(t);
    });

    it('never deletes answers while browsing (read-only: the passphrase has no business there)', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/browse', 'not a valid answer at all', PASS);

      expect(t.fake.deleted).toEqual([]);
    });

    it('runs a mutable change after a free-form answer and the passphrase', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/tune', '0', '7');
      expect(t.said()).toEqual(['New value?', '⚠️ That is not a number from 1 to 9. Reply a number from 1 to 9.', '🔐 Passphrase to set 7?']);
      await t.send(PASS);

      expect(t.tune.apply).toHaveBeenCalledWith(7);
      expect(t.said().at(-1)).toBe('✅ set to 7');
    });

    it('records a change that reports it did not happen as failed, with its own message', async () => {
      const t = setupWith();
      t.tune.apply.mockResolvedValueOnce({ text: '❌ Not saved: the file changed. Nothing changed.', error: 'the file changed' });
      active.push(t.bot);
      await t.start();

      await t.send('/tune', '7', PASS);

      expect(t.said().at(-1)).toBe('❌ Not saved: the file changed. Nothing changed.');
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'tune', outcome: 'failed', error: 'the file changed' })]);
    });

    it('refuses a read-only command that asks for the passphrase (fails closed)', async () => {
      const sneaky: InteractiveCommand = {
        kind: 'interactive',
        name: 'sneaky',
        description: 'x',
        begin: () => ({ kind: 'passphrase', text: 'Passphrase?', run: async () => 'ran' }),
      };
      const t = setup({ commands: [sneaky, scripted().pause] });
      active.push(t.bot);
      await t.start();

      await t.send('/sneaky');

      expect(t.said()).toEqual(['❌ /sneaky failed (internal error). Nothing changed.']);
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'sneaky', outcome: 'failed' })]);
      expect(logs[3]).toHaveBeenCalledWith('Telegram commands: read-only /sneaky asked for the passphrase; refused');
    });

    it('works during a lockout (read-only), while changes stay locked', async () => {
      const t = setupWith({ options: { maxPassphraseFailures: 1 } });
      active.push(t.bot);
      await t.start();
      await t.send('/tune', '7', 'wrong passphrase');

      await t.send('/browse');
      expect(t.said().at(-1)).toBe('📜 page 1');
      await t.send('/tune');
      expect(t.said().at(-1)).toMatch(/^🔒 Changes are locked/);
    });

    it('ends quietly when nobody answers, and explains a late "more"', async () => {
      const t = setupWith({ options: { conversationTimeoutMs: 2 * MIN } });
      active.push(t.bot);
      await t.start();

      await t.send('/browse');
      await t.clock.advanceBy(2 * MIN);
      expect(t.said()).toEqual(['📜 page 1']); // no "cancelled" message for browsing
      expect(t.handled()).toEqual([expect.objectContaining({ command: 'browse', outcome: 'expired' })]);

      await t.send('more');
      expect(t.said().at(-1)).toBe('⌛ That question had expired, so nothing was done. Send /browse again if you still want to.');
    });

    it('says "closed" rather than "cancelled, nothing changed" on cancel', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/browse', 'cancel');
      await t.send('/browse', '/cancel');

      expect(t.said().filter((x) => x === '👋 /browse closed.')).toHaveLength(2);
    });

    it("gives way to someone else's command: browsing never holds up a change", async () => {
      const t = setupWith({ policy: GROUP });
      active.push(t.bot);
      await t.start();

      await t.send(['/browse', inGroup(FAMILY)], ['/pause', inGroup(OWNER)]);

      expect(t.said()).toContain("👋 @family's /browse was closed for /pause.");
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
      await t.send(['more', inGroup(FAMILY)]); // no longer theirs to answer
      await t.send(['yes', inGroup(OWNER)], [PASS, inGroup(OWNER)]);
      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it("does not let browsing interrupt someone else's change", async () => {
      const t = setupWith({ policy: GROUP });
      active.push(t.bot);
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ['/browse', inGroup(FAMILY)]);

      expect(t.said().at(-1)).toBe("⏳ @owner is answering /pause. Try again when that's done.");
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
    });

    it('starting over replaces your own browsing without fuss', async () => {
      const t = setupWith();
      active.push(t.bot);
      await t.start();

      await t.send('/browse', 'more', '/browse');

      expect(t.said()).toEqual(['📜 page 1', '📜 page 2', '📜 page 1']);
      expect(t.handled()[0]).toMatchObject({ command: 'browse', outcome: 'superseded' });
    });

    it('lists read-only conversations with the read-only commands in /help', async () => {
      const b = browse();
      const t = setup({ commands: [statusCommand(), b.command] });
      active.push(t.bot);
      await t.start();

      await t.send('/help');

      expect(t.replies[0]).toBe(
        [
          '🌱 <b>Lawn conductor commands</b> (read-only)',
          '/status: Status',
          '/browse: Browse',
          '/help: this list, or how to use a command',
          '/cancel: close what is waiting for your answer',
          '',
          'Send <b>/help</b> <i>command</i> to see how to use one, e.g. /help audit.',
        ].join('\n'),
      );
    });

    it('does not need a passphrase when every conversation is read-only', () => {
      const { bot: api } = fakeBotApi();
      expect(() => new CommandBot({ api, policy: PRIVATE, commands: [browse().command], reply: () => {} })).not.toThrow();
    });
  });

  describe('/help', () => {
    it('explains one command with /help <command>', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/help pause', '/help /RESUME');

      expect(t.replies[0]?.split('\n')[0]).toBe('❓ <b>/pause</b>: Pause watering');
      expect(t.replies[0]).toContain('🔐 Changes something: it asks for the passphrase last');
      expect(t.replies[1]?.split('\n')[0]).toBe('❓ <b>/resume</b>: Resume watering');
    });

    it('never repeats an unknown name back, nor deletes anything (it is read-only)', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/help nothing_like_it', `/help ${PASS}`);

      expect(t.replies).toEqual([
        "🤷 There's no command by that name. Send /help for the list.",
        '⚠️ Send /help for the list, or /help <i>command</i> for one of them, e.g. /help audit.', // (several words)
      ]);
      expect(t.fake.deleted).toEqual([]);
      expectNoLeak(t);
    });

    it('shows the list for /start, whatever follows it (a Telegram deep link)', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/start', '/start some-payload');

      expect(t.replies[0]).toMatch(/^🌱 <b>Lawn conductor commands<\/b>/);
      expect(t.replies[1]).toBe(t.replies[0]);
    });

    it('can be used while a question waits, which keeps waiting', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', '/help pause');
      expect(t.bot.pendingConversation).toEqual({ command: 'pause', userId: OWNER.id });
      await t.send('yes', PASS);

      expect(t.pauseRun).toHaveBeenCalledOnce();
    });

    it('says which commands are switched off here, and why', async () => {
      const clock = new VirtualClock(START);
      const fake = fakeBotApi();
      const replies: string[] = [];
      const bot = new CommandBot({
        api: fake.bot,
        policy: PRIVATE,
        commands: [statusCommand()],
        unavailable: new Map([['config', 'changes need a passphrase.']]),
        reply: (html) => replies.push(html),
        clock,
      });
      active.push(bot);
      bot.start();
      await clock.advanceBy(0);

      fake.push(updates(clock)('/help config'));
      await clock.advanceBy(0);

      expect(replies).toEqual(['⛔ /config is off here: changes need a passphrase.']);
    });

    it('uses the answer timeout the bot really has', async () => {
      const t = track(setup({ options: { conversationTimeoutMs: 5 * MIN } }));
      await t.start();

      await t.send('/help pause');

      expect(t.replies[0]).toContain('⌛ Each question waits 5 min for your answer.');
    });

    it('counts towards the command rate limit', async () => {
      const t = track(setup({ options: { maxCommandsPerWindow: 2 } }));
      await t.start();

      await t.send('/help', '/help pause', '/help resume');

      expect(t.replies).toHaveLength(3);
      expect(t.replies[2]).toBe('🐢 Too many commands; ignoring them for up to 60 s.');
    });
  });
});
