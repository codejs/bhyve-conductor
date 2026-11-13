/** Time-zone helpers built on Intl (no dependencies). Needed because B-hyve schedules are in the lawn's local time. */

export interface CivilDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

export interface LocalParts extends CivilDate {
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
};

/** Throws a RangeError for an unknown IANA time zone. */
export const assertTimeZone = (timeZone: string): void => {
  formatter(timeZone);
};

/** Wall-clock date and time of `date` in `timeZone`. */
export const localParts = (date: Date, timeZone: string): LocalParts & { second: number } => {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
};

/** Offset of `timeZone` from UTC at `date`, in ms (e.g. -5h for US Central daylight time). */
const offsetMs = (date: Date, timeZone: string): number => {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
};

/**
 * The instant at which the clock in `timeZone` reads the given wall time.
 *  - Ambiguous times (DST "fall back", e.g. 01:30 happens twice) resolve to the first occurrence.
 *  - Nonexistent times (DST "spring forward" gap, e.g. 02:30) resolve to the instant an hour later.
 */
export const zonedTime = (d: CivilDate, hour: number, minute: number, timeZone: string): Date => {
  const wall = Date.UTC(d.year, d.month - 1, d.day, hour, minute);
  const first = wall - offsetMs(new Date(wall), timeZone);
  const second = wall - offsetMs(new Date(first), timeZone);
  const matches = [first, second].filter((t) => {
    const p = localParts(new Date(t), timeZone);
    return p.year === d.year && p.month === d.month && p.day === d.day && p.hour === hour && p.minute === minute;
  });
  return new Date(matches.length > 0 ? Math.min(...matches) : Math.max(first, second));
};

/** Calendar arithmetic on a civil date (no time zone involved). */
export const addDays = (d: CivilDate, days: number): CivilDate & { weekday: number } => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), weekday: t.getUTCDay() };
};

/** Whole days from civil date `a` to civil date `b`. */
export const daysBetween = (a: CivilDate, b: CivilDate): number =>
  Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
