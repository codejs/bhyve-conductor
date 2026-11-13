import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { StationRun } from '../bhyve/types.ts';
import type { AlertState } from './alerts.ts';
import { log } from '../log.ts';
import { WateringHistory } from './history.ts';

/**
 * A cycle-and-soak sequence that hasn't finished. Persisted after every step so that a crash or
 * restart can pick it up where it left off (see sequencer.ts).
 */
export interface PendingSequence {
  id: string;
  deviceId: string;
  waves: StationRun[][];
  soakMinutes: number;
  /** Names of the zones being watered, for messages. */
  zoneNames?: string[];
  createdAt: Date;
  /** Index of the next wave to send. Waves before it have been sent and are in the history. */
  nextWave: number;
  /** When the next wave is (or was originally) due. Retries keep this, so the retry window is measured from it. */
  dueAt: Date;
  /** Failed attempts at the next wave so far. */
  attempts: number;
  /**
   * Set just before a wave is sent and cleared once its outcome is saved. Still set after a restart means
   * we crashed mid-send and can't know whether the device got it.
   */
  inFlight?: { wave: number; since: Date };
}

export interface ConductorState {
  history: WateringHistory;
  sequences: PendingSequence[];
  /** Open alert conditions (see alerts.ts). */
  alerts: AlertState;
}

const Run = z.object({ station: z.number().int().min(1), runTime: z.number().positive() });
const FileSchema = z.object({
  runs: z.array(z.object({ zoneKey: z.string(), at: z.iso.datetime(), minutes: z.number().nonnegative() })),
  // Absent in state files written before cycle-and-soak recovery existed.
  sequences: z
    .array(
      z.object({
        id: z.string(),
        deviceId: z.string(),
        waves: z.array(z.array(Run).min(1)).min(1),
        soakMinutes: z.number().nonnegative(),
        zoneNames: z.array(z.string()).optional(),
        createdAt: z.iso.datetime(),
        nextWave: z.number().int().nonnegative(),
        dueAt: z.iso.datetime(),
        attempts: z.number().int().nonnegative(),
        inFlight: z.object({ wave: z.number().int().nonnegative(), since: z.iso.datetime() }).optional(),
      }),
    )
    .default([]),
  alerts: z.record(z.string(), z.object({ state: z.string(), since: z.iso.datetime() })).default({}),
});

/** Persists history and pending sequences as one JSON file; writes go to a temp file first so a crash can't leave half a file. */
export class FileStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<ConductorState> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { history: new WateringHistory(), sequences: [], alerts: {} };
      throw err;
    }
    let parsed;
    try {
      parsed = FileSchema.parse(JSON.parse(text));
    } catch (err) {
      log.warn(`State file ${this.#path} is unreadable; starting with an empty history`, err);
      return { history: new WateringHistory(), sequences: [], alerts: {} };
    }
    return {
      history: new WateringHistory(parsed.runs.map((r) => ({ zoneKey: r.zoneKey, at: new Date(r.at), minutes: r.minutes }))),
      sequences: parsed.sequences.map((s) => ({
        id: s.id,
        deviceId: s.deviceId,
        waves: s.waves,
        soakMinutes: s.soakMinutes,
        ...(s.zoneNames ? { zoneNames: s.zoneNames } : {}),
        createdAt: new Date(s.createdAt),
        nextWave: s.nextWave,
        dueAt: new Date(s.dueAt),
        attempts: s.attempts,
        ...(s.inFlight ? { inFlight: { wave: s.inFlight.wave, since: new Date(s.inFlight.since) } } : {}),
      })),
      alerts: parsed.alerts,
    };
  }

  async save(state: ConductorState): Promise<void> {
    const body = {
      runs: state.history.runs.map((r) => ({ zoneKey: r.zoneKey, at: r.at.toISOString(), minutes: r.minutes })),
      sequences: state.sequences.map((s) => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
        dueAt: s.dueAt.toISOString(),
        ...(s.inFlight ? { inFlight: { wave: s.inFlight.wave, since: s.inFlight.since.toISOString() } } : {}),
      })),
      alerts: state.alerts,
    };
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#path);
  }
}
