import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/database.ts';
import type { SimulationListResponse } from '../../http/contract.ts';
import { LOOPBACK_HOSTS } from '../../http/hosts.ts';
import { SERVER_LIMITS, startWebServer, type WebServer } from '../../http/server.ts';
import { log } from '../../log.ts';
import type { SimResult } from '../../sim/runner.ts';
import { storeSimulation } from '../../sim/store.ts';
import { pick, renamed, runScenarios } from '../utils/simulations.ts';

/**
 * The web server over real sockets: it reads the database without changing it (next to a running
 * conductor), checks the Host header as it arrives on the wire, and starts, fails and stops cleanly.
 */

const STORED_AT = new Date('2026-08-01T15:00:00.000Z');
const ID = 'crash-mid-soak';

let result: SimResult;
let dir: string;
let dbPath: string;
const running: WebServer[] = [];

beforeAll(async () => {
  result = pick(await runScenarios([ID]), ID);
  dir = await mkdtemp(join(tmpdir(), 'web-server-'));
  dbPath = join(dir, 'conductor.db');
  const db = openDatabase(dbPath);
  await storeSimulation(db, result, STORED_AT);
  await db.close();
}, 60_000);

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const start = async (options: Partial<Parameters<typeof startWebServer>[0]> = {}): Promise<WebServer> => {
  const server = await startWebServer({ dbPath, host: '127.0.0.1', port: 0, ...options });
  running.push(server);
  return server;
};

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

/** Sends exactly these bytes and returns the status line (or what happened instead). */
const rawStatus = (port: number, text: string, host = '127.0.0.1'): Promise<string> =>
  new Promise((resolve) => {
    let out = '';
    const socket = connect(port, host, () => socket.write(text));
    const done = () => resolve(out.split('\r\n')[0] || '(connection closed without an answer)');
    socket.on('data', (d: Buffer) => (out += d.toString('latin1')));
    socket.on('end', done);
    socket.on('error', done);
    socket.setTimeout(3_000, () => {
      socket.destroy();
      done();
    });
  });

/** A request with a Host header of our choosing (fetch won't send one). */
const withHost = (port: number, host: string, path = '/api/simulations'): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host }, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

describe('serving', () => {
  it('answers on this machine only by default, at the URL it reports', async () => {
    const server = await start();
    expect(server.url).toBe(`http://127.0.0.1:${server.address.port}`);
    expect(server.address.address).toBe('127.0.0.1');
    expect(server.allowedHosts).toEqual([...LOOPBACK_HOSTS]);

    const res = await fetch(`${server.url}/api/simulations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SimulationListResponse;
    expect(body.simulations.map((s) => s.scenario)).toEqual([ID]);
  });

  it('over IPv6 loopback too', async () => {
    const server = await start({ host: '::1' });
    expect(server.url).toBe(`http://[::1]:${server.address.port}`);
    expect((await fetch(`${server.url}/api/simulations`)).status).toBe(200);
  });

  it('sets short timeouts, so slow clients can’t hold sockets', async () => {
    const { server } = await start();
    expect(server.headersTimeout).toBe(SERVER_LIMITS.headersTimeoutMs);
    expect(server.requestTimeout).toBe(SERVER_LIMITS.requestTimeoutMs);
    expect(server.keepAliveTimeout).toBe(SERVER_LIMITS.keepAliveTimeoutMs);
  });
});

describe('the database', () => {
  it('is only read: the file is byte for byte the same after serving', async () => {
    const before = await sha256(dbPath);
    const server = await start();
    for (const path of ['', `/${ID}`, `/${ID}/events?recovery=true`, `/${ID}/summary`, `/${ID}/notifications`]) {
      expect((await fetch(`${server.url}/api/simulations${path}`)).status).toBe(200);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await fetch(`${server.url}/api/simulations`, { method, body: '{}' })).status).toBe(405);
    }
    await server.close();
    expect(await sha256(dbPath)).toBe(before);
  });

  it('can be written by the conductor meanwhile, and the API shows what it wrote', async () => {
    const server = await start();
    const writer = openDatabase(dbPath);
    try {
      await storeSimulation(writer, renamed(result, 'written-meanwhile'), STORED_AT);
    } finally {
      await writer.close();
    }
    const body = (await (await fetch(`${server.url}/api/simulations`)).json()) as SimulationListResponse;
    expect(body.simulations.map((s) => s.scenario)).toEqual([ID, 'written-meanwhile']);

    const cleanup = openDatabase(dbPath);
    await cleanup.prisma.simulationRun.deleteMany({ where: { scenario: 'written-meanwhile' } });
    await cleanup.close();
  });

  it('must exist: the server does not start, and creates no file', async () => {
    const missing = join(dir, 'missing.db');
    await expect(start({ dbPath: missing })).rejects.toThrow(/does not exist yet/);
    expect(existsSync(missing)).toBe(false);
  });

  it('must be a conductor database', async () => {
    const other = join(dir, 'other.db');
    const foreign = new DatabaseSync(other);
    foreign.exec('CREATE TABLE secrets (v TEXT)');
    foreign.close();
    await expect(start({ dbPath: other })).rejects.toThrow(/is not a bhyve-conductor database/);
  });
});

describe('on the wire', () => {
  let server: WebServer;
  beforeAll(async () => {
    server = await startWebServer({ dbPath, host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  it('refuses a Host it doesn’t answer to (DNS rebinding) with 403, and answers its own', async () => {
    const port = server.address.port;
    expect(await withHost(port, `rebind.evil.example:${port}`)).toEqual({ status: 403, body: JSON.stringify({ error: 'host not allowed' }) });
    expect((await withHost(port, `localhost.evil.example:${port}`)).status).toBe(403);
    expect((await withHost(port, `localhost:${port}`)).status).toBe(200);
    expect((await withHost(port, `127.0.0.1:${port}`)).status).toBe(200);
  });

  it.each([
    ['no Host (HTTP/1.0)', 'GET /api/simulations HTTP/1.0\r\n\r\n', '400'],
    ['no Host (HTTP/1.1)', 'GET /api/simulations HTTP/1.1\r\nConnection: close\r\n\r\n', '400'],
    ['a user name in front of the host', 'GET /api/simulations HTTP/1.1\r\nHost: localhost@evil.example\r\nConnection: close\r\n\r\n', '400'],
    ['a path in the Host', 'GET /api/simulations HTTP/1.1\r\nHost: localhost/evil\r\nConnection: close\r\n\r\n', '400'],
    ['an absolute URL naming another host', 'GET http://evil.example/api/simulations HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', '403'],
    ['a second Host after a bad one (the first counts)', 'GET /api/simulations HTTP/1.1\r\nHost: evil.example\r\nHost: localhost\r\nConnection: close\r\n\r\n', '403'],
    ['TRACE', 'TRACE /api/simulations HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', '405'],
    ['oversized headers', `GET /api/simulations HTTP/1.1\r\nHost: localhost\r\nX-Big: ${'a'.repeat(20_000)}\r\nConnection: close\r\n\r\n`, '431'],
  ])('%s → %s', async (_what, text, status) => {
    expect(await rawStatus(server.address.port, text)).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
  });

  it('CONNECT gets no tunnel: the connection is closed', async () => {
    expect(await rawStatus(server.address.port, 'CONNECT localhost:22 HTTP/1.1\r\nHost: localhost\r\n\r\n')).toBe('(connection closed without an answer)');
  });

  it('an absolute URL naming its own host is fine', async () => {
    expect(await rawStatus(server.address.port, 'GET http://localhost/api/simulations HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 200 /,
    );
  });
});

describe('listening elsewhere', () => {
  it('on every interface: warns that there is no login, names the hosts it answers to, and answers only those', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const server = await start({ host: '0.0.0.0', allowedHosts: ['garden-pi.local'] });

    expect(server.url).toBe(`http://localhost:${server.address.port}`);
    expect(server.allowedHosts).toEqual([...LOOPBACK_HOSTS, 'garden-pi.local']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/listens on 0\.0\.0\.0:\d+ and has no login: anyone who can reach it can read the audit trail/);
    expect(warn.mock.calls[0]?.[0]).toContain('localhost, 127.0.0.1, [::1], garden-pi.local (add names with WEB_ALLOWED_HOSTS)');

    const port = server.address.port;
    expect((await withHost(port, `garden-pi.local:${port}`)).status).toBe(200);
    expect((await withHost(port, `192.168.1.10:${port}`)).status).toBe(403);
  });

  it('on loopback: no warning', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await start({ host: '127.0.0.1' });
    await start({ host: 'localhost' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('starting and stopping', () => {
  it('a port in use is a clear error', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(start({ port })).rejects.toThrow(new RegExp(`^Could not listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('an error after it started is logged, and it keeps serving', async () => {
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
    const server = await start();
    server.server.emit('error', new Error('EMFILE: too many open files'));
    expect(logged).toHaveBeenCalledWith('Web server error', expect.objectContaining({ message: 'EMFILE: too many open files' }));
    expect((await fetch(`${server.url}/api/simulations`)).status).toBe(200);
  });

  it('close() also drops a client stuck halfway through its request, instead of waiting for its timeout', async () => {
    const server = await startWebServer({ dbPath, host: '127.0.0.1', port: 0 });
    const socket = connect(server.address.port, '127.0.0.1');
    const droppedByServer = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    // Headers never finished: the connection isn't idle, so server.close() alone would wait for it.
    socket.write('GET /api/simulations HTTP/1.1\r\nHost: localhost\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    const closed = await Promise.race([server.close().then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000))]);
    expect(closed).toBe('closed');
    await droppedByServer;
    expect(Date.now() - started).toBeLessThan(1_000);
    socket.destroy();
  });

  it('close() stops listening at once, drops a client that keeps its connection open, and can be called again', async () => {
    const server = await startWebServer({ dbPath, host: '127.0.0.1', port: 0 });
    // A keep-alive client: it has its answer and leaves the connection open.
    const socket = connect(server.address.port, '127.0.0.1');
    const firstAnswer = new Promise<string>((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString('latin1').split('\r\n')[0] ?? '')));
    const droppedByServer = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => {});
    socket.write('GET /api/simulations HTTP/1.1\r\nHost: localhost\r\n\r\n');
    expect(await firstAnswer).toMatch(/^HTTP\/1\.1 200 /);
    expect(socket.destroyed).toBe(false);

    const started = Date.now();
    await Promise.all([server.close(), server.close()]);
    await droppedByServer;
    await server.close();
    // Well before the keep-alive timeout would have ended the connection.
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(fetch(`${server.url}/api/simulations`)).rejects.toThrow();
  });
});
