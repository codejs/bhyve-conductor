import { z } from 'zod';

/**
 * Minimal Telegram Bot API client: sendMessage for notifications, plus getMe / getUpdates /
 * setMyCommands for the command bot (see bot/bot.ts). Docs: https://core.telegram.org/bots/api
 */
export interface TelegramOptions {
  token: string;
  /** Numeric chat id (negative for groups) or "@channelname". */
  chatId: string;
  timeoutMs?: number;
  /** For tests. */
  apiBase?: string;
}

/** Telegram asked us to slow down; retry after `retryAfterSeconds`. */
export class TelegramRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Telegram rate limit: retry after ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A request Telegram will never accept (bad token, wrong chat id, malformed message): don't retry. */
export class TelegramPermanentError extends Error {}

/**
 * getUpdates refused because another process is polling with the same token, or a webhook is set
 * (HTTP 409). Retrying helps only once the other side stops.
 */
export class TelegramConflictError extends Error {}

interface ApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const User = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string().optional(),
  /**
   * Telegram usernames are 5–32 letters, digits and underscores. Anything else is dropped rather than
   * trusted: it ends up in messages, logs and the audit trail.
   */
  username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional().catch(undefined),
});

/**
 * The parts of a message the command bot looks at. Fields that change who a message is really from
 * (forwards, anonymous admins, inline bots) are kept as `unknown` so their mere presence can be checked.
 */
const Message = z.object({
  message_id: z.number().int(),
  /** Unix seconds. */
  date: z.number().int(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: User.optional(),
  sender_chat: z.unknown().optional(),
  forward_origin: z.unknown().optional(),
  forward_from: z.unknown().optional(),
  forward_from_chat: z.unknown().optional(),
  forward_date: z.unknown().optional(),
  is_automatic_forward: z.unknown().optional(),
  via_bot: z.unknown().optional(),
  text: z.string().optional(),
});

const Update = z.object({ update_id: z.number().int().nonnegative(), message: Message.optional() });
const UpdateId = z.object({ update_id: z.number().int().nonnegative() });

export type TelegramUser = z.infer<typeof User>;
export type TelegramMessage = z.infer<typeof Message>;
/** `message` is absent for other kinds of update, and for messages that didn't match the expected shape. */
export type TelegramUpdate = z.infer<typeof Update>;

export interface GetUpdatesOptions {
  /** First update id to return; confirms (deletes on Telegram's side) everything before it. */
  offset?: number;
  /** Long-poll wait, in seconds (0 = return immediately). */
  timeoutSeconds: number;
  /** Aborts the long poll (e.g. on shutdown). */
  signal?: AbortSignal;
}

export interface SendOptions {
  /** Reply to this message (sent anyway if it has been deleted). */
  replyToMessageId?: number;
  /**
   * Open the reply box for the person being replied to (and only them, in a group). Their answer is then
   * a reply to the bot, which the bot receives even with group privacy mode on.
   */
  forceReply?: boolean;
  /** Hint shown in the reply box. */
  placeholder?: string;
}

/** Extra time on top of the long-poll wait before the HTTP request itself is considered hung. */
const LONG_POLL_MARGIN_MS = 15_000;

export class TelegramClient {
  readonly #opts: Required<TelegramOptions>;

  constructor(opts: TelegramOptions) {
    this.#opts = { timeoutMs: 10_000, apiBase: 'https://api.telegram.org', ...opts };
  }

  /** Sends an HTML-formatted message. */
  async send(html: string): Promise<void> {
    await this.sendMessage(html);
  }

  /** Sends an HTML-formatted message, optionally as a reply that asks for an answer. */
  async sendMessage(html: string, opts: SendOptions = {}): Promise<void> {
    await this.#call('sendMessage', {
      chat_id: this.#opts.chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(opts.replyToMessageId !== undefined
        ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } }
        : {}),
      ...(opts.forceReply
        ? { reply_markup: { force_reply: true, selective: true, ...(opts.placeholder ? { input_field_placeholder: opts.placeholder.slice(0, 64) } : {}) } }
        : {}),
    });
  }

  /**
   * Deletes a message in the chat. In a private chat a bot can delete what the user sent it; in a group
   * it needs the "Delete messages" admin right. Messages older than 48 h can't be deleted.
   */
  async deleteMessage(messageId: number): Promise<void> {
    await this.#call('deleteMessage', { chat_id: this.#opts.chatId, message_id: messageId });
  }

  /** The bot's own account (its username is needed to recognise "/command@ThisBot"). */
  async getMe(): Promise<TelegramUser> {
    const parsed = User.safeParse(await this.#call('getMe', {}));
    if (!parsed.success) throw new Error('Telegram getMe returned an unexpected response');
    return parsed.data;
  }

  /**
   * Long-polls for new messages. Only `message` updates are requested (edits, reactions, callbacks...
   * are never delivered). An update whose message doesn't have the expected shape is returned without
   * it, so the caller still moves past it.
   */
  async getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]> {
    const result = await this.#call(
      'getUpdates',
      {
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
        timeout: opts.timeoutSeconds,
        allowed_updates: ['message'],
      },
      { timeoutMs: opts.timeoutSeconds * 1000 + LONG_POLL_MARGIN_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!Array.isArray(result)) throw new Error('Telegram getUpdates returned an unexpected response');
    const updates: TelegramUpdate[] = [];
    for (const raw of result) {
      const full = Update.safeParse(raw);
      if (full.success) {
        updates.push(full.data);
        continue;
      }
      const id = UpdateId.safeParse(raw);
      if (id.success) updates.push({ update_id: id.data.update_id });
      // Without an update id it can't even be acknowledged; the next offset still moves past it.
    }
    return updates;
  }

  /** Sets the command menu shown in the Telegram app, for one chat only. */
  async setMyCommands(commands: readonly { command: string; description: string }[], chatId: number): Promise<void> {
    await this.#call('setMyCommands', { commands, scope: { type: 'chat', chat_id: chatId } });
  }

  async #call(method: string, payload: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.#opts.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.#opts.apiBase}/bot${this.#opts.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
    } catch (err) {
      const why =
        timeout.aborted && !opts.signal?.aborted
          ? `timed out after ${timeoutMs / 1000}s`
          : opts.signal?.aborted
            ? 'aborted'
            : String(err);
      // Never include the URL: it contains the bot token.
      throw new Error(`Telegram ${method} ${why}`, { cause: err });
    }
    let body: ApiResponse;
    try {
      body = (await res.json()) as ApiResponse;
    } catch {
      body = { ok: false, description: `HTTP ${res.status}` };
    }
    if (body.ok) return body.result;
    if (res.status === 429 || body.error_code === 429) throw new TelegramRateLimitError(body.parameters?.retry_after ?? 5);
    const message = `Telegram ${method} failed: ${body.error_code ?? res.status} ${body.description ?? ''}`.trim();
    if (res.status === 409 || body.error_code === 409) throw new TelegramConflictError(message);
    if ([400, 401, 403, 404].includes(res.status)) throw new TelegramPermanentError(message);
    throw new Error(message);
  }
}

/** Escapes text for Telegram's HTML parse mode. */
export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
