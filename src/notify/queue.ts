import { systemClock, type Clock } from '../clock.ts';
import { log } from '../log.ts';
import { TelegramPermanentError, TelegramRateLimitError } from './telegram.ts';

/**
 * Delivers messages one at a time with a minimum gap (Telegram allows about one message per second per
 * chat), retrying failures with back-off. It never throws and never blocks the caller: watering must
 * not wait for, or fail because of, a notification.
 */

export interface Transport {
  send(text: string): Promise<void>;
}

export interface QueueOptions {
  minIntervalMs: number;
  /** Messages waiting at send time are combined into one, up to this many characters (Telegram allows 4096). */
  maxBatchChars: number;
  /** Waits between attempts; a message is dropped after the last one fails. */
  retryDelaysMs: number[];
  /** Oldest messages are dropped beyond this (e.g. during a long Telegram outage). */
  maxQueued: number;
}

export const DEFAULT_QUEUE: QueueOptions = {
  minIntervalMs: 1_100,
  maxBatchChars: 3_500,
  retryDelaysMs: [5_000, 30_000, 120_000, 600_000],
  maxQueued: 100,
};

export type DropReason = { text: string; error: string; attempts: number };

export class DeliveryQueue {
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #opts: QueueOptions;
  readonly #onDrop: (d: DropReason) => void;
  readonly #items: { text: string; attempts: number }[] = [];
  #running = false;
  #idle: (() => void)[] = [];
  #stopped = false;

  constructor(transport: Transport, opts: Partial<QueueOptions> = {}, onDrop: (d: DropReason) => void = () => {}, clock: Clock = systemClock) {
    this.#transport = transport;
    this.#opts = { ...DEFAULT_QUEUE, ...opts };
    this.#onDrop = onDrop;
    this.#clock = clock;
  }

  get size(): number {
    return this.#items.length;
  }

  enqueue(text: string): void {
    if (this.#stopped) return;
    this.#items.push({ text, attempts: 0 });
    this.#trim();
    if (!this.#running) void this.#run();
  }

  /** Drops the oldest waiting messages beyond `maxQueued` (never one that is being sent). */
  #trim(): void {
    while (this.#items.length > this.#opts.maxQueued) {
      const dropped = this.#items.shift();
      if (dropped) this.#onDrop({ text: dropped.text, error: 'queue full', attempts: dropped.attempts });
    }
  }

  /** Resolves when everything queued so far has been delivered or dropped. */
  flush(): Promise<void> {
    if (!this.#running && this.#items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  /** Stops delivering; anything still queued is dropped (and reported). */
  stop(): void {
    this.#stopped = true;
    for (const item of this.#items.splice(0)) this.#onDrop({ text: item.text, error: 'stopped', attempts: item.attempts });
    for (const resolve of this.#idle.splice(0)) resolve();
  }

  async #run(): Promise<void> {
    this.#running = true;
    try {
      while (!this.#stopped && this.#items.length > 0) {
        // Everything waiting goes out as one message (a burst of alerts shouldn't be a burst of pings).
        let count = 1;
        let length = this.#items[0]?.text.length ?? 0;
        while (count < this.#items.length && length + 2 + (this.#items[count]?.text.length ?? 0) <= this.#opts.maxBatchChars) {
          length += 2 + (this.#items[count]?.text.length ?? 0);
          count++;
        }
        // Take the batch out of the queue while it's in flight, so overflow can only drop waiting messages.
        const batch = this.#items.splice(0, count);
        const item = batch[0];
        if (!item) break;
        try {
          await this.#transport.send(batch.map((b) => b.text).join('\n\n'));
          await this.#sleep(this.#opts.minIntervalMs);
        } catch (err) {
          const attempt = Math.max(...batch.map((b) => b.attempts)) + 1;
          for (const b of batch) b.attempts = attempt;
          const error = err instanceof Error ? err.message : String(err);
          const wait =
            err instanceof TelegramRateLimitError ? err.retryAfterSeconds * 1000 : this.#opts.retryDelaysMs[item.attempts - 1];
          if (err instanceof TelegramPermanentError || wait === undefined) {
            log.error(`Notification dropped after ${item.attempts} attempt(s): ${error}`);
            for (const b of batch) this.#onDrop({ text: b.text, error, attempts: b.attempts });
            continue;
          }
          log.warn(`Notification failed (${error}); retrying in ${Math.round(wait / 1000)}s`);
          this.#items.unshift(...batch); // back at the front, in order
          this.#trim();
          await this.#sleep(wait);
        }
      }
    } finally {
      this.#running = false;
      if (this.#items.length === 0 || this.#stopped) for (const resolve of this.#idle.splice(0)) resolve();
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.#clock.setTimeout(resolve, ms));
  }
}
