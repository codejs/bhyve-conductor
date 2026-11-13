import { beforeEach, describe, expect, it } from 'vitest';
import { escapeHtml, TelegramClient, TelegramPermanentError, TelegramRateLimitError } from '../../notify/telegram.ts';
import { fetchCall, hangingFetch, jsonResponse, mockFetch, type FetchMock } from '../utils/fetch.ts';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('TelegramClient', () => {
  let fetchMock: FetchMock;
  const client = (timeoutMs?: number) => new TelegramClient({ token: TOKEN, chatId: '-100123', ...(timeoutMs ? { timeoutMs } : {}) });

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  it('posts an HTML message to the chat', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: {} }));

    await client().send('<b>hi</b>');

    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ chat_id: '-100123', text: '<b>hi</b>', parse_mode: 'HTML', disable_web_page_preview: true });
  });

  it('turns a 429 into a rate-limit error with retry_after', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 31 } }, 429));

    const err = await client().send('x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramRateLimitError);
    expect((err as TelegramRateLimitError).retryAfterSeconds).toBe(31);
  });

  it.each([400, 401, 403])('treats HTTP %s as permanent (bad token/chat: retrying cannot help)', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: status, description: 'Bad Request: chat not found' }, status));

    await expect(client().send('x')).rejects.toBeInstanceOf(TelegramPermanentError);
  });

  it('treats server errors as temporary', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));

    const err = await client().send('x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TelegramPermanentError);
    expect((err as Error).message).toBe('Telegram sendMessage failed: 502 HTTP 502');
  });

  it('times out, and never puts the token in error messages', async () => {
    fetchMock.mockImplementationOnce(hangingFetch);

    const err = (await client(50).send('x').catch((e: unknown) => e)) as Error;

    expect(err.message).toBe('Telegram sendMessage timed out after 0.05s');
    expect(err.message).not.toContain(TOKEN);
  });

  it('escapes text for HTML mode', () => {
    expect(escapeHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });
});
