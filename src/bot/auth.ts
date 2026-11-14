import type { TelegramMessage, TelegramUser } from '../notify/telegram.ts';

/**
 * Who may send commands to the bot. Fails closed: anything not explicitly allowed is rejected.
 *
 *  - Only messages in the configured chat (TELEGRAM_CHAT_ID) count, and only from a user on the allowlist.
 *  - In a private chat the only possible sender is that chat's user, so the allowlist defaults to them.
 *    In a group anyone who joins could send commands, so an explicit allowlist is required.
 *  - Messages whose real author is hidden or is someone else are rejected even in the right chat:
 *    anonymous group admins and channel posts (`sender_chat`), bots, forwards, and inline-bot messages.
 */
export interface CommandPolicy {
  /** The one chat commands are accepted from (and replies go to). */
  chatId: number;
  /** Telegram user ids allowed to send commands. Never empty. */
  userIds: ReadonlySet<number>;
}

export interface CommandSettings {
  enabled: boolean;
  token?: string | undefined;
  chatId?: string | undefined;
  userIds: readonly number[];
}

/** Validates the command settings. Returns undefined when commands are off; throws on an unsafe or unusable setup. */
export const commandPolicy = (settings: CommandSettings): CommandPolicy | undefined => {
  if (!settings.enabled) return undefined;
  if (!settings.token || !settings.chatId) {
    throw new Error('TELEGRAM_COMMANDS=on needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  }
  if (!/^-?\d+$/.test(settings.chatId)) {
    throw new Error('Telegram commands need a numeric TELEGRAM_CHAT_ID (a private chat or a group), not a @channel');
  }
  const chatId = Number(settings.chatId);
  if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error(`TELEGRAM_CHAT_ID ${settings.chatId} is not a valid chat id`);
  for (const id of settings.userIds) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`TELEGRAM_COMMAND_USER_IDS: ${id} is not a valid Telegram user id`);
  }
  if (chatId < 0) {
    if (settings.userIds.length === 0) {
      throw new Error(
        'TELEGRAM_CHAT_ID is a group, where anyone who joins could send commands: set TELEGRAM_COMMAND_USER_IDS ' +
          'to the Telegram user ids allowed to use them',
      );
    }
    return { chatId, userIds: new Set(settings.userIds) };
  }
  // A private chat's id is its user's id.
  if (settings.userIds.length > 0 && !settings.userIds.includes(chatId)) {
    throw new Error(
      `TELEGRAM_CHAT_ID ${chatId} is a private chat, but that user is not in TELEGRAM_COMMAND_USER_IDS, so nobody could send commands`,
    );
  }
  return { chatId, userIds: new Set([chatId]) };
};

export type RejectReason =
  /** Sent in a chat other than the configured one (e.g. a stranger messaging the bot directly). */
  | 'other-chat'
  /** Sent on behalf of a chat (anonymous group admin, linked channel): the person is unknown. */
  | 'anonymous'
  /** No sender at all. */
  | 'no-sender'
  /** Sent by a bot (possibly one that was added to the group). */
  | 'bot-sender'
  /** Forwarded: the text was written by someone else, somewhere else. */
  | 'forwarded'
  /** Sent via an inline bot: the text was produced by that bot. */
  | 'via-bot'
  /** In the right chat, but from a user not on the allowlist. */
  | 'user-not-allowed';

export type Verdict = { ok: true; user: TelegramUser } | { ok: false; reason: RejectReason };

export const authorize = (message: TelegramMessage, policy: CommandPolicy): Verdict => {
  if (message.chat.id !== policy.chatId) return { ok: false, reason: 'other-chat' };
  if (message.sender_chat !== undefined) return { ok: false, reason: 'anonymous' };
  const user = message.from;
  if (!user) return { ok: false, reason: 'no-sender' };
  if (user.is_bot) return { ok: false, reason: 'bot-sender' };
  if (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_date !== undefined ||
    message.is_automatic_forward !== undefined
  ) {
    return { ok: false, reason: 'forwarded' };
  }
  if (message.via_bot !== undefined) return { ok: false, reason: 'via-bot' };
  if (!policy.userIds.has(user.id)) return { ok: false, reason: 'user-not-allowed' };
  return { ok: true, user };
};
