import { z } from 'zod';
import { addDays, daysBetween, localParts, zonedTime, type CivilDate } from '../time.ts';
import type { BhyveDevice, BhyveProgram } from './types.ts';

/**
 * Expands B-hyve watering programs into concrete upcoming runs, so the water budget can count water
 * the regular schedule is already going to apply.
 *
 * The program format is reverse-engineered (see types.ts). Anything we don't understand is skipped and
 * reported as a warning rather than guessed at.
 */

export interface ScheduledRun {
  deviceId: string;
  station: number;
  start: Date;
  /** After the program's seasonal budget is applied. */
  minutes: number;
  program: string;
}

export interface ScheduleResult {
  runs: ScheduledRun[];
  warnings: string[];
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const ProgramSchema = z.object({
  id: z.string(),
  device_id: z.string(),
  name: z.string().optional(),
  program: z.string().optional(),
  enabled: z.boolean().optional(),
  frequency: z.object({
    type: z.string(),
    days: z.array(z.number().int().min(0).max(6)).optional(),
    interval: z.number().int().positive().optional(),
    interval_start_time: z.string().optional(),
  }),
  start_times: z.array(z.string().regex(HHMM)),
  run_times: z.array(z.object({ station: z.number().int().min(1), run_time: z.number().nonnegative() })),
  budget: z.number().nonnegative().optional(),
});
type Program = z.infer<typeof ProgramSchema>;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const label = (p: { name?: string | undefined; program?: string | undefined; id: string }): string =>
  p.name ?? (p.program ? `program ${p.program.toUpperCase()}` : `program ${p.id}`);

/** Returns a day-matcher for the program's frequency, or an error message. */
const dayMatcher = (p: Program, timeZone: string): ((day: CivilDate & { weekday: number }) => boolean) | string => {
  const f = p.frequency;
  switch (f.type) {
    case 'days': {
      const days = new Set(f.days ?? []);
      return (d) => days.has(d.weekday);
    }
    case 'odd':
      return (d) => d.day % 2 === 1;
    case 'even':
      return (d) => d.day % 2 === 0;
    case 'interval': {
      const startAt = f.interval_start_time ? new Date(f.interval_start_time) : undefined;
      if (!f.interval || !startAt || Number.isNaN(startAt.getTime())) {
        return 'interval frequency without a valid interval/interval_start_time';
      }
      const interval = f.interval;
      const start = localParts(startAt, timeZone);
      return (d) => {
        const n = daysBetween(start, d);
        return n >= 0 && n % interval === 0;
      };
    }
    default:
      return `unsupported frequency type "${f.type}"`;
  }
};

/**
 * Scheduled runs starting in [from, to), interpreted in `timeZone` (the lawn's local time).
 * Devices that are off produce no runs; runs inside an active rain delay are dropped.
 */
export const upcomingRuns = (
  programs: readonly BhyveProgram[],
  devices: readonly BhyveDevice[],
  from: Date,
  to: Date,
  timeZone: string,
): ScheduleResult => {
  const runs: ScheduledRun[] = [];
  const warnings: string[] = [];
  const byId = new Map(devices.map((d) => [d.id, d]));

  for (const raw of programs) {
    if (raw.enabled === false) continue;
    const device = byId.get(raw.device_id);
    if (!device || device.status?.run_mode === 'off') continue;

    const parsed = ProgramSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      warnings.push(`Skipping ${label(raw)} on ${device.name}: unrecognised format (${issue?.path.join('.')}: ${issue?.message})`);
      continue;
    }
    const p = parsed.data;
    const matches = dayMatcher(p, timeZone);
    if (typeof matches === 'string') {
      warnings.push(`Skipping ${label(p)} on ${device.name}: ${matches}`);
      continue;
    }

    // The rain delay's start time isn't reliably reported, so assume it runs from now (the longest it could).
    const rainDelayH = device.status?.rain_delay ?? 0;
    const blockedUntil = from.getTime() + (rainDelayH > 0 ? rainDelayH * HOUR_MS : 0);
    const scale = (p.budget ?? 100) / 100;

    // Start a day early: a run that began yesterday evening can't reach into the window, but a
    // multi-zone program that started before `from` can still have zones left to run.
    const firstDay = addDays(localParts(from, timeZone), -1);
    const lastDay = localParts(to, timeZone);
    for (let i = 0, day = firstDay; daysBetween(day, lastDay) >= 0; i++, day = addDays(firstDay, i)) {
      if (!matches(day)) continue;
      for (const hhmm of p.start_times) {
        const [, h, m] = HHMM.exec(hhmm) ?? [];
        let at = zonedTime(day, Number(h), Number(m), timeZone).getTime();
        for (const rt of p.run_times) {
          const minutes = rt.run_time * scale;
          if (minutes > 0 && at >= from.getTime() && at < to.getTime() && at >= blockedUntil) {
            runs.push({ deviceId: p.device_id, station: rt.station, start: new Date(at), minutes, program: label(p) });
          }
          at += minutes * MINUTE_MS; // zones run back to back
        }
      }
    }
  }

  runs.sort((a, b) => a.start.getTime() - b.start.getTime() || a.station - b.station);
  return { runs, warnings };
};
