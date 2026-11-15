import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { runWebCommand, WEB_USAGE, type WebCommandIo } from '../../http/command.ts';
import type { WebServer, WebServerOptions } from '../../http/server.ts';

/** `npm run web`: options over the environment, clear usage errors, and a clean stop on a signal. */

const ENV = { CONDUCTOR_DB: '.conductor.db', WEB_HOST: '127.0.0.1', WEB_PORT: 8787, WEB_ALLOWED_HOSTS: ['garden-pi.local'] };

interface Run {
  code: number;
  out: string[];
  err: string[];
  started: WebServerOptions[];
  /** What happened, in order. */
  steps: string[];
  envAsked: boolean;
}

const run = async (
  argv: string[],
  overrides: { env?: () => typeof ENV; start?: (o: WebServerOptions) => Promise<WebServer> } = {},
): Promise<Run> => {
  const r: Run = { code: -1, out: [], err: [], started: [], steps: [], envAsked: false };
  const io: WebCommandIo = {
    out: (t) => r.out.push(t),
    err: (t) => r.err.push(t),
    env: () => {
      r.envAsked = true;
      return (overrides.env ?? (() => ENV))();
    },
    start:
      overrides.start ??
      ((o) => {
        r.started.push(o);
        r.steps.push('start');
        return Promise.resolve({
          url: `http://${o.host}:${o.port}`,
          address: { address: o.host, family: 'IPv4', port: o.port },
          allowedHosts: [],
          server: {} as Server,
          close: () => {
            r.steps.push('close');
            return Promise.resolve();
          },
        });
      }),
    stopSignal: () => {
      r.steps.push('wait for a signal');
      return Promise.resolve('SIGTERM');
    },
  };
  r.code = await runWebCommand(argv, io);
  return r;
};

describe('npm run web', () => {
  it('serves with the environment’s settings until a signal, then closes the server', async () => {
    const r = await run([]);

    expect(r.code).toBe(0);
    expect(r.started).toEqual([{ dbPath: '.conductor.db', host: '127.0.0.1', port: 8787, allowedHosts: ['garden-pi.local'] }]);
    expect(r.steps).toEqual(['start', 'wait for a signal', 'close']);
    expect(r.out).toEqual([
      'Web API on http://127.0.0.1:8787/api (reading .conductor.db, read-only). Stop with Ctrl+C.',
      'SIGTERM received; stopping the web server',
    ]);
    expect(r.err).toEqual([]);
  });

  it('options win over the environment', async () => {
    const r = await run(['--db', 'other.db', '--host', '0.0.0.0', '--port', '9000']);
    expect(r.started).toEqual([{ dbPath: 'other.db', host: '0.0.0.0', port: 9000, allowedHosts: ['garden-pi.local'] }]);
  });

  it('--help shows the usage without reading the environment', async () => {
    const r = await run(['--help']);
    expect(r).toMatchObject({ code: 0, out: [WEB_USAGE], started: [], envAsked: false });
  });

  it.each([
    [['--verbose'], "Unknown option '--verbose'"],
    [['serve'], "Unexpected argument 'serve'"],
    [['--port'], "Option '--port <value>' argument missing"],
    [['--port', '0'], '--port: expected a number from 1 to 65535'],
    [['--port', '65536'], '--port: expected a number from 1 to 65535'],
    [['--port', '80x'], '--port: expected a number from 1 to 65535'],
    [['--port', '-1'], "Option '--port' argument is ambiguous"],
    [['--port=-1'], '--port: expected a number from 1 to 65535'],
    [['--port', '1e3'], '--port: expected a number from 1 to 65535'],
    [['--host', 'evil host'], '--host: expected a host name or IP address'],
    [['--host', 'a/b'], '--host: expected a host name or IP address'],
    [['--host', ''], '--host: expected a host name or IP address'],
    [['--db', ''], '--db needs a path'],
  ])('%j is a usage error (2) that starts nothing', async (argv, message) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain(message);
    expect(r.err.join('\n')).toContain(WEB_USAGE);
    expect(r.started).toEqual([]);
  });

  it('an invalid environment is an error (1) that starts nothing', async () => {
    const r = await run([], {
      env: () => {
        throw new Error('Invalid environment (see .env.example):\n  - WEB_PORT: Too big');
      },
    });
    expect(r).toMatchObject({ code: 1, started: [], err: ['Invalid environment (see .env.example):\n  - WEB_PORT: Too big'] });
  });

  it('a server that can’t start is an error (1), and nothing waits for a signal', async () => {
    const r = await run([], { start: () => Promise.reject(new Error('Could not listen on 127.0.0.1:8787: EADDRINUSE')) });
    expect(r).toMatchObject({ code: 1, out: [], err: ['Could not listen on 127.0.0.1:8787: EADDRINUSE'] });
    expect(r.steps).toEqual([]);
  });
});
