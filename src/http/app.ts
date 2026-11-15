import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { filterEvents, parseSince, RECOVERY_TYPES, summarize, type AuditFilter } from '../audit/report.ts';
import type { ConductorDb } from '../db/database.ts';
import { log } from '../log.ts';
import { scenarioById } from '../sim/scenarios.ts';
import {
  hasSimulationTables,
  listSimulations,
  simulationEventCounts,
  simulationEvents,
  simulationNotifications,
  type StoredSimulation,
} from '../sim/store.ts';
import type {
  ErrorResponse,
  EventsResponse,
  NotificationsResponse,
  SimulationDto,
  SimulationListResponse,
  SimulationResponse,
  SummaryResponse,
} from './contract.ts';
import { isAllowedHost, normalizeHost } from './hosts.ts';

/**
 * The web API: read-only JSON over the stored simulations, the same data and filters as
 * `npm run audit -- --for-simulation`. See docs/web.md.
 *
 * Every request passes, in this order: security headers (on every response, errors included), the Host check
 * (hosts.ts: DNS rebinding), the method check (GET/HEAD only: nothing here changes anything), and strict
 * validation of the path and query (unknown or repeated parameters are refused, so a typo never silently
 * shows everything). Errors are JSON ({ error, issues? }) and never carry internals.
 */

export interface AppOptions {
  /** Opened read-only by the server (server.ts); the API never writes. */
  db: ConductorDb;
  /** Host names the server answers to (hosts.ts allowedHostsFor). */
  allowedHosts: readonly string[];
  /** The clock for relative times such as since=24h. */
  now?: () => Date;
}

// ------------------------------------------------------------------------------------------------
// Parameters. Patterns are anchored and bounded: no control characters, no SQL LIKE wildcards (Prisma's
// startsWith doesn't escape them), nothing longer than a real value.
// ------------------------------------------------------------------------------------------------

const SCENARIO = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ZONE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:\d{1,3}$/;
/** A sequence id (a UUID) or its first characters. */
const SEQUENCE = /^[0-9A-Za-z-]{1,36}$/;
/** An event type or a prefix of one: "wave", "sequence.abandoned", "service.unclean_shutdown". */
const TYPE = /^[a-z][a-z_]{0,39}(\.[a-z][a-z_]{0,39})?$/;
const MAX_TYPES = 30;
/** What parseSince() reads: a duration back from now ("90m", "24h", "7d", "2w") or an ISO date/time. */
const TIME = /^(\d{1,6}(\.\d{1,3})?\s?(m|min|h|d|w)|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?)$/i;
const TIME_HINT = 'expected a time like 2026-07-01T06:00Z or a duration like 24h or 7d';

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * Whether an ISO date/time names a real moment. JavaScript rolls impossible ones over (2026-02-31 is read as
 * March 3, T24:00 as the next day), which would silently show another window than the one asked for.
 */
export const isRealCalendarTime = (text: string): boolean => {
  const m = ISO_PARTS.exec(text);
  if (!m) return true; // a duration
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59;
};

const timeParam = (now: () => Date) =>
  z
    .string()
    .regex(TIME, TIME_HINT)
    .transform((text, ctx) => {
      try {
        if (!isRealCalendarTime(text)) throw new Error(text);
        return parseSince(text, now());
      } catch {
        ctx.addIssue({ code: 'custom', message: TIME_HINT });
        return z.NEVER;
      }
    });

const typesParam = z
  .string()
  .transform((text) => text.split(',').map((s) => s.trim()))
  .pipe(
    z
      .array(z.string().regex(TYPE, 'expected event types or prefixes, e.g. wave,sequence.abandoned'))
      .min(1)
      .max(MAX_TYPES, `at most ${MAX_TYPES} types`),
  );

const scenarioParam = z.strictObject({ scenario: z.string().regex(SCENARIO, 'expected a scenario id, e.g. crash-mid-soak') });
const noQuery = z.strictObject({});

/** since ≤ until, when both are given. */
const ordered = (q: { since?: Date | undefined; until?: Date | undefined }): boolean => !(q.since && q.until && q.since > q.until);
const ORDER_ISSUE = { message: 'since is after until', path: ['since'] };

const windowQuery = (now: () => Date) =>
  z.strictObject({ since: timeParam(now).optional(), until: timeParam(now).optional() }).refine(ordered, ORDER_ISSUE);

const eventsQuery = (now: () => Date) =>
  z
    .strictObject({
      since: timeParam(now).optional(),
      until: timeParam(now).optional(),
      types: typesParam.optional(),
      device: z.string().regex(DEVICE, 'expected a B-hyve device id').optional(),
      zone: z.string().regex(ZONE, 'expected <deviceId>:<station>').optional(),
      sequence: z.string().regex(SEQUENCE, 'expected a sequence id or its first characters').optional(),
      recovery: z.enum(['true', 'false']).optional(),
    })
    .refine(ordered, ORDER_ISSUE);

/** Issue messages may quote what was sent (an unknown parameter's name); keep them short. */
const clip = (text: string): string => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** A refused parameter: 400 with which one and why. */
interface ValidationIssue {
  code?: string;
  path: readonly PropertyKey[];
  message: string;
  /** unrecognized_keys: the parameters that aren't known. */
  keys?: readonly string[];
}
interface ValidationResult {
  success: boolean;
  error?: { issues: readonly ValidationIssue[] };
}

/** One entry per refused parameter; unknown ones by their own name. */
const issuesOf = (issues: readonly ValidationIssue[]): NonNullable<ErrorResponse['issues']> =>
  issues.flatMap((i) =>
    i.code === 'unrecognized_keys' && i.keys
      ? i.keys.map((key) => ({ parameter: clip(key), message: 'unknown parameter' }))
      : // Parameters are flat: a bad item of types=a,b is a bad `types`.
        [{ parameter: clip(i.path.length > 0 ? String(i.path[0]) : '(query)'), message: clip(i.message) }],
  );

const onInvalid = (result: ValidationResult, c: Context): Response | undefined => {
  if (result.success || !result.error) return undefined;
  return c.json({ error: 'invalid request', issues: issuesOf(result.error.issues) } satisfies ErrorResponse, 400);
};

const query = <T extends z.ZodType>(schema: T) => zValidator('query', schema, onInvalid);
const param = <T extends z.ZodType>(schema: T) => zValidator('param', schema, onInvalid);

// ------------------------------------------------------------------------------------------------

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export const createApp = ({ db, allowedHosts, now = () => new Date() }: AppOptions) => {
  const allowed = new Set(allowedHosts.map(normalizeHost));

  const dtoOf = (run: StoredSimulation, recoveryEvents: number): SimulationDto => {
    const scenario = scenarioById(run.scenario);
    return {
      scenario: run.scenario,
      title: run.title,
      storedAt: run.storedAt.toISOString(),
      startedAt: run.startedAt.toISOString(),
      hours: run.hours,
      timeZone: run.timeZone,
      events: run.events,
      recoveryEvents,
      notifications: run.notifications,
      story: scenario?.story ?? null,
      lookFor: scenario ? [...scenario.lookFor] : [],
    };
  };

  /** The stored run of a scenario; undefined if there is none (or the database predates stored simulations). */
  const findRun = async (scenario: string): Promise<StoredSimulation | undefined> =>
    hasSimulationTables(db) ? (await listSimulations(db, { scenarios: [scenario] }))[0] : undefined;

  const notStored = (c: Context, scenario: string) => c.json({ error: `no stored simulation of ${scenario}` } satisfies ErrorResponse, 404);

  const api = new Hono()
    .get('/simulations', query(noQuery), async (c) => {
      if (!hasSimulationTables(db)) return c.json({ simulations: [], available: false } satisfies SimulationListResponse, 200);
      const [runs, recovery] = await Promise.all([listSimulations(db), simulationEventCounts(db, RECOVERY_TYPES)]);
      const body: SimulationListResponse = { simulations: runs.map((r) => dtoOf(r, recovery.get(r.id) ?? 0)), available: true };
      return c.json(body, 200);
    })
    .get('/simulations/:scenario', param(scenarioParam), query(noQuery), async (c) => {
      const { scenario } = c.req.valid('param');
      const run = await findRun(scenario);
      if (!run) return notStored(c, scenario);
      const recovery = await simulationEventCounts(db, RECOVERY_TYPES);
      return c.json({ simulation: dtoOf(run, recovery.get(run.id) ?? 0) } satisfies SimulationResponse, 200);
    })
    .get('/simulations/:scenario/events', param(scenarioParam), query(eventsQuery(now)), async (c) => {
      const { scenario } = c.req.valid('param');
      const q = c.req.valid('query');
      const run = await findRun(scenario);
      if (!run) return notStored(c, scenario);
      const filter: AuditFilter = {
        ...(q.since ? { since: q.since } : {}),
        ...(q.until ? { until: q.until } : {}),
        ...(q.types ? { types: q.types } : {}),
        ...(q.device ? { device: q.device } : {}),
        ...(q.zone ? { zone: q.zone } : {}),
        ...(q.sequence ? { sequence: q.sequence } : {}),
        recovery: q.recovery === 'true',
      };
      // The query narrows by time and sequence; filterEvents applies everything (again), exactly as the CLI.
      const events = filterEvents(await simulationEvents(db, run.id, filter), filter);
      return c.json({ scenario, timeZone: run.timeZone, events, total: run.events } satisfies EventsResponse, 200);
    })
    .get('/simulations/:scenario/summary', param(scenarioParam), query(windowQuery(now)), async (c) => {
      const { scenario } = c.req.valid('param');
      const q = c.req.valid('query');
      const run = await findRun(scenario);
      if (!run) return notStored(c, scenario);
      // Every event in the window, unfiltered otherwise: a sequence's outcome needs its sequence.started.
      const window = { ...(q.since ? { since: q.since } : {}), ...(q.until ? { until: q.until } : {}) };
      const summary = summarize(filterEvents(await simulationEvents(db, run.id, window), window));
      return c.json({ scenario, timeZone: run.timeZone, summary } satisfies SummaryResponse, 200);
    })
    .get('/simulations/:scenario/notifications', param(scenarioParam), query(noQuery), async (c) => {
      const { scenario } = c.req.valid('param');
      const run = await findRun(scenario);
      if (!run) return notStored(c, scenario);
      const notifications = await simulationNotifications(db, run.id);
      return c.json({ scenario, timeZone: run.timeZone, notifications } satisfies NotificationsResponse, 200);
    });

  const app = new Hono()
    .use(
      secureHeaders({
        // JSON only so far: nothing may load, run or frame anything from here.
        contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
        xFrameOptions: 'DENY',
        referrerPolicy: 'no-referrer',
        // Plain HTTP on the local network; HSTS is for whatever terminates TLS in front of it, if anything.
        strictTransportSecurity: false,
      }),
    )
    .use(async (c, next) => {
      await next();
      // Never kept by the browser or a proxy, errors included: it's the garden's history, and it changes.
      // (The web app's static files will get their own policy.)
      c.header('Cache-Control', 'no-store');
    })
    .use(async (c, next) => {
      if (!isAllowedHost(c.req.url, allowed)) return c.json({ error: 'host not allowed' } satisfies ErrorResponse, 403);
      await next();
    })
    .use(async (c, next) => {
      if (!READ_METHODS.has(c.req.method)) {
        c.header('Allow', 'GET, HEAD');
        return c.json({ error: 'method not allowed' } satisfies ErrorResponse, 405);
      }
      await next();
    })
    .route('/api', api);

  app.notFound((c) => c.json({ error: 'not found' } satisfies ErrorResponse, 404));
  app.onError((err, c) => {
    log.error(`Web API: ${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: 'internal error' } satisfies ErrorResponse, 500);
  });
  return app;
};

/** The API's type, for the web app's typed client (hono/client). */
export type Api = ReturnType<typeof createApp>;
