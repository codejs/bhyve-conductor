import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../utils/fake-websocket.ts';
import { fetchCall, flush, jsonResponse, mockFetch, type FetchMock } from '../utils/fetch.ts';
import { BhyveClient } from '../../bhyve/client.ts';

const API = 'https://api.orbitbhyve.com/v1';
const CREDS = { email: 'me@example.com', password: 'pw' };
const session = (token = 'tok-1') => jsonResponse({ orbit_session_token: token, user_id: 'user-1' });

describe('BhyveClient', () => {
  let fetchMock: FetchMock;
  let client: BhyveClient;

  beforeEach(() => {
    fetchMock = mockFetch();
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    client = new BhyveClient(CREDS);
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  describe('REST', () => {
    it('logs in with the session payload', async () => {
      fetchMock.mockResolvedValueOnce(session());

      await expect(client.login()).resolves.toEqual({ orbit_session_token: 'tok-1', user_id: 'user-1' });

      const call = fetchCall(fetchMock, 0);
      expect(call.url).toBe(`${API}/session`);
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ session: { email: 'me@example.com', password: 'pw' } });
    });

    it('reports a failed login with the HTTP status', async () => {
      fetchMock.mockResolvedValueOnce(new Response('bad creds', { status: 400 }));

      await expect(client.login()).rejects.toThrow('B-hyve login failed: HTTP 400 bad creds');
    });

    it('rejects a login response without a token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ user_id: 'user-1' }));

      await expect(client.login()).rejects.toThrow('no orbit_session_token');
    });

    it('logs in automatically and lists devices for the user', async () => {
      fetchMock.mockResolvedValueOnce(session('tok-x')).mockResolvedValueOnce(jsonResponse([{ id: 'd1' }]));

      await expect(client.getDevices()).resolves.toEqual([{ id: 'd1' }]);

      const call = fetchCall(fetchMock, 1);
      expect(call.url).toBe(`${API}/devices?user_id=user-1`);
      expect(call.headers['orbit-session-token']).toBe('tok-x');
    });

    it('reuses the session across requests', async () => {
      fetchMock
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(jsonResponse({ id: 'd1' }))
        .mockResolvedValueOnce(jsonResponse([]));

      await client.getDevice('d1');
      await client.getPrograms();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchCall(fetchMock, 1).url).toBe(`${API}/devices/d1`);
      expect(fetchCall(fetchMock, 2).url).toBe(`${API}/sprinkler_timer_programs`);
    });

    it('logs in again once after a 401', async () => {
      fetchMock
        .mockResolvedValueOnce(session('old'))
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(session('new'))
        .mockResolvedValueOnce(jsonResponse([]));

      await client.getPrograms();

      expect(fetchCall(fetchMock, 2).url).toBe(`${API}/session`);
      expect(fetchCall(fetchMock, 3).headers['orbit-session-token']).toBe('new');
    });

    it('gives up after a second 401', async () => {
      fetchMock
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(new Response('nope', { status: 401 }));

      await expect(client.getPrograms()).rejects.toThrow('HTTP 401 nope');
    });

    it('reports other HTTP errors', async () => {
      fetchMock.mockResolvedValueOnce(session()).mockResolvedValueOnce(new Response('boom', { status: 500 }));

      await expect(client.getDevice('d1')).rejects.toThrow('B-hyve GET /devices/d1 failed: HTTP 500 boom');
    });
  });

  describe('event socket', () => {
    /** Logs in, opens the socket and completes the handshake. */
    const connect = async (token = 'tok-1') => {
      fetchMock.mockResolvedValueOnce(session(token));
      const connected = client.connect();
      await flush();
      const ws = FakeWebSocket.latest();
      ws.serverOpen();
      await connected;
      return ws;
    };

    it('authenticates with app_connection on open', async () => {
      const ws = await connect('tok-ws');

      expect(ws.url).toBe('wss://api.orbitbhyve.com/v1/events');
      expect(ws.sentJson).toEqual([{ event: 'app_connection', orbit_session_token: 'tok-ws' }]);
    });

    it('only opens one socket when connect() is called repeatedly', async () => {
      fetchMock.mockResolvedValueOnce(session());
      const a = client.connect();
      const b = client.connect();
      await flush();
      FakeWebSocket.latest().serverOpen();
      await Promise.all([a, b]);

      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('rejects connect() if the socket closes before opening', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      fetchMock.mockResolvedValueOnce(session());
      const connected = client.connect();
      await flush();
      FakeWebSocket.latest().serverClose(1006);

      await expect(connected).rejects.toThrow('closed before opening (code 1006)');
    });

    it('delivers events to listeners until they unsubscribe', async () => {
      const ws = await connect();
      const seen: string[] = [];
      const unsubscribe = client.onEvent((e) => seen.push(e.event));

      ws.serverMessage({ event: 'watering_in_progress_notification', device_id: 'd1' });
      unsubscribe();
      ws.serverMessage({ event: 'watering_complete', device_id: 'd1' });

      expect(seen).toEqual(['watering_in_progress_notification']);
    });

    it('keeps delivering when a listener throws or a message is not JSON', async () => {
      const ws = await connect();
      const good = vi.fn();
      client.onEvent(() => {
        throw new Error('listener bug');
      });
      client.onEvent(good);

      ws.serverMessage('not json');
      ws.serverMessage({ event: 'device_idle' });

      expect(good).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledWith({ event: 'device_idle' });
    });

    it('pings every 25 seconds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const ws = await connect();

      vi.advanceTimersByTime(50_000);

      expect(ws.sentJson.filter((m) => m.event === 'ping')).toHaveLength(2);
    });

    it('reconnects with backoff and a fresh login after an unexpected close', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const first = await connect('tok-1');

      fetchMock.mockResolvedValueOnce(session('tok-2'));
      first.serverClose(1006);
      vi.advanceTimersByTime(999);
      expect(FakeWebSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await flush();
      const second = FakeWebSocket.latest();
      expect(second).not.toBe(first);
      second.serverOpen();

      expect(second.sentJson[0]).toEqual({ event: 'app_connection', orbit_session_token: 'tok-2' });
    });

    it('doubles the reconnect delay on repeated failures, capped at 60s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      await connect();
      fetchMock.mockImplementation(async () => session());

      const delays: number[] = [];
      for (let i = 0; i < 8; i++) {
        const before = FakeWebSocket.instances.length;
        FakeWebSocket.latest().serverClose(1006);
        let waited = 0;
        while (FakeWebSocket.instances.length === before) {
          vi.advanceTimersByTime(1000);
          waited += 1000;
          await flush();
        }
        delays.push(waited);
      }

      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    });

    it('does not reconnect after close()', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      await connect();

      client.close();
      vi.advanceTimersByTime(120_000);
      await flush();

      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });

  describe('commands', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-01T06:00:00Z'));
    });

    /** Sends a command and returns what went over the socket after the handshake. */
    const send = async (command: () => Promise<void>) => {
      fetchMock.mockResolvedValueOnce(session());
      const done = command();
      await flush();
      FakeWebSocket.latest().serverOpen();
      await done;
      return FakeWebSocket.latest().sentJson.slice(1);
    };

    it('startWatering sends a manual change_mode with run times in minutes', async () => {
      const sent = await send(() =>
        client.startWatering('d1', [
          { station: 1, runTime: 5 },
          { station: 3, runTime: 2.5 },
        ]),
      );

      expect(sent).toEqual([
        {
          event: 'change_mode',
          mode: 'manual',
          device_id: 'd1',
          stations: [
            { station: 1, run_time: 5 },
            { station: 3, run_time: 2.5 },
          ],
          timestamp: '2026-07-01T06:00:00.000Z',
        },
      ]);
    });

    it('stopWatering returns the device to auto', async () => {
      const sent = await send(() => client.stopWatering('d1'));

      expect(sent).toEqual([
        { event: 'change_mode', mode: 'auto', device_id: 'd1', stations: [], timestamp: '2026-07-01T06:00:00.000Z' },
      ]);
    });

    it('setRainDelay sends hours', async () => {
      const sent = await send(() => client.setRainDelay('d1', 24));

      expect(sent).toEqual([{ event: 'rain_delay', device_id: 'd1', delay: 24, timestamp: '2026-07-01T06:00:00.000Z' }]);
    });

    it.each([
      ['no stations', []],
      ['station 0', [{ station: 0, runTime: 5 }]],
      ['fractional station', [{ station: 1.5, runTime: 5 }]],
      ['zero minutes', [{ station: 1, runTime: 0 }]],
      ['over 240 minutes', [{ station: 1, runTime: 241 }]],
      ['NaN minutes', [{ station: 1, runTime: Number.NaN }]],
    ])('startWatering rejects %s without contacting B-hyve', (_label, runs) => {
      expect(() => client.startWatering('d1', runs)).toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([-1, 1.5, 169, Number.NaN])('setRainDelay rejects %s hours', (hours) => {
      expect(() => client.setRainDelay('d1', hours)).toThrow('Invalid rain delay');
    });

    it('accepts the boundary values', async () => {
      const sent = await send(async () => {
        await client.startWatering('d1', [{ station: 1, runTime: 240 }]);
        await client.setRainDelay('d1', 0);
        await client.setRainDelay('d1', 168);
      });

      expect(sent).toHaveLength(3);
    });
  });
});
