import { createHash, createHmac, randomUUID } from 'node:crypto';
import { log } from '../log.ts';

/**
 * Minimal Tuya Cloud OpenAPI client (HMAC-SHA256 request signing).
 * Docs: https://developer.tuya.com/en/docs/iot/new-singnature
 *
 * The MOES Zigbee gateway is a Tuya device: Zigbee sub-devices (soil sensors) report to the Tuya
 * cloud via the gateway, and this client reads them from there.
 */

export interface TuyaCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  /** Abort requests that take longer than this (default 20s); a half-open connection would otherwise hang forever. */
  requestTimeoutMs?: number;
}

export interface TuyaDataPoint {
  code: string;
  value: unknown;
}

export interface TuyaDevice {
  id: string;
  name: string;
  category?: string;
  product_name?: string;
  model?: string;
  online?: boolean;
  /** Set on Zigbee sub-devices: the gateway's device id. */
  gateway_id?: string;
  status?: TuyaDataPoint[];
  [key: string]: unknown;
}

export interface TuyaSpecification {
  category: string;
  status: { code: string; type: string; values: string }[];
  functions?: { code: string; type: string; values: string }[];
}

interface TuyaResponse<T> {
  success: boolean;
  result: T;
  code?: number;
  msg?: string;
  t: number;
}

interface TokenResult {
  access_token: string;
  refresh_token: string;
  expire_time: number; // seconds
  uid: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export class TuyaClient {
  readonly #creds: TuyaCredentials;
  readonly #timeoutMs: number;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(creds: TuyaCredentials) {
    this.#creds = { ...creds, baseUrl: creds.baseUrl.replace(/\/+$/, '') };
    this.#timeoutMs = creds.requestTimeoutMs ?? 20_000;
  }

  #sign(method: string, path: string, body: string, accessToken: string, t: string, nonce: string): string {
    const stringToSign = [method, sha256(body), '', path].join('\n');
    const payload = this.#creds.clientId + accessToken + t + nonce + stringToSign;
    return createHmac('sha256', this.#creds.clientSecret).update(payload).digest('hex').toUpperCase();
  }

  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt) return this.#token.value;
    const result = await this.#request<TokenResult>('GET', '/v1.0/token?grant_type=1', undefined, false);
    // Refresh a minute early.
    this.#token = { value: result.access_token, expiresAt: Date.now() + (result.expire_time - 60) * 1000 };
    log.debug(`Tuya token acquired (expires in ${result.expire_time}s)`);
    return result.access_token;
  }

  /** `path` includes the query string; query keys must already be sorted alphabetically for signing. */
  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    const accessToken = auth ? await this.#accessToken() : '';
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const t = Date.now().toString();
    const nonce = randomUUID();

    const headers: Record<string, string> = {
      client_id: this.#creds.clientId,
      sign: this.#sign(method, path, bodyStr, accessToken, t, nonce),
      sign_method: 'HMAC-SHA256',
      t,
      nonce,
    };
    if (auth) headers.access_token = accessToken;
    if (bodyStr) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(this.#creds.baseUrl + path, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(bodyStr ? { body: bodyStr } : {}),
      });
    } catch (err) {
      const why = err instanceof DOMException && err.name === 'TimeoutError' ? `timed out after ${this.#timeoutMs / 1000}s` : String(err);
      throw new Error(`Tuya ${method} ${path.split('?')[0]} ${why}`, { cause: err });
    }
    const json = (await res.json()) as TuyaResponse<T>;
    if (!json.success) {
      // 1010 = token invalid/expired: drop it so the next call fetches a new one.
      if (json.code === 1010) this.#token = undefined;
      throw new Error(`Tuya ${method} ${path} failed: code ${json.code} ${json.msg}`);
    }
    return json.result;
  }

  /** All devices in app accounts linked to the cloud project (includes Zigbee sub-devices). */
  async listDevices(): Promise<TuyaDevice[]> {
    const devices: TuyaDevice[] = [];
    let lastRowKey = '';
    for (;;) {
      const query = lastRowKey ? `last_row_key=${encodeURIComponent(lastRowKey)}&size=100` : 'size=100';
      const page = await this.#request<{ devices: TuyaDevice[]; has_more: boolean; last_row_key?: string }>(
        'GET',
        `/v1.0/iot-01/associated-users/devices?${query}`,
      );
      devices.push(...page.devices);
      if (!page.has_more || !page.last_row_key) break;
      lastRowKey = page.last_row_key;
    }
    return devices;
  }

  getDevice(deviceId: string): Promise<TuyaDevice> {
    return this.#request<TuyaDevice>('GET', `/v1.0/devices/${encodeURIComponent(deviceId)}`);
  }

  getStatus(deviceId: string): Promise<TuyaDataPoint[]> {
    return this.#request<TuyaDataPoint[]>('GET', `/v1.0/devices/${encodeURIComponent(deviceId)}/status`);
  }

  /** Data-point definitions, including numeric `scale` (value / 10^scale = real value). */
  getSpecification(deviceId: string): Promise<TuyaSpecification> {
    return this.#request<TuyaSpecification>('GET', `/v1.0/devices/${encodeURIComponent(deviceId)}/specifications`);
  }
}

/** Returns the `scale` for a numeric data point from its spec, or 0. */
export const scaleOf = (spec: TuyaSpecification, code: string): number => {
  const dp = spec.status.find((s) => s.code === code);
  if (!dp || dp.type !== 'Integer') return 0;
  try {
    const { scale } = JSON.parse(dp.values) as { scale?: number };
    return typeof scale === 'number' ? scale : 0;
  } catch {
    return 0;
  }
};
