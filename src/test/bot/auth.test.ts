import { describe, expect, it } from 'vitest';
import { authorize, commandPolicy, type CommandPolicy } from '../../bot/auth.ts';
import type { TelegramMessage } from '../../notify/telegram.ts';
import { FAMILY, GROUP_ID, OWNER, STRANGER } from '../utils/fake-telegram.ts';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('commandPolicy', () => {
  const settings = (overrides: Partial<Parameters<typeof commandPolicy>[0]> = {}) => ({
    enabled: true,
    token: TOKEN,
    chatId: String(OWNER.id),
    userIds: [] as number[],
    ...overrides,
  });

  it('is off unless enabled, whatever else is set', () => {
    expect(commandPolicy(settings({ enabled: false }))).toBeUndefined();
    expect(commandPolicy({ enabled: false, userIds: [] })).toBeUndefined();
    expect(commandPolicy(settings({ enabled: false, chatId: String(GROUP_ID) }))).toBeUndefined(); // no allowlist needed when off
  });

  it('in a private chat, allows only that chat’s user by default', () => {
    expect(commandPolicy(settings())).toEqual({ chatId: OWNER.id, userIds: new Set([OWNER.id]) });
  });

  it('in a private chat, accepts an allowlist that includes the chat’s user (and only that user can ever send there)', () => {
    expect(commandPolicy(settings({ userIds: [OWNER.id, FAMILY.id] }))).toEqual({ chatId: OWNER.id, userIds: new Set([OWNER.id]) });
  });

  it('in a private chat, refuses an allowlist that leaves out the chat’s user (nobody could use it)', () => {
    expect(() => commandPolicy(settings({ userIds: [FAMILY.id] }))).toThrow(/private chat, but that user is not in TELEGRAM_COMMAND_USER_IDS/);
  });

  it('in a group, requires an explicit allowlist (anyone who joins the group could send commands)', () => {
    expect(() => commandPolicy(settings({ chatId: String(GROUP_ID) }))).toThrow(/is a group.*TELEGRAM_COMMAND_USER_IDS/);
    expect(commandPolicy(settings({ chatId: String(GROUP_ID), userIds: [OWNER.id, FAMILY.id] }))).toEqual({
      chatId: GROUP_ID,
      userIds: new Set([OWNER.id, FAMILY.id]),
    });
  });

  it('needs the bot token and the chat', () => {
    expect(() => commandPolicy(settings({ token: undefined }))).toThrow('TELEGRAM_COMMANDS=on needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    expect(() => commandPolicy(settings({ chatId: undefined }))).toThrow('TELEGRAM_COMMANDS=on needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    expect(() => commandPolicy(settings({ token: '' }))).toThrow(/needs TELEGRAM_BOT_TOKEN/);
  });

  it('refuses a @channel (nobody can send commands in a channel; posts have no sender)', () => {
    expect(() => commandPolicy(settings({ chatId: '@mylawn' }))).toThrow(/numeric TELEGRAM_CHAT_ID/);
  });

  it.each(['0', '-0', '99999999999999999999', '12a', ' 42', '+42'])('refuses the chat id %j', (chatId) => {
    expect(() => commandPolicy(settings({ chatId }))).toThrow();
  });

  it.each([0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN])('refuses the user id %s', (id) => {
    expect(() => commandPolicy(settings({ chatId: String(GROUP_ID), userIds: [OWNER.id, id] }))).toThrow(/not a valid Telegram user id/);
  });
});

describe('authorize', () => {
  const privatePolicy: CommandPolicy = { chatId: OWNER.id, userIds: new Set([OWNER.id]) };
  const groupPolicy: CommandPolicy = { chatId: GROUP_ID, userIds: new Set([OWNER.id, FAMILY.id]) };

  const message = (overrides: Partial<TelegramMessage> = {}): TelegramMessage => ({
    message_id: 1,
    date: 1_780_000_000,
    chat: { id: OWNER.id, type: 'private' },
    from: OWNER,
    text: '/status',
    ...overrides,
  });
  const inGroup = (overrides: Partial<TelegramMessage> = {}) => message({ chat: { id: GROUP_ID, type: 'supergroup' }, ...overrides });

  it('accepts the owner in their private chat', () => {
    expect(authorize(message(), privatePolicy)).toEqual({ ok: true, user: OWNER });
  });

  it('accepts allowed users in the group', () => {
    expect(authorize(inGroup(), groupPolicy)).toEqual({ ok: true, user: OWNER });
    expect(authorize(inGroup({ from: FAMILY }), groupPolicy)).toEqual({ ok: true, user: FAMILY });
  });

  it('rejects a stranger messaging the bot directly', () => {
    expect(authorize(message({ chat: { id: STRANGER.id, type: 'private' }, from: STRANGER }), privatePolicy)).toEqual({ ok: false, reason: 'other-chat' });
  });

  it('rejects even an allowed user writing from another chat (commands come from the configured chat only)', () => {
    expect(authorize(message({ chat: { id: -100999, type: 'group' } }), privatePolicy)).toEqual({ ok: false, reason: 'other-chat' });
    expect(authorize(message({ from: OWNER }), groupPolicy)).toEqual({ ok: false, reason: 'other-chat' });
  });

  it('rejects a group member who is not on the allowlist', () => {
    expect(authorize(inGroup({ from: STRANGER }), groupPolicy)).toEqual({ ok: false, reason: 'user-not-allowed' });
  });

  it('rejects anonymous admins and posts on behalf of a channel, even if "from" looks allowed', () => {
    expect(authorize(inGroup({ sender_chat: { id: GROUP_ID, type: 'supergroup' } }), groupPolicy)).toEqual({ ok: false, reason: 'anonymous' });
  });

  it('rejects a message with no sender', () => {
    const { from: _from, ...noSender } = inGroup();
    expect(authorize(noSender, groupPolicy)).toEqual({ ok: false, reason: 'no-sender' });
  });

  it('rejects bots, even with an allowed id', () => {
    expect(authorize(inGroup({ from: { ...OWNER, is_bot: true } }), groupPolicy)).toEqual({ ok: false, reason: 'bot-sender' });
  });

  it.each([
    ['forward_origin', { type: 'user', date: 1, sender_user: STRANGER }],
    ['forward_from', STRANGER],
    ['forward_from_chat', { id: -100, type: 'channel' }],
    ['forward_date', 1_780_000_000],
    ['is_automatic_forward', true],
  ])('rejects forwarded messages (%s): someone else wrote the text', (field, value) => {
    expect(authorize(inGroup({ [field]: value }), groupPolicy)).toEqual({ ok: false, reason: 'forwarded' });
  });

  it('rejects messages sent via an inline bot', () => {
    expect(authorize(inGroup({ via_bot: { id: 1, is_bot: true } }), groupPolicy)).toEqual({ ok: false, reason: 'via-bot' });
  });

  it('checks the chat before anything else, so strangers are always reported as such', () => {
    expect(authorize(message({ chat: { id: 1, type: 'private' }, from: { ...STRANGER, is_bot: true }, forward_date: 1 }), privatePolicy)).toEqual({
      ok: false,
      reason: 'other-chat',
    });
  });

  it('compares ids exactly (no string/number confusion)', () => {
    const policy: CommandPolicy = { chatId: GROUP_ID, userIds: new Set([OWNER.id]) };
    expect(authorize(inGroup({ from: { ...OWNER, id: OWNER.id + 1 } }), policy)).toEqual({ ok: false, reason: 'user-not-allowed' });
    expect(authorize(inGroup({ chat: { id: GROUP_ID + 1, type: 'supergroup' } }), policy)).toEqual({ ok: false, reason: 'other-chat' });
  });
});
