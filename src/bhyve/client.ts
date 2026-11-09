import { log } from '../log.ts';
import type { BhyveDevice, BhyveEvent, BhyveProgram, BhyveSession, StationRun } from './types.ts';

const API_BASE = 'https://api.orbitbhyve.com/v1';
const WS_URL = 'wss://api.orbitbhyve.com/v1/events';
const PING_INTERVAL_MS = 25_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface BhyveCredentials {
  email: string;
  password: string;
}

type EventListener = (event: BhyveEvent) => void;

/**
 * Client for the unofficial Orbit B-hyve cloud API.
 *  - REST (login, devices, programs) for reading state.
 *  - WebSocket for commands (start/stop watering, rain delay) and live events.
 */
export class BhyveClient {
  readonly #creds: BhyveCredentials;
  #session: BhyveSession | undefined;

  #ws: WebSocket | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempts = 0;
  #closing = false;
  #wsReady: Promise<void> | undefined;
  readonly #listeners = new Set<EventListener>();

  constructor(creds: BhyveCredentials) {
    this.#creds = creds;
  }

  // ---------- REST ----------

  async login(): Promise<BhyveSession> {
    const res = await fetch(`${API_BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ session: { email: this.#creds.email, password: this.#creds.password } }),
    });
    if (!res.ok) {
      throw new Error(`B-hyve login failed: HTTP ${res.status} ${await res.text()}`);
    }
    const session = (await res.json()) as BhyveSession;
    if (!session.orbit_session_token) throw new Error('B-hyve login response had no orbit_session_token');
    this.#session = session;
    log.debug(`B-hyve logged in as user ${session.user_id}`);
    return session;
  }

  async #token(): Promise<string> {
    return (this.#session ?? (await this.login())).orbit_session_token;
  }

  async #get<T>(path: string, retry = true): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json', 'orbit-session-token': await this.#token() },
    });
    if (res.status === 401 && retry) {
      this.#session = undefined; // token expired: log in again once
      return this.#get<T>(path, false);
    }
    if (!res.ok) throw new Error(`B-hyve GET ${path} failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async getDevices(): Promise<BhyveDevice[]> {
    const session = this.#session ?? (await this.login());
    return this.#get<BhyveDevice[]>(`/devices?user_id=${encodeURIComponent(session.user_id)}`);
  }

  async getDevice(deviceId: string): Promise<BhyveDevice> {
    return this.#get<BhyveDevice>(`/devices/${encodeURIComponent(deviceId)}`);
  }

  async getPrograms(): Promise<BhyveProgram[]> {
    return this.#get<BhyveProgram[]>('/sprinkler_timer_programs');
  }

  // ---------- WebSocket ----------

  /** Subscribe to live events. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Opens the events socket (idempotent). Reconnects automatically until `close()` is called. */
  connect(): Promise<void> {
    this.#closing = false;
    this.#wsReady ??= this.#openSocket();
    return this.#wsReady;
  }

  async #openSocket(): Promise<void> {
    const token = await this.#token();

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.#ws = ws;
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        this.#reconnectAttempts = 0;
        ws.send(JSON.stringify({ event: 'app_connection', orbit_session_token: token }));
        this.#pingTimer = setInterval(() => this.#send({ event: 'ping' }), PING_INTERVAL_MS);
        log.info('B-hyve event socket connected');
        resolve();
      });

      ws.addEventListener('message', (msg) => {
        let event: BhyveEvent;
        try {
          event = JSON.parse(String(msg.data)) as BhyveEvent;
        } catch {
          log.warn('B-hyve: non-JSON socket message', msg.data);
          return;
        }
        for (const listener of this.#listeners) {
          try {
            listener(event);
          } catch (err) {
            log.error('B-hyve event listener threw', err);
          }
        }
      });

      ws.addEventListener('close', (ev) => {
        clearInterval(this.#pingTimer);
        this.#ws = undefined;
        this.#wsReady = undefined;
        if (!opened) {
          reject(new Error(`B-hyve socket closed before opening (code ${ev.code})`));
        }
        if (!this.#closing) this.#scheduleReconnect(ev.code);
      });

      ws.addEventListener('error', () => {
        // 'close' always follows 'error'; reconnect logic lives there.
        log.warn('B-hyve socket error');
      });
    });
  }

  #scheduleReconnect(code: number): void {
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.#reconnectAttempts++;
    log.warn(`B-hyve socket closed (code ${code}); reconnecting in ${delay / 1000}s`);
    this.#reconnectTimer = setTimeout(() => {
      // Fresh login on reconnect in case the token was the problem.
      this.#session = undefined;
      this.connect().catch((err: unknown) => log.error('B-hyve reconnect failed', err));
    }, delay);
  }

  #send(payload: Record<string, unknown>): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      throw new Error('B-hyve socket is not connected; call connect() first');
    }
    this.#ws.send(JSON.stringify(payload));
  }

  async #command(payload: Record<string, unknown>): Promise<void> {
    await this.connect();
    const message = { ...payload, timestamp: new Date().toISOString() };
    log.debug('B-hyve command', message);
    this.#send(message);
  }

  /** Start a manual run on one or more zones of a device. `runTime` is in minutes. */
  startWatering(deviceId: string, runs: StationRun[]): Promise<void> {
    if (runs.length === 0) throw new Error('startWatering needs at least one station');
    for (const r of runs) {
      if (!Number.isInteger(r.station) || r.station < 1) throw new Error(`Invalid station ${r.station}`);
      if (!(r.runTime > 0 && r.runTime <= 240)) throw new Error(`Invalid runTime ${r.runTime} min for station ${r.station}`);
    }
    return this.#command({
      event: 'change_mode',
      mode: 'manual',
      device_id: deviceId,
      stations: runs.map((r) => ({ station: r.station, run_time: r.runTime })),
    });
  }

  /** Stop any manual run and return the device to its normal schedule. */
  stopWatering(deviceId: string): Promise<void> {
    return this.#command({ event: 'change_mode', mode: 'auto', device_id: deviceId, stations: [] });
  }

  /** Set a rain delay in hours (0 cancels it). */
  setRainDelay(deviceId: string, hours: number): Promise<void> {
    if (!(Number.isInteger(hours) && hours >= 0 && hours <= 168)) throw new Error(`Invalid rain delay ${hours}h`);
    return this.#command({ event: 'rain_delay', device_id: deviceId, delay: hours });
  }

  close(): void {
    this.#closing = true;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
    this.#ws = undefined;
    this.#wsReady = undefined;
  }
}
