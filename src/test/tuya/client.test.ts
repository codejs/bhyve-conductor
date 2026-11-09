import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCall, jsonResponse, mockFetch, type FetchMock } from '../utils/fetch.ts';
import { scaleOf, TuyaClient, type TuyaSpecification } from '../../tuya/client.ts';

const CLIENT_ID = 'test-client-id';
const SECRET = 'test-secret';
const BASE = 'https://openapi.example.com';

const tokenOk = (token = 'tok-1', expireSeconds = 7200) =>
  jsonResponse({
    success: true,
    t: Date.now(),
    result: { access_token: token, refresh_token: 'r', expire_time: expireSeconds, uid: 'u' },
  });
const ok = (result: unknown) => jsonResponse({ success: true, t: Date.now(), result });
const fail = (code: number, msg: string) => jsonResponse({ success: false, t: Date.now(), code, msg });

/** Independent implementation of Tuya's documented signature, to check the client against. */
const expectedSign = (h: Record<string, string>, method: string, path: string, body = '', token = '') => {
  const contentHash = createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  return createHmac('sha256', SECRET)
    .update(CLIENT_ID + token + h.t + h.nonce + stringToSign)
    .digest('hex')
    .toUpperCase();
};

describe('TuyaClient', () => {
  let fetchMock: FetchMock;
  let client: TuyaClient;

  beforeEach(() => {
    fetchMock = mockFetch();
    client = new TuyaClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: `${BASE}/` });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('signing', () => {
    it('signs the token request without an access token', async () => {
      fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(ok([]));
      await client.getStatus('dev1');

      const tokenCall = fetchCall(fetchMock, 0);
      expect(tokenCall.url).toBe(`${BASE}/v1.0/token?grant_type=1`);
      expect(tokenCall.method).toBe('GET');
      expect(tokenCall.headers).toMatchObject({ client_id: CLIENT_ID, sign_method: 'HMAC-SHA256' });
      expect(tokenCall.headers).not.toHaveProperty('access_token');
      expect(tokenCall.headers.t).toMatch(/^\d{13}$/);
      expect(tokenCall.headers.sign).toBe(expectedSign(tokenCall.headers, 'GET', '/v1.0/token?grant_type=1'));
    });

    it('signs business requests including the access token', async () => {
      fetchMock.mockResolvedValueOnce(tokenOk('tok-abc')).mockResolvedValueOnce(ok([]));
      await client.getStatus('dev1');

      const call = fetchCall(fetchMock, 1);
      expect(call.url).toBe(`${BASE}/v1.0/devices/dev1/status`);
      expect(call.headers.access_token).toBe('tok-abc');
      expect(call.headers.sign).toBe(expectedSign(call.headers, 'GET', '/v1.0/devices/dev1/status', '', 'tok-abc'));
    });

    it('uses a fresh nonce for every request', async () => {
      fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([]));
      await client.getStatus('a');
      await client.getStatus('b');

      const nonces = [0, 1, 2].map((n) => fetchCall(fetchMock, n).headers.nonce);
      expect(new Set(nonces).size).toBe(3);
    });
  });

  describe('access token', () => {
    it('is reused while valid', async () => {
      fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([]));
      await client.getStatus('a');
      await client.getStatus('b');

      const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1.0/token'));
      expect(tokenCalls).toHaveLength(1);
    });

    it('is renewed shortly before it expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      fetchMock
        .mockResolvedValueOnce(tokenOk('first', 3600))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(tokenOk('second', 3600))
        .mockResolvedValueOnce(ok([]));

      await client.getStatus('a');
      vi.setSystemTime(new Date('2026-06-01T00:59:30Z')); // inside the 60s safety margin
      await client.getStatus('b');

      expect(fetchCall(fetchMock, 2).url).toContain('/v1.0/token');
      expect(fetchCall(fetchMock, 3).headers.access_token).toBe('second');
    });

    it('is dropped after a 1010 (invalid token) error so the next call gets a new one', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenOk('stale'))
        .mockResolvedValueOnce(fail(1010, 'token invalid'))
        .mockResolvedValueOnce(tokenOk('fresh'))
        .mockResolvedValueOnce(ok([]));

      await expect(client.getStatus('a')).rejects.toThrow('code 1010 token invalid');
      await client.getStatus('a');

      expect(fetchCall(fetchMock, 3).headers.access_token).toBe('fresh');
    });

    it('surfaces token request failures', async () => {
      fetchMock.mockResolvedValueOnce(fail(1004, 'sign invalid'));

      await expect(client.getStatus('a')).rejects.toThrow('/v1.0/token?grant_type=1 failed: code 1004 sign invalid');
    });
  });

  describe('endpoints', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(tokenOk());
    });

    it('getDevice', async () => {
      fetchMock.mockResolvedValueOnce(ok({ id: 'dev1', name: 'Sensor' }));

      await expect(client.getDevice('dev1')).resolves.toEqual({ id: 'dev1', name: 'Sensor' });
      expect(fetchCall(fetchMock, 1).url).toBe(`${BASE}/v1.0/devices/dev1`);
    });

    it('getSpecification', async () => {
      fetchMock.mockResolvedValueOnce(ok({ category: 'zwjcy', status: [] }));

      await client.getSpecification('dev1');
      expect(fetchCall(fetchMock, 1).url).toBe(`${BASE}/v1.0/devices/dev1/specifications`);
    });

    it('URL-encodes device ids', async () => {
      fetchMock.mockResolvedValueOnce(ok([]));

      await client.getStatus('a/b');
      expect(fetchCall(fetchMock, 1).url).toBe(`${BASE}/v1.0/devices/a%2Fb/status`);
    });

    it('listDevices follows pagination', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ devices: [{ id: '1', name: 'one' }], has_more: true, last_row_key: 'k1' }))
        .mockResolvedValueOnce(ok({ devices: [{ id: '2', name: 'two' }], has_more: false }));

      const devices = await client.listDevices();

      expect(devices.map((d) => d.id)).toEqual(['1', '2']);
      expect(fetchCall(fetchMock, 1).url).toBe(`${BASE}/v1.0/iot-01/associated-users/devices?size=100`);
      expect(fetchCall(fetchMock, 2).url).toBe(
        `${BASE}/v1.0/iot-01/associated-users/devices?last_row_key=k1&size=100`,
      );
    });

    it('listDevices stops if has_more is set without a row key', async () => {
      fetchMock.mockResolvedValueOnce(ok({ devices: [], has_more: true }));

      await expect(client.listDevices()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('scaleOf', () => {
  const spec: TuyaSpecification = {
    category: 'zwjcy',
    status: [
      { code: 'temp_current', type: 'Integer', values: '{"unit":"℃","min":-400,"max":2000,"scale":1,"step":1}' },
      { code: 'humidity', type: 'Integer', values: '{"unit":"%","min":0,"max":100,"scale":0,"step":1}' },
      { code: 'no_scale', type: 'Integer', values: '{"min":0}' },
      { code: 'broken', type: 'Integer', values: 'not json' },
      { code: 'battery_state', type: 'Enum', values: '{"range":["low","middle","high"]}' },
    ],
  };

  it.each([
    ['temp_current', 1],
    ['humidity', 0],
    ['no_scale', 0],
    ['broken', 0],
    ['battery_state', 0],
    ['missing', 0],
  ])('%s -> %i', (code, expected) => {
    expect(scaleOf(spec, code)).toBe(expected);
  });
});
