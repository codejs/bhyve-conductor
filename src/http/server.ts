import { createAdaptorServer } from '@hono/node-server';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase, type ConductorDb } from '../db/database.ts';
import { log } from '../log.ts';
import { createApp } from './app.ts';
import { allowedHostsFor, isLoopback, isWildcard } from './hosts.ts';

/**
 * `npm run web`: the web API over the conductor's database, in its own process. The database is opened
 * read-only, like `npm run audit`, so it can run next to the service (WAL: readers never block it) and can't
 * change anything the service relies on.
 */

export interface WebServerOptions {
  /** The conductor's database (CONDUCTOR_DB). It must exist. */
  dbPath: string;
  /** Address to listen on (default in config.ts: 127.0.0.1, this machine only). */
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Extra host names browsers may use to reach it (WEB_ALLOWED_HOSTS), e.g. garden-pi.local. */
  allowedHosts?: readonly string[];
  now?: () => Date;
}

export interface WebServer {
  /** Where to point a browser. */
  url: string;
  address: AddressInfo;
  /** The host names it answers to. */
  allowedHosts: readonly string[];
  /** The Node server (its limits, for tests). */
  server: Server;
  /** Stops listening, drops open connections and closes the database. Safe to call more than once. */
  close(): Promise<void>;
}

/** Limits for a small read-only API: a client that trickles its request in doesn't hold a socket for long. */
export const SERVER_LIMITS = { headersTimeoutMs: 10_000, requestTimeoutMs: 30_000, keepAliveTimeoutMs: 5_000 } as const;

const urlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host);

export const startWebServer = async (options: WebServerOptions): Promise<WebServer> => {
  // Throws if the file doesn't exist yet or isn't a conductor database: better than an API that only fails.
  const db: ConductorDb = openDatabase(options.dbPath, { readOnly: true });
  const allowedHosts = allowedHostsFor(options.host, options.allowedHosts ?? []);
  const app = createApp({ db, allowedHosts, ...(options.now ? { now: options.now } : {}) });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  server.headersTimeout = SERVER_LIMITS.headersTimeoutMs;
  server.requestTimeout = SERVER_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeoutMs;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await db.close();
    throw new Error(`Could not listen on ${urlHost(options.host)}:${options.port}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  server.on('error', (err) => log.error('Web server error', err));

  const address = server.address() as AddressInfo;
  const shownHost = isWildcard(options.host) ? 'localhost' : urlHost(options.host);
  if (!isLoopback(options.host)) {
    log.warn(
      `The web API listens on ${urlHost(options.host)}:${address.port} and has no login: anyone who can reach it can read ` +
        `the audit trail. It answers only to ${allowedHosts.join(', ')}${isWildcard(options.host) ? ' (add names with WEB_ALLOWED_HOSTS)' : ''}.`,
    );
  }

  let closing: Promise<void> | undefined;
  return {
    url: `http://${shownHost}:${address.port}`,
    address,
    allowedHosts,
    server,
    close: () =>
      (closing ??= (async () => {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await stopped;
        await db.close();
      })()),
  };
};
