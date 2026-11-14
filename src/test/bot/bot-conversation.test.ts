import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { CommandPolicy } from '../../bot/auth.ts';
import { CommandBot, type CommandBotOptions } from '../../bot/bot.ts';
import type { BotCommand } from '../../bot/commands.ts';
import type { MutableCommand, Step } from '../../bot/conversation.ts';
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
      (): Step => ({
        kind: 'ask',
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
      (): Step => ({
        kind: 'ask',
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

const statusCommand = (): BotCommand & { run: ReturnType<typeof vi.fn> } => ({
  name: 'status',
  description: 'Status',
  cooldownSeconds: 0,
  run: vi.fn(async () => '🌱 status'),
});

const setup = (opts: { policy?: CommandPolicy; options?: Partial<CommandBotOptions>; commands?: (BotCommand | MutableCommand)[] } = {}) => {
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

    it('gives no second try: the right passphrase afterwards runs nothing (and is deleted)', async () => {
      const t = track(setup());
      await t.start();

      await t.send('/pause', 'yes', 'wrong-passphrase');
      const [late] = await t.send(PASS);

      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.fake.deleted).toContain(late?.message?.message_id);
      expect(t.said().at(-1)).toBe('🔐 I deleted your message because it contained the passphrase. Nothing was waiting for it, so nothing was run.');
      expectNoLeak(t);
    });

    it.each(['', 'x'.repeat(5000), PASS.toUpperCase(), `${PASS}.`, PASS.replace(' ', '  ')])('treats %j as wrong', async (answer) => {
      const t = track(setup());
      await t.start();

      await t.send('/now', answer || ' ');

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
    it.each(['maybe', 'yes please', 'sure', '👍', 'resume', 'discard'])('asks again after %j, then gives up', async (answer) => {
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
        '🔐 I deleted your message because it contained the passphrase. Answer this question first; I ask for the passphrase after it. ' +
          'Reply yes to pause, or cancel.',
      );
      expect(t.pauseRun).not.toHaveBeenCalled();
      expect(t.bot.pendingConversation).toBeDefined();
      await t.send('yes', PASS);
      expect(t.pauseRun).toHaveBeenCalledOnce();
      expectNoLeak(t);
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

    it("deletes the passphrase even when it's someone else who sends it", async () => {
      const t = track(setup({ policy: GROUP }));
      await t.start();

      await t.send(['/pause', inGroup(OWNER)], ['yes', inGroup(OWNER)]);
      const [leak] = await t.send([PASS, inGroup(FAMILY)]);

      expect(t.fake.deleted).toEqual([leak?.message?.message_id]);
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
      expect(t.said().at(-1)).toBe('🔐 I deleted your message because it contained the passphrase. It was too old to act on; nothing was run.');
      expectNoLeak(t);
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

  describe('the passphrase in the wrong place', () => {
    it('deletes a command that carries it, and starts nothing', async () => {
      const t = track(setup());
      await t.start();

      const [cmd] = await t.send(`/pause ${PASS}`);

      expect(t.fake.deleted).toEqual([cmd?.message?.message_id]);
      expect(t.replies).toEqual([
        "⚠️ /pause takes no arguments. 🔐 I deleted your message because it contained the passphrase. Send the command alone; I ask for the passphrase when it's needed.",
      ]);
      expect(t.bot.pendingConversation).toBeUndefined();
      expect(t.pauseRun).not.toHaveBeenCalled();
      expectNoLeak(t);
    });

    it('deletes it from an ordinary message, and says so', async () => {
      const t = track(setup());
      await t.start();

      const [m] = await t.send(`btw the passphrase is ${PASS}`);

      expect(t.fake.deleted).toEqual([m?.message?.message_id]);
      expect(t.said()).toEqual(['🔐 I deleted your message because it contained the passphrase. Nothing was waiting for it, so nothing was run.']);
    });

    it('says when it could not delete it', async () => {
      const t = track(setup());
      t.fake.api.deleteMessage.mockRejectedValue(new Error('Telegram deleteMessage failed: 400 Bad Request: message can\'t be deleted'));
      await t.start();

      await t.send(`the passphrase is ${PASS}`);

      expect(t.said()[0]).toMatch(/^⚠️ Your message contains the passphrase and I couldn't delete it .*please delete it yourself\./);
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
      vi.mocked(t.pause.begin).mockReturnValueOnce({
        kind: 'ask',
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
      });
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
          '/help: this list',
          '',
          '<b>Changes</b> (each asks for the passphrase):',
          '/pause: Pause watering',
          '/resume: Resume watering',
          '/cancel: cancel a pending change',
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
});
