import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { log } from '../log.ts';

/** One supplemental run the conductor started. */
export interface WateringRun {
  zoneKey: string;
  at: Date;
  minutes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Read-only view used by the planner. */
export interface WateringHistoryView {
  lastRun(zoneKey: string): WateringRun | undefined;
  /** Minutes of supplemental watering started in the 24 hours before `now`. */
  minutesInLastDay(zoneKey: string, now: Date): number;
}

/**
 * Remembers recent supplemental runs so cooldowns and daily caps survive restarts.
 * Without this, a crash loop would water again on every start.
 */
export class WateringHistory implements WateringHistoryView {
  #runs: WateringRun[];

  constructor(runs: WateringRun[] = []) {
    this.#runs = [...runs].sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  get runs(): readonly WateringRun[] {
    return this.#runs;
  }

  record(run: WateringRun): void {
    this.#runs.push(run);
    this.#runs.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  lastRun(zoneKey: string): WateringRun | undefined {
    return this.#runs.findLast((r) => r.zoneKey === zoneKey);
  }

  minutesInLastDay(zoneKey: string, now: Date): number {
    const since = now.getTime() - DAY_MS;
    return this.#runs
      .filter((r) => r.zoneKey === zoneKey && r.at.getTime() > since && r.at.getTime() <= now.getTime())
      .reduce((sum, r) => sum + r.minutes, 0);
  }

  /** Drops runs that can no longer affect any decision. `keepMs` must cover the longest cooldown. */
  prune(now: Date, keepMs: number): void {
    const cutoff = now.getTime() - Math.max(keepMs, DAY_MS);
    this.#runs = this.#runs.filter((r) => r.at.getTime() >= cutoff);
  }
}

const FileSchema = z.object({
  runs: z.array(z.object({ zoneKey: z.string(), at: z.iso.datetime(), minutes: z.number().nonnegative() })),
});

/** Persists the history as JSON; writes go to a temp file first so a crash can't leave half a file. */
export class FileHistoryStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<WateringHistory> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new WateringHistory();
      throw err;
    }
    let parsed;
    try {
      parsed = FileSchema.parse(JSON.parse(text));
    } catch (err) {
      log.warn(`Watering history ${this.#path} is unreadable; starting with an empty history`, err);
      return new WateringHistory();
    }
    return new WateringHistory(parsed.runs.map((r) => ({ zoneKey: r.zoneKey, at: new Date(r.at), minutes: r.minutes })));
  }

  async save(history: WateringHistory): Promise<void> {
    const body = {
      runs: history.runs.map((r) => ({ zoneKey: r.zoneKey, at: r.at.toISOString(), minutes: r.minutes })),
    };
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#path);
  }
}
