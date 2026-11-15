import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../audit/types.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { createApp, type Api } from '../../http/app.ts';
import type { ErrorResponse, EventsResponse } from '../../http/contract.ts';
import { allowedHostsFor } from '../../http/hosts.ts';
import { log } from '../../log.ts';
import type { SimResult } from '../../sim/runner.ts';
import { storeSimulation } from '../../sim/store.ts';
import { pick, renamed, runScenarios } from '../utils/simulations.ts';

/**
 * The web API has no login and sits next to the garden's history, so it must: answer only to its own host
 * names (DNS rebinding), never change anything, refuse anything but well-formed parameters before touching
 * the database, never leak internals, and send headers that stop browsers from misusing its answers.
 */

const NOW = new Date('2026-08-02T12:00:00.000Z');
const STORED_AT = new Date('2026-08-01T15:00:00.000Z');
const ID = 'crash-mid-soak';

let result: SimResult;
let sequence: string;
let db: ConductorDb;
let app: Api;

beforeAll(async () => {
  result = pick(await runScenarios([ID]), ID);
  const started = result.events.find((e) => e.type === 'sequence.started')?.sequence;
  if (typeof started !== 'string') throw new Error('no sequence');
  sequence = started;
  db = openDatabase(':memory:');
  await storeSimulation(db, result, STORED_AT);
  app = createApp({ db, allowedHosts: allowedHostsFor('127.0.0.1', ['garden-pi.local']), now: () => NOW });
}, 60_000);

afterAll(async () => {
  await db.close();
});

const request = (path: string, init: RequestInit = {}, target: Api = app, host = 'localhost'): Promise<Response> =>
  Promise.resolve(target.request(`http://${host}${path}`, init));
const errorOf = async (res: Response, status: number): Promise<ErrorResponse> => {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  return (await res.json()) as ErrorResponse;
};

/** A database that fails the test if anything touches it. */
const untouchable = (): ConductorDb =>
  new Proxy({} as ConductorDb, {
    get(_target, prop) {
      throw new Error(`the database was touched (${String(prop)})`);
    },
  });

const ROUTES = [
  '/api/simulations',
  `/api/simulations/${ID}`,
  `/api/simulations/${ID}/events`,
  `/api/simulations/${ID}/summary`,
  `/api/simulations/${ID}/notifications`,
] as const;

/** Row counts of every table, to show nothing was written. */
const snapshot = (target: ConductorDb): Record<string, number> => {
  const tables = target.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, (target.sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]));
};

// ------------------------------------------------------------------------------------------------
describe('parameter validation: refused with 400, saying which parameter and why', () => {
  const events = `/api/simulations/${ID}/events`;

  /** [what, path and query, the parameter named in the answer] */
  const bad: [string, string, string][] = [
    // The scenario in the path.
    ['upper-case scenario', '/api/simulations/Crash-Mid-Soak/events', 'scenario'],
    ['scenario starting with a dash', '/api/simulations/-crash/events', 'scenario'],
    ['scenario with an underscore', '/api/simulations/crash_mid_soak', 'scenario'],
    ['scenario too long', `/api/simulations/${'a'.repeat(65)}`, 'scenario'],
    ['scenario with a NUL byte', '/api/simulations/crash%00/events', 'scenario'],
    ['scenario with an encoded slash', '/api/simulations/..%2F..%2Fetc%2Fpasswd/events', 'scenario'],
    ['scenario with a quote', "/api/simulations/x'%20OR%20'1'='1/events", 'scenario'],
    ['non-ASCII scenario', '/api/simulations/caf%C3%A9', 'scenario'],
    ['malformed percent-encoding', '/api/simulations/%E0%A4%A/events', 'scenario'],
    // Times.
    ['a time it can’t read', `${events}?since=yesterday`, 'since'],
    ['an empty time', `${events}?since=`, 'since'],
    ['month 13', `${events}?since=2026-13-01`, 'since'],
    ['hour 25', `${events}?until=2026-07-01T25:00`, 'until'],
    ['exponent notation', `${events}?since=1e9d`, 'since'],
    ['a unit it doesn’t know', `${events}?since=24hours`, 'since'],
    ['a 7-digit duration', `${events}?since=9999999d`, 'since'],
    ['a raw + (read as a space) in an offset', `${events}?since=2026-07-01T06:30+02:00`, 'since'],
    ['February 31 (JavaScript would read March 3)', `${events}?since=2026-02-31`, 'since'],
    ['February 29 in a common year', `${events}?since=2026-02-29T10:00Z`, 'since'],
    ['April 31', `${events}?until=2026-04-31T00:00`, 'until'],
    ['day 0', `${events}?since=2026-07-00`, 'since'],
    ['hour 24 (JavaScript would read the next day)', `${events}?until=2026-07-01T24:00Z`, 'until'],
    ['minute 60', `${events}?since=2026-07-01T23:60Z`, 'since'],
    ['an offset beyond 24 h', `${events}?since=${encodeURIComponent('2026-07-01T06:30-25:00')}`, 'since'],
    ['since after until', `${events}?since=2026-07-02&until=2026-07-01`, 'since'],
    ['since after until on the summary', `/api/simulations/${ID}/summary?since=2026-07-02&until=2026-07-01`, 'since'],
    // Event types.
    ['empty types', `${events}?types=`, 'types'],
    ['only a comma', `${events}?types=,`, 'types'],
    ['upper-case type', `${events}?types=WAVE`, 'types'],
    ['type with SQL', `${events}?types=${encodeURIComponent("wave';DROP TABLE audit_event;--")}`, 'types'],
    ['three-part type', `${events}?types=a.b.c`, 'types'],
    ['a LIKE wildcard as type', `${events}?types=%25`, 'types'],
    ['too many types', `${events}?types=${Array.from({ length: 31 }, () => 'wave').join(',')}`, 'types'],
    // Device, zone, sequence.
    ['empty device', `${events}?device=`, 'device'],
    ['a LIKE wildcard as device', `${events}?device=%25`, 'device'],
    ['device with a space', `${events}?device=timer%201`, 'device'],
    ['device too long', `${events}?device=${'d'.repeat(129)}`, 'device'],
    ['zone without a station', `${events}?zone=timer-1`, 'zone'],
    ['zone with an empty station', `${events}?zone=timer-1:`, 'zone'],
    ['zone with a 4-digit station', `${events}?zone=timer-1:1234`, 'zone'],
    ['zone without a device', `${events}?zone=:1`, 'zone'],
    ['sequence %', `${events}?sequence=%25`, 'sequence'],
    ['sequence _', `${events}?sequence=_`, 'sequence'],
    ['sequence prefix plus %', `${events}?sequence=86da%25`, 'sequence'],
    ['sequence with SQL', `${events}?sequence=${encodeURIComponent("' OR 1=1 --")}`, 'sequence'],
    ['sequence too long', `${events}?sequence=${'a'.repeat(37)}`, 'sequence'],
    // Flags.
    ['recovery=yes', `${events}?recovery=yes`, 'recovery'],
    ['recovery=1', `${events}?recovery=1`, 'recovery'],
    ['recovery=TRUE', `${events}?recovery=TRUE`, 'recovery'],
    // Repeated, unknown, or not for this route.
    ['a repeated parameter', `${events}?recovery=true&recovery=false`, 'recovery'],
    ['an unknown parameter', `${events}?limit=5`, 'limit'],
    ['a CLI option the API leaves to the app', `${events}?tz=UTC`, 'tz'],
    ['a parameter on the list', '/api/simulations?scenario=crash-mid-soak', 'scenario'],
    ['a parameter on one simulation', `/api/simulations/${ID}?recovery=true`, 'recovery'],
    ['a filter on the summary (it always reads the whole window)', `/api/simulations/${ID}/summary?recovery=true`, 'recovery'],
    ['a bad time on the summary', `/api/simulations/${ID}/summary?until=tomorrow`, 'until'],
    ['a parameter on the notifications', `/api/simulations/${ID}/notifications?severity=critical`, 'severity'],
  ];

  it.each(bad)('%s', async (_what, path, parameter) => {
    const body = await errorOf(await request(path), 400);
    expect(body.error).toBe('invalid request');
    expect(body.issues?.map((i) => i.parameter)).toContain(parameter);
    for (const issue of body.issues ?? []) expect(issue.message).toEqual(expect.any(String));
  });

  it.each(bad)('%s: refused before the database is touched', async (_what, path) => {
    expect((await request(path, {}, createApp({ db: untouchable(), allowedHosts: ['localhost'] }))).status).toBe(400);
  });

  it('names every unknown parameter', async () => {
    const body = await errorOf(await request(`${events}?a=1&b=2&recovery=true`), 400);
    expect(body.issues).toEqual([
      { parameter: 'a', message: 'unknown parameter' },
      { parameter: 'b', message: 'unknown parameter' },
    ]);
  });

  it('keeps what it quotes back short', async () => {
    const body = await errorOf(await request(`${events}?${'k'.repeat(5_000)}=1`), 400);
    for (const issue of body.issues ?? []) {
      expect(issue.parameter.length).toBeLessThanOrEqual(200);
      expect(issue.message.length).toBeLessThanOrEqual(200);
    }
  });

  it.each([
    ['a + offset, encoded', `since=${encodeURIComponent('2026-07-01T13:30+02:00')}`],
    ['a date only', 'since=2026-07-01'],
    ['February 29 in a leap year', 'since=2028-02-29'],
    ['the last second of a day', 'until=2026-12-31T23:59:59.999Z'],
    ['since equal to until', 'since=2026-07-01T12:00Z&until=2026-07-01T12:00Z'],
    ['a time without seconds', 'since=2026-07-01T11:30Z'],
    ['milliseconds', 'since=2026-07-01T11:30:00.000Z'],
    ['an offset without a colon', 'since=2026-07-01T06:30-0500'],
    ['minutes', 'since=90m'],
    ['min', 'since=90min'],
    ['fractional hours', 'since=1.5h'],
    ['weeks', 'since=2w'],
    ['a 6-digit duration (the longest)', 'since=999999d'],
    ['one whole UUID', `sequence=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`],
    ['30 types (the most)', `types=${Array.from({ length: 30 }, () => 'wave').join(',')}`],
  ])('accepts %s', async (_what, query) => {
    expect((await request(`${events}?${query}`)).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------
describe('wildcards and case never widen a match', () => {
  it('the real prefix finds its sequence; LIKE wildcards are refused rather than matching everything', async () => {
    const found = (await (await request(`/api/simulations/${ID}/events?sequence=${sequence.slice(0, 8)}`)).json()) as EventsResponse;
    expect(found.events.length).toBeGreaterThan(0);
    expect(found.events.every((e) => e.sequence === sequence)).toBe(true);

    for (const wildcard of ['%25', '_', `${sequence.slice(0, 4)}%25`, `${sequence.slice(0, 4)}_`]) {
      expect((await request(`/api/simulations/${ID}/events?sequence=${wildcard}`)).status).toBe(400);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('Host header (DNS rebinding)', () => {
  it.each([
    ['an attacker’s name re-pointed at this machine', 'rebind.evil.example:8787'],
    ['a name that starts like localhost', 'localhost.evil.example'],
    ['an address it was not told about', '192.168.1.10:8787'],
    ['the wildcard address', '0.0.0.0:8787'],
  ])('refuses %s with 403, on every route', async (_what, host) => {
    for (const path of [...ROUTES, '/', '/api/nope']) {
      expect(await errorOf(await request(path, {}, app, host), 403)).toEqual({ error: 'host not allowed' });
    }
  });

  it.each(['localhost', 'localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787', 'garden-pi.local:8787'])('answers %s', async (host) => {
    expect((await request('/api/simulations', {}, app, host)).status).toBe(200);
  });

  it('checks the host first: nothing else runs, the database is not touched', async () => {
    const guarded = createApp({ db: untouchable(), allowedHosts: ['localhost'] });
    for (const path of ROUTES) expect((await request(path, {}, guarded, 'evil.example')).status).toBe(403);
    expect((await request(ROUTES[0], { method: 'DELETE' }, guarded, 'evil.example')).status).toBe(403);
    expect((await request('/api/simulations/BAD', {}, guarded, 'evil.example')).status).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------
describe('read-only', () => {
  const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

  // TRACE can't be built as a fetch Request; server.test.ts sends it over a socket.
  it.each([...WRITES, 'OPTIONS'])('%s is 405 (Allow: GET, HEAD) on every route and beyond', async (method) => {
    for (const path of [...ROUTES, '/', '/api/anything']) {
      const res = await request(path, { method });
      expect(await errorOf(res, 405)).toEqual({ error: 'method not allowed' });
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('a method is refused before the database is touched', async () => {
    const guarded = createApp({ db: untouchable(), allowedHosts: ['localhost'] });
    for (const method of WRITES) expect((await request(ROUTES[0], { method, body: '{}' }, guarded)).status).toBe(405);
  });

  it('nothing a client sends changes the database', async () => {
    const before = snapshot(db);
    for (const path of ROUTES) {
      for (const method of WRITES) {
        await request(path, { method, body: JSON.stringify({ scenario: 'x', events: [] }), headers: { 'content-type': 'application/json' } });
      }
      await request(path);
      await request(`${path}?since=1970-01-01&recovery=true`);
    }
    expect(snapshot(db)).toEqual(before);
  });

  it('HEAD answers like GET, without a body', async () => {
    const res = await request('/api/simulations', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).toBe('');
  });
});

// ------------------------------------------------------------------------------------------------
describe('cross-origin access', () => {
  it('no CORS: other sites’ pages can’t read the answers', async () => {
    const res = await request('/api/simulations', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('a preflight is refused', async () => {
    const res = await request('/api/simulations', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
describe('response headers, on every kind of answer', () => {
  const expectHardened = (res: Response): void => {
    const h = res.headers;
    expect(h.get('content-type')).toMatch(/^application\/json/);
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    expect(h.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(h.get('content-security-policy')).toContain("default-src 'none'");
    expect(h.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(h.get('cache-control')).toBe('no-store');
    expect(h.get('x-powered-by')).toBeNull();
    // Plain HTTP: HSTS is left to whatever terminates TLS, if anything.
    expect(h.get('strict-transport-security')).toBeNull();
  };

  it.each([
    ['200', () => request('/api/simulations'), 200],
    ['200 with data', () => request(`/api/simulations/${ID}/events`), 200],
    ['400', () => request(`/api/simulations/${ID}/events?bogus=1`), 400],
    ['403', () => request('/api/simulations', {}, app, 'evil.example'), 403],
    ['404 (unknown API path)', () => request('/api/nope'), 404],
    ['404 (outside the API)', () => request('/index.html'), 404],
    ['404 (not stored)', () => request('/api/simulations/tuya-outage'), 404],
    ['405', () => request('/api/simulations', { method: 'POST' }), 405],
  ] as const)('%s', async (_what, send, status) => {
    const res = await send();
    expect(res.status).toBe(status);
    expectHardened(res);
  });

  it('500', async () => {
    const broken = openDatabase(':memory:');
    await broken.close();
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const res = await request('/api/simulations', {}, createApp({ db: broken, allowedHosts: ['localhost'] }));
    expect(res.status).toBe(500);
    expectHardened(res);
  });
});

// ------------------------------------------------------------------------------------------------
describe('failures', () => {
  it('an internal error is a bare 500: no message, stack, path or SQL; the details go to the log', async () => {
    const broken = openDatabase(':memory:');
    await broken.close();
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
    const brokenApp = createApp({ db: broken, allowedHosts: ['localhost'] });

    for (const path of ROUTES) {
      const res = await request(path, {}, brokenApp);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: 'internal error' });
      expect(text).not.toMatch(/database|sqlite|prisma|select|at \w|\/src\/|node_modules/i);
    }
    expect(logged).toHaveBeenCalledTimes(ROUTES.length);
    expect(logged.mock.calls[0]?.[0]).toBe('Web API: GET /api/simulations failed');
    expect(logged.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it.each([
    '/api/../../etc/passwd',
    '/api/simulations/../../../etc/passwd',
    '/api/simulations/%2e%2e/%2e%2e/etc/passwd',
    '/..%2F..%2Fetc%2Fpasswd',
    '/api/simulations/crash-mid-soak/..%2F..%2F..%2Fetc%2Fpasswd',
  ])('path traversal %s reaches no file', async (path) => {
    const res = await request(path);
    expect([400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain('root:');
    expect(JSON.parse(text)).toHaveProperty('error');
  });

  it('a very long URL is refused cleanly', async () => {
    const res = await request(`/api/simulations/${ID}/events?types=${'a'.repeat(100_000)}`);
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------------------------------------------------
describe('stored data comes back as data', () => {
  it('markup, quotes and odd characters in events and notifications are returned exactly, as JSON that browsers won’t sniff as HTML', async () => {
    const nasty = `</script><script>alert(1)</script><img src=x onerror=alert(2)> "quoted" \\ \u2028\u2029 ✓`;
    const crafted: SimResult = renamed(result, 'crafted', nasty);
    const last = crafted.events.at(-1);
    if (!last) throw new Error('no events');
    // Event data is stored as JSON, so even a NUL survives. (Plain text columns such as the title can't hold
    // one: node:sqlite reads text only up to a NUL.)
    const noteEvent: AuditEvent = { ts: last.ts, type: 'simulation.note', note: `${nasty} \u0000 after NUL`, nested: { html: nasty } };
    crafted.events = [...crafted.events, noteEvent];
    crafted.notifications = crafted.notifications.map((n) => ({ ...n, text: `${n.text}${nasty}` }));

    const own = openDatabase(':memory:');
    try {
      await storeSimulation(own, crafted, STORED_AT);
      const ownApp = createApp({ db: own, allowedHosts: ['localhost'] });

      const evRes = await request('/api/simulations/crafted/events?types=simulation', {}, ownApp);
      expect(evRes.headers.get('content-type')).toMatch(/^application\/json/);
      expect(evRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(((await evRes.json()) as EventsResponse).events.at(-1)).toEqual(noteEvent);

      const one = (await (await request('/api/simulations/crafted', {}, ownApp)).json()) as { simulation: { title: string } };
      expect(one.simulation.title).toBe(nasty);

      const notes = (await (await request('/api/simulations/crafted/notifications', {}, ownApp)).json()) as { notifications: { text: string }[] };
      expect(notes.notifications.map((n) => n.text)).toEqual(crafted.notifications.map((n) => n.text));
    } finally {
      await own.close();
    }
  });
});
