/**
 * The web API (and, later, the web app) over the conductor's database, read-only. See docs/web.md.
 *
 *   npm run web                              http://127.0.0.1:8787/api, reading CONDUCTOR_DB
 *   npm run web -- --db other.db --port 9000
 *   WEB_HOST=0.0.0.0 WEB_ALLOWED_HOSTS=garden-pi.local npm run web    other machines too (no login!)
 *
 * It runs next to the conductor, in its own process: a problem here never affects watering.
 */
import { loadConfig } from '../config.ts';
import { runWebCommand } from '../http/command.ts';
import { startWebServer } from '../http/server.ts';

process.exitCode = await runWebCommand(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  env: () => loadConfig(['CONDUCTOR_DB', 'WEB_HOST', 'WEB_PORT', 'WEB_ALLOWED_HOSTS']),
  start: startWebServer,
  stopSignal: () =>
    new Promise((resolve) => {
      process.once('SIGINT', () => resolve('SIGINT'));
      process.once('SIGTERM', () => resolve('SIGTERM'));
    }),
});
