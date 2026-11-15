import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { WebServer, WebServerOptions } from './server.ts';

/** `npm run web`: serves the web API until SIGINT/SIGTERM. */

export interface WebCommandIo {
  out(text: string): void;
  err(text: string): void;
  /** CONDUCTOR_DB and WEB_* from the environment (config.ts); throws if they are invalid. Only asked for when needed. */
  env(): { CONDUCTOR_DB: string; WEB_HOST: string; WEB_PORT: number; WEB_ALLOWED_HOSTS: string[] };
  start(options: WebServerOptions): Promise<WebServer>;
  /** Resolves with the signal's name when it is time to stop. */
  stopSignal(): Promise<string>;
}

export const WEB_USAGE = `Usage: npm run web -- [options]
  --db <path>     the conductor database to read, read-only (default: CONDUCTOR_DB)
  --host <addr>   address to listen on (default: WEB_HOST, or 127.0.0.1: this machine only)
  --port <n>      port to listen on (default: WEB_PORT, or 8787)`;

const Overrides = z.strictObject({
  db: z.string().min(1, '--db needs a path').optional(),
  host: z
    .string()
    .regex(/^[A-Za-z0-9.:-]{1,253}$/, '--host: expected a host name or IP address, e.g. 127.0.0.1 or 0.0.0.0')
    .optional(),
  port: z
    .string()
    .regex(/^\d{1,5}$/, '--port: expected a number from 1 to 65535')
    .transform(Number)
    .pipe(z.number().int().min(1, '--port: expected a number from 1 to 65535').max(65_535, '--port: expected a number from 1 to 65535'))
    .optional(),
});

/** Runs the command; returns the exit code (0 stopped normally, 1 could not start, 2 usage). */
export const runWebCommand = async (argv: readonly string[], io: WebCommandIo): Promise<number> => {
  let values: { db?: string | undefined; host?: string | undefined; port?: string | undefined; help?: boolean | undefined };
  try {
    values = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: { db: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', default: false } },
    }).values;
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n${WEB_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(WEB_USAGE);
    return 0;
  }
  const { help: _help, ...rest } = values;
  const overrides = Overrides.safeParse(rest);
  if (!overrides.success) {
    io.err(`${overrides.error.issues.map((i) => i.message).join('\n')}\n${WEB_USAGE}`);
    return 2;
  }

  let server: WebServer;
  try {
    const env = io.env();
    const o = overrides.data;
    const dbPath = o.db ?? env.CONDUCTOR_DB;
    server = await io.start({ dbPath, host: o.host ?? env.WEB_HOST, port: o.port ?? env.WEB_PORT, allowedHosts: env.WEB_ALLOWED_HOSTS });
    io.out(`Web API on ${server.url}/api (reading ${dbPath}, read-only). Stop with Ctrl+C.`);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const signal = await io.stopSignal();
  io.out(`${signal} received; stopping the web server`);
  await server.close();
  return 0;
};
