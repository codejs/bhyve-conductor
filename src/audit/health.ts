import { log } from '../log.ts';
import { errorMessage, type AuditSink } from './audit.ts';

/**
 * `bhyve` is the REST API (device status, programs); `bhyve-commands` is the WebSocket that carries
 * watering commands. They fail independently (e.g. REST answers while the socket can't connect).
 */
export type ServiceName = 'bhyve' | 'bhyve-commands' | 'tuya' | 'weather';

/**
 * Tracks whether each remote service is reachable and audits the transitions only: one
 * `connection.lost` when it starts failing and one `connection.restored` (with the outage length and
 * number of failures) when it answers again, rather than an entry for every failed request.
 */
export class ConnectionHealth {
  readonly #audit: AuditSink;
  readonly #now: () => Date;
  readonly #down = new Map<ServiceName, { since: Date; failures: number; lastError: string }>();

  constructor(audit: AuditSink, now: () => Date = () => new Date()) {
    this.#audit = audit;
    this.#now = now;
  }

  ok(service: ServiceName): void {
    const outage = this.#down.get(service);
    if (!outage) return;
    this.#down.delete(service);
    const minutes = Math.round(((this.#now().getTime() - outage.since.getTime()) / 60_000) * 10) / 10;
    log.info(`${service} is reachable again after ${minutes} min (${outage.failures} failed attempts)`);
    this.#audit.record('connection.restored', {
      service,
      downSince: outage.since.toISOString(),
      outageMinutes: minutes,
      failures: outage.failures,
      lastError: outage.lastError,
    });
  }

  failed(service: ServiceName, err: unknown): void {
    const message = errorMessage(err);
    const outage = this.#down.get(service);
    if (outage) {
      outage.failures++;
      outage.lastError = message;
      return;
    }
    this.#down.set(service, { since: this.#now(), failures: 1, lastError: message });
    log.warn(`${service} is unreachable: ${message}`);
    this.#audit.record('connection.lost', { service, error: message });
  }

  isDown(service: ServiceName): boolean {
    return this.#down.has(service);
  }
}
