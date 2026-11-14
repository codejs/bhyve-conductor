import { vi } from 'vitest';
import type { BotApi } from '../../bot/bot.ts';
import type { Clock } from '../../clock.ts';
import type { GetUpdatesOptions, TelegramMessage, TelegramUpdate, TelegramUser } from '../../notify/telegram.ts';

/**
 * The Telegram Bot API as the command bot sees it. getUpdates behaves like a real long poll: it
 * returns queued updates at once, or waits until `push` delivers some or the request is aborted.
 */
export const fakeBotApi = (me: TelegramUser = { id: 999, is_bot: true, username: 'LawnBot' }) => {
  const queue: (TelegramUpdate[] | Error)[] = [];
  let waiter: { resolve: (u: TelegramUpdate[]) => void; reject: (e: unknown) => void } | undefined;

  const api = {
    getMe: vi.fn(async (): Promise<TelegramUser> => me),
    getUpdates: vi.fn(
      (opts: GetUpdatesOptions) =>
        new Promise<TelegramUpdate[]>((resolve, reject) => {
          const next = queue.shift();
          if (next instanceof Error) return reject(next);
          if (next) return resolve(next);
          waiter = { resolve, reject };
          opts.signal?.addEventListener(
            'abort',
            () => {
              waiter = undefined;
              reject(new Error('Telegram getUpdates aborted'));
            },
            { once: true },
          );
        }),
    ),
    setMyCommands: vi.fn(async (_commands: readonly { command: string; description: string }[], _chatId: number): Promise<void> => {}),
  };

  return {
    api,
    bot: api as BotApi,
    /** Delivers one batch of updates: to the waiting long poll, or to the next one. */
    push: (...updates: TelegramUpdate[]) => {
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w.resolve(updates);
      } else {
        queue.push(updates);
      }
    },
    /** Makes the current (or next) getUpdates fail. */
    fail: (err: Error) => {
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w.reject(err);
      } else {
        queue.push(err);
      }
    },
    /** A long poll is waiting. */
    get polling() {
      return waiter !== undefined;
    },
  };
};

export const OWNER: TelegramUser = { id: 4242, is_bot: false, first_name: 'Owner', username: 'owner' };
export const FAMILY: TelegramUser = { id: 5151, is_bot: false, first_name: 'Family', username: 'family' };
export const STRANGER: TelegramUser = { id: 6666, is_bot: false, first_name: 'Mallory', username: 'mallory' };
export const GROUP_ID = -1001234567890;

/** Builds updates with increasing ids, dated "now" on the given clock. */
export const updates = (clock: Clock) => {
  let nextId = 1000;
  return (text: string | undefined, overrides: Partial<TelegramMessage> = {}): TelegramUpdate => {
    const id = nextId++;
    return {
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(clock.now().getTime() / 1000),
        chat: { id: OWNER.id, type: 'private' },
        from: OWNER,
        ...(text === undefined ? {} : { text }),
        ...overrides,
      },
    };
  };
};
