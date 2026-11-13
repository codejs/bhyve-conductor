/**
 * Time source and timers, injectable so the whole conductor can run in virtual time (see
 * scripts/simulate.ts). The system clock looks up the global timer functions on every call, so test
 * fake timers keep working.
 */
export type TimerHandle = { readonly __timer: unique symbol } | NodeJS.Timeout;

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
};

/** A clock that only moves when told to; timers run in order as it advances. */
export class VirtualClock implements Clock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start: Date) {
    this.#now = start.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    if (handle !== undefined) this.#timers.delete(handle as unknown as number);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  /**
   * Moves time forward to `target`, running each due timer at its own time and letting the promise
   * chains it starts settle before the next one (the conductor's fakes resolve in microtasks).
   */
  async advanceTo(target: Date): Promise<void> {
    const end = target.getTime();
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].fn();
    }
    this.#now = Math.max(this.#now, end);
    await settle();
  }

  advanceBy(ms: number): Promise<void> {
    return this.advanceTo(new Date(this.#now + ms));
  }
}

/** Lets pending promise callbacks run (a macrotask turn drains the whole microtask queue). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
