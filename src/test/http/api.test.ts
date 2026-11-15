import { hc } from 'hono/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filterEvents, RECOVERY_TYPES, summarize, type AuditFilter } from '../../audit/report.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { createApp, type Api } from '../../http/app.ts';
import type {
  ErrorResponse,
  EventsResponse,
  NotificationsResponse,
  SimulationDto,
  SimulationListResponse,
  SimulationResponse,
  SummaryResponse,
} from '../../http/contract.ts';
import { allowedHostsFor } from '../../http/hosts.ts';
import { log } from '../../log.ts';
import type { SimResult } from '../../sim/runner.ts';
import { storeSimulation } from '../../sim/store.ts';
import { databaseBeforeSimulations, pick, renamed, runScenarios } from '../utils/simulations.ts';

/**
 * The web API answers what `npm run audit -- --for-simulation` shows: the same stored simulations, the same
 * filters with the same meaning, the summary and the notifications, as JSON.
 */

/** Real time: a month after the simulated summer day (2026-07-01). */
const NOW = new Date('2026-08-02T12:00:00.000Z');
const STORED_AT = new Date('2026-08-01T15:00:00.000Z');
const IDS = ['bhyve-long-outage', 'crash-mid-soak', 'normal-watering'] as const;
/** Stored, but this version of the code no longer defines it. */
const RETIRED = 'retired-scenario';

let results: Map<string, SimResult>;
const sim = (id: string): SimResult => pick(results, id);
let db: ConductorDb;
let app: Api;
let dir: string;

beforeAll(async () => {
  results = await runScenarios(IDS);
  db = openDatabase(':memory:');
  for (const id of IDS) await storeSimulation(db, sim(id), STORED_AT);
  await storeSimulation(db, renamed(sim('normal-watering'), RETIRED, 'An old scenario'), STORED_AT);
  app = createApp({ db, allowedHosts: allowedHostsFor('127.0.0.1'), now: () => NOW });
  dir = await mkdtemp(join(tmpdir(), 'web-api-'));
}, 60_000);

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string, target: Api = app): Promise<Response> => Promise.resolve(target.request(`http://localhost${path}`));
const read = async <T>(res: Response, status = 200): Promise<T> => {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  return (await res.json()) as T;
};
const eventsOf = (id: string, query = ''): Promise<EventsResponse> => get(`/api/simulations/${id}/events${query}`).then((r) => read<EventsResponse>(r));

const recoveryCount = (r: SimResult): number => r.events.filter((e) => RECOVERY_TYPES.has(e.type)).length;
const dtoOf = (r: SimResult, overrides: Partial<SimulationDto> = {}): SimulationDto => ({
  scenario: r.scenario.id,
  title: r.scenario.title,
  storedAt: STORED_AT.toISOString(),
  startedAt: r.startedAt.toISOString(),
  hours: r.scenario.hours,
  timeZone: r.timeZone,
  events: r.events.length,
  recoveryEvents: recoveryCount(r),
  notifications: r.notifications.length,
  story: r.scenario.story,
  lookFor: r.scenario.lookFor,
  ...overrides,
});
const firstSequence = (id: string): string => {
  const s = sim(id).events.find((e) => e.type === 'sequence.started')?.sequence;
  if (typeof s !== 'string') throw new Error(`${id} starts no sequence`);
  return s;
};

describe('GET /api/simulations', () => {
  it('lists every stored simulation by scenario id, with its counts, times and what the scenario is about', async () => {
    const body = await read<SimulationListResponse>(await get('/api/simulations'));

    expect(body).toEqual({
      available: true,
      simulations: [
        dtoOf(sim('bhyve-long-outage')),
        dtoOf(sim('crash-mid-soak')),
        dtoOf(sim('normal-watering')),
        dtoOf(sim('normal-watering'), { scenario: RETIRED, title: 'An old scenario', story: null, lookFor: [] }),
      ],
    });
  });

  it('counts failures and recoveries (the ! of npm run audit) per simulation', async () => {
    const body = await read<SimulationListResponse>(await get('/api/simulations'));
    const counts = Object.fromEntries(body.simulations.map((s) => [s.scenario, s.recoveryEvents]));

    expect(counts['bhyve-long-outage']).toBeGreaterThan(0);
    expect(counts['normal-watering']).toBe(0);
  });

  it('an empty list for a database with nothing stored', async () => {
    const empty = openDatabase(':memory:');
    try {
      const res = await get('/api/simulations', createApp({ db: empty, allowedHosts: ['localhost'] }));
      expect(await read<SimulationListResponse>(res)).toEqual({ simulations: [], available: true });
    } finally {
      await empty.close();
    }
  });

  it('says when the database predates stored simulations, and leaves it as it is', async () => {
    const path = await databaseBeforeSimulations(dir);
    vi.spyOn(log, 'warn').mockImplementation(() => {}); // "not up to date"
    const old = openDatabase(path, { readOnly: true });
    try {
      const oldApp = createApp({ db: old, allowedHosts: ['localhost'] });
      expect(await read<SimulationListResponse>(await get('/api/simulations', oldApp))).toEqual({ simulations: [], available: false });
      for (const sub of ['', '/events', '/summary', '/notifications']) {
        const res = await get(`/api/simulations/crash-mid-soak${sub}`, oldApp);
        expect(await read<ErrorResponse>(res, 404)).toEqual({ error: 'no stored simulation of crash-mid-soak' });
      }
      expect(old.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'simulation%'").get()).toEqual({ n: 0 });
    } finally {
      await old.close();
    }
  });
});

describe('GET /api/simulations/:scenario', () => {
  it.each(IDS)('%s: the stored simulation', async (id) => {
    expect(await read<SimulationResponse>(await get(`/api/simulations/${id}`))).toEqual({ simulation: dtoOf(sim(id)) });
  });

  it.each(['', '/events', '/summary', '/notifications'])('404 for a scenario that is not stored (%s)', async (sub) => {
    const res = await get(`/api/simulations/tuya-outage${sub}`);
    expect(await read<ErrorResponse>(res, 404)).toEqual({ error: 'no stored simulation of tuya-outage' });
  });
});

describe('GET /api/simulations/:scenario/events', () => {
  it.each(IDS)('%s: the whole trail as the simulator recorded it, in order', async (id) => {
    expect(await eventsOf(id)).toEqual({ scenario: id, timeZone: sim(id).timeZone, events: sim(id).events, total: sim(id).events.length });
  });

  /** Each filter means what the same option of npm run audit means (filterEvents). */
  const cases: [string, () => string, () => AuditFilter][] = [
    ['recovery=true', () => 'recovery=true', () => ({ recovery: true })],
    ['a type prefix', () => 'types=wave', () => ({ types: ['wave'] })],
    ['several types, spaces around commas', () => `types=${encodeURIComponent('wave.sent, sequence ,connection')}`, () => ({ types: ['wave.sent', 'sequence', 'connection'] })],
    ['a device', () => 'device=timer-1', () => ({ device: 'timer-1' })],
    ['a zone', () => `zone=${encodeURIComponent('timer-1:1')}`, () => ({ zone: 'timer-1:1' })],
    ['the first 8 characters of a sequence', () => `sequence=${firstSequence('crash-mid-soak').slice(0, 8)}`, () => ({ sequence: firstSequence('crash-mid-soak').slice(0, 8) })],
    ['a whole sequence id', () => `sequence=${firstSequence('bhyve-long-outage')}`, () => ({ sequence: firstSequence('bhyve-long-outage') })],
    [
      'a window with a UTC offset',
      () => `since=${encodeURIComponent('2026-07-01T06:30-05:00')}&until=${encodeURIComponent('2026-07-01T08:00-05:00')}`,
      () => ({ since: new Date('2026-07-01T11:30:00Z'), until: new Date('2026-07-01T13:00:00Z') }),
    ],
    ['a window in UTC', () => 'since=2026-07-01T12:00:00.000Z', () => ({ since: new Date('2026-07-01T12:00:00Z') })],
    [
      'everything at once',
      () => `recovery=true&types=wave,connection&device=timer-1&since=2026-07-01T11:00Z&until=2026-07-01T16:00Z`,
      () => ({ recovery: true, types: ['wave', 'connection'], device: 'timer-1', since: new Date('2026-07-01T11:00Z'), until: new Date('2026-07-01T16:00Z') }),
    ],
  ];

  it.each(cases)('%s: the same events as npm run audit picks', async (_name, query, filter) => {
    let matched = 0;
    for (const id of IDS) {
      const expected = filterEvents(sim(id).events, filter());
      const body = await eventsOf(id, `?${query()}`);
      expect(body.events).toEqual(expected);
      expect(body.total).toBe(sim(id).events.length);
      matched += expected.length;
    }
    // Not vacuous: the filter picks something, and not everything.
    expect(matched).toBeGreaterThan(0);
    expect(matched).toBeLessThan(IDS.reduce((n, id) => n + sim(id).events.length, 0));
  });

  it('recovery=false is the same as no recovery filter', async () => {
    expect((await eventsOf('bhyve-long-outage', '?recovery=false')).events).toEqual(sim('bhyve-long-outage').events);
  });

  it('nothing matching is an empty list, not an error', async () => {
    expect((await eventsOf('normal-watering', '?recovery=true')).events).toEqual([]);
    expect((await eventsOf('crash-mid-soak', '?device=no-such-device')).events).toEqual([]);
  });

  it('a relative time counts back from now, which is after the simulated day: nothing in the last 24 h, all in 60 days', async () => {
    expect((await eventsOf('crash-mid-soak', '?since=24h')).events).toEqual([]);
    expect((await eventsOf('crash-mid-soak', '?since=60d')).events).toEqual(sim('crash-mid-soak').events);
  });

  it('a sequence prefix matches case-sensitively, as npm run audit does (SQL LIKE alone would not)', async () => {
    const upper = firstSequence('crash-mid-soak').toUpperCase();
    expect((await eventsOf('crash-mid-soak', `?sequence=${upper}`)).events).toEqual(filterEvents(sim('crash-mid-soak').events, { sequence: upper }));
  });
});

describe('GET /api/simulations/:scenario/summary', () => {
  it.each(IDS)('%s: outages and the fate of every sequence, from the whole trail', async (id) => {
    expect(await read<SummaryResponse>(await get(`/api/simulations/${id}/summary`))).toEqual({
      scenario: id,
      timeZone: sim(id).timeZone,
      summary: summarize(sim(id).events),
    });
  });

  it('within a window: from every event in it', async () => {
    const window = { since: new Date('2026-07-01T11:00Z'), until: new Date('2026-07-01T13:00Z') };
    const body = await read<SummaryResponse>(await get('/api/simulations/bhyve-long-outage/summary?since=2026-07-01T11:00Z&until=2026-07-01T13:00Z'));
    expect(body.summary).toEqual(summarize(filterEvents(sim('bhyve-long-outage').events, window)));
  });

  it('shows the outcome of a sequence that npm run audit -- --summary --recovery would hide', async () => {
    const { summary } = await read<SummaryResponse>(await get('/api/simulations/crash-mid-soak/summary'));
    expect(summary.sequences).toEqual([expect.objectContaining({ status: 'completed', resumed: true })]);
    expect(summary.uncleanShutdowns).toBe(1);

    const { summary: outage } = await read<SummaryResponse>(await get('/api/simulations/bhyve-long-outage/summary'));
    expect(outage.outages.length).toBeGreaterThan(0);
    expect(outage.sequences.map((s) => s.status)).toContain('abandoned');
  });
});

describe('GET /api/simulations/:scenario/notifications', () => {
  it.each(IDS)('%s: the messages it would have sent, in order, as Telegram HTML text', async (id) => {
    expect(await read<NotificationsResponse>(await get(`/api/simulations/${id}/notifications`))).toEqual({
      scenario: id,
      timeZone: sim(id).timeZone,
      notifications: sim(id).notifications,
    });
  });
});

describe('the typed client (hono/client), as the web app will use it', () => {
  const client = hc<Api>('http://localhost', { fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init) });

  it('lists, and reads a filtered trail with typed parameters and results', async () => {
    const list = await client.api.simulations.$get({ query: {} });
    expect(list.status).toBe(200);
    if (list.status !== 200) return;
    expect((await list.json()).simulations.map((s) => s.scenario)).toEqual([...IDS, RETIRED]);

    const res = await client.api.simulations[':scenario'].events.$get({ param: { scenario: 'bhyve-long-outage' }, query: { recovery: 'true' } });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const body = await res.json();
    expect(body.events.map((e) => e.type)).toEqual(filterEvents(sim('bhyve-long-outage').events, { recovery: true }).map((e) => e.type));
  });

  it('tells a missing simulation apart by its status', async () => {
    const res = await client.api.simulations[':scenario'].$get({ param: { scenario: 'not-stored' }, query: {} });
    expect(res.status).toBe(404);
    if (res.status === 404) expect(await res.json()).toEqual({ error: 'no stored simulation of not-stored' });
  });
});
