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
