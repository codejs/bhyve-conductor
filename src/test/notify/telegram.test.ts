import { beforeEach, describe, expect, it } from 'vitest';
import { escapeHtml, TelegramClient, TelegramConflictError, TelegramPermanentError, TelegramRateLimitError } from '../../notify/telegram.ts';
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

describe('TelegramClient (commands)', () => {
  let fetchMock: FetchMock;
  const client = () => new TelegramClient({ token: TOKEN, chatId: '4242' });
  const message = (overrides: Record<string, unknown> = {}) => ({
    message_id: 5,
    date: 1_780_000_000,
    chat: { id: 4242, type: 'private', first_name: 'Owner' },
    from: { id: 4242, is_bot: false, first_name: 'Owner', username: 'owner', language_code: 'en' },
    text: '/status',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    ...overrides,
  });

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  it('getMe returns the bot account', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: 'Lawn', username: 'LawnBot', can_join_groups: true } }));

    await expect(client().getMe()).resolves.toEqual({ id: 999, is_bot: true, first_name: 'Lawn', username: 'LawnBot' });
    expect(fetchCall(fetchMock, 0).url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('getMe rejects a response of the wrong shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { id: 'x' } }));

    await expect(client().getMe()).rejects.toThrow('Telegram getMe returned an unexpected response');
  });

  it('getUpdates long-polls for messages only, from the given offset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: [{ update_id: 10, message: message() }] }));

    const updates = await client().getUpdates({ offset: 10, timeoutSeconds: 50 });

    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ offset: 10, timeout: 50, allowed_updates: ['message'] });
    expect(updates).toEqual([
      {
        update_id: 10,
        message: {
          message_id: 5,
          date: 1_780_000_000,
          chat: { id: 4242, type: 'private' },
          from: { id: 4242, is_bot: false, first_name: 'Owner', username: 'owner' },
          text: '/status',
        },
      },
    ]);
  });

  it('getUpdates leaves out the offset when there is none yet', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }));

    await client().getUpdates({ timeoutSeconds: 0 });

    expect(fetchCall(fetchMock, 0).body).toEqual({ timeout: 0, allowed_updates: ['message'] });
  });

  it('getUpdates keeps the fields that reveal who really sent a message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: [
          { update_id: 1, message: message({ forward_origin: { type: 'user', date: 1, sender_user: { id: 6, is_bot: false, first_name: 'M' } } }) },
          { update_id: 2, message: message({ sender_chat: { id: -100, type: 'channel' } }) },
          { update_id: 3, message: message({ via_bot: { id: 7, is_bot: true, first_name: 'B' } }) },
          { update_id: 4, message: message({ forward_date: 1, forward_from: { id: 6 } }) },
          { update_id: 5, message: message({ is_automatic_forward: true }) },
        ],
      }),
    );

    const [fwd, anon, via, legacy, auto] = await client().getUpdates({ timeoutSeconds: 0 });

    expect(fwd?.message?.forward_origin).toBeDefined();
    expect(anon?.message?.sender_chat).toBeDefined();
    expect(via?.message?.via_bot).toBeDefined();
    expect(legacy?.message?.forward_date).toBe(1);
    expect(legacy?.message?.forward_from).toBeDefined();
    expect(auto?.message?.is_automatic_forward).toBe(true);
  });

  it('getUpdates drops a message it cannot trust, but keeps its id so it is acknowledged', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: [
          { update_id: 1, message: message({ from: { id: '4242', is_bot: false } }) }, // id as a string
          { update_id: 2, message: message({ chat: { id: 4242.5, type: 'private' } }) },
          { update_id: 3, message: message({ text: 42 }) },
          { update_id: 4, edited_message: message() }, // not asked for, but harmless
          { update_id: 5, message: message() },
          { nonsense: true },
          'garbage',
        ],
      }),
    );

    const updates = await client().getUpdates({ timeoutSeconds: 0 });

    expect(updates.map((u) => [u.update_id, u.message !== undefined])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
  });

  it('getUpdates rejects a result that is not a list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { update_id: 1 } }));

    await expect(client().getUpdates({ timeoutSeconds: 0 })).rejects.toThrow('Telegram getUpdates returned an unexpected response');
  });

  it('getUpdates reports a 409 conflict (another poller or a webhook) distinctly', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 409),
    );

    const err = await client().getUpdates({ timeoutSeconds: 0 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramConflictError);
    expect((err as Error).message).toBe('Telegram getUpdates failed: 409 Conflict: terminated by other getUpdates request');
  });

  it('getUpdates treats a bad token as permanent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401));

    await expect(client().getUpdates({ timeoutSeconds: 0 })).rejects.toBeInstanceOf(TelegramPermanentError);
  });

  it('getUpdates can be aborted (shutdown), without the token in the error', async () => {
    fetchMock.mockImplementationOnce(hangingFetch);
    const abort = new AbortController();

    const pending = client().getUpdates({ timeoutSeconds: 50, signal: abort.signal }).catch((e: unknown) => e);
    abort.abort();
    const err = (await pending) as Error;

    expect(err.message).toBe('Telegram getUpdates aborted');
    expect(err.message).not.toContain(TOKEN);
  });

  it('getUpdates waits longer than the long poll before timing out', async () => {
    fetchMock.mockImplementationOnce(hangingFetch);
    const c = new TelegramClient({ token: TOKEN, chatId: '4242', timeoutMs: 10 });

    const abort = new AbortController();

    // timeout 0 s + the 15 s margin: not the 10 ms sendMessage timeout.
    const pending = c.getUpdates({ timeoutSeconds: 0, signal: abort.signal }).catch((e: unknown) => e);
    const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still waiting'), 100))]);

    expect(early).toBe('still waiting');
    abort.abort();
    expect(((await pending) as Error).message).toBe('Telegram getUpdates aborted');
  });

  it('sendMessage can reply to a message and open the answer box for that person only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: {} }));

    await client().sendMessage('Pause anyway?', { replyToMessageId: 77, forceReply: true, placeholder: 'yes or cancel' });

    expect(fetchCall(fetchMock, 0).body).toEqual({
      chat_id: '4242',
      text: 'Pause anyway?',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'yes or cancel' },
    });
  });

  it('sendMessage without options is a plain message, and clips the placeholder to what Telegram allows', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, result: {} }));

    await client().sendMessage('hi');
    await client().sendMessage('hi', { forceReply: true, placeholder: 'p'.repeat(100) });

    expect(fetchCall(fetchMock, 0).body).toEqual({ chat_id: '4242', text: 'hi', parse_mode: 'HTML', disable_web_page_preview: true });
    expect(fetchCall(fetchMock, 1).body).toMatchObject({ reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'p'.repeat(64) } });
  });

  it('deleteMessage deletes a message in the configured chat', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));

    await client().deleteMessage(99);

    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/deleteMessage`);
    expect(call.body).toEqual({ chat_id: '4242', message_id: 99 });
  });

  it("deleteMessage reports a message it can't delete as permanent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }, 400));

    await expect(client().deleteMessage(99)).rejects.toBeInstanceOf(TelegramPermanentError);
  });

  it('setMyCommands sets the menu for the one chat', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));

    await client().setMyCommands([{ command: 'status', description: 'Status' }], -100123);

    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/setMyCommands`);
    expect(call.body).toEqual({ commands: [{ command: 'status', description: 'Status' }], scope: { type: 'chat', chat_id: -100123 } });
  });

  it.each(['getMe', 'getUpdates', 'setMyCommands', 'sendMessage', 'deleteMessage'] as const)('%s never puts the token in error messages', async (method) => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const c = client();
    const calls = {
      getMe: () => c.getMe(),
      getUpdates: () => c.getUpdates({ timeoutSeconds: 0 }),
      setMyCommands: () => c.setMyCommands([], 1),
      sendMessage: () => c.sendMessage('x', { forceReply: true }),
      deleteMessage: () => c.deleteMessage(1),
    };
    const call = calls[method]();

    const err = (await call.catch((e: unknown) => e)) as Error;

    expect(err.message).toBe(`Telegram ${method} TypeError: fetch failed`);
    expect(err.message).not.toContain(TOKEN);
  });
});
