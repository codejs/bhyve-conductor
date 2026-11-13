/**
 * Minimal Telegram Bot API client: just sendMessage. Docs: https://core.telegram.org/bots/api#sendmessage
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

interface ApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  readonly #opts: Required<TelegramOptions>;

  constructor(opts: TelegramOptions) {
    this.#opts = { timeoutMs: 10_000, apiBase: 'https://api.telegram.org', ...opts };
  }

  /** Sends an HTML-formatted message. */
  async send(html: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.#opts.apiBase}/bot${this.#opts.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#opts.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
    } catch (err) {
      const why = err instanceof DOMException && err.name === 'TimeoutError' ? `timed out after ${this.#opts.timeoutMs / 1000}s` : String(err);
      // Never include the URL: it contains the bot token.
      throw new Error(`Telegram sendMessage ${why}`, { cause: err });
    }
    let body: ApiResponse;
    try {
      body = (await res.json()) as ApiResponse;
    } catch {
      body = { ok: false, description: `HTTP ${res.status}` };
    }
    if (body.ok) return;
    if (res.status === 429 || body.error_code === 429) throw new TelegramRateLimitError(body.parameters?.retry_after ?? 5);
    const message = `Telegram sendMessage failed: ${body.error_code ?? res.status} ${body.description ?? ''}`.trim();
    if ([400, 401, 403, 404].includes(res.status)) throw new TelegramPermanentError(message);
    throw new Error(message);
  }
}

/** Escapes text for Telegram's HTML parse mode. */
export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
