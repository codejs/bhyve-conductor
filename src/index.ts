/**
 * Soil-moisture driven watering: polls the Tuya soil sensors and starts a supplemental B-hyve run
 * for any zone that's too dry.
 *   pnpm start                  run continuously
 *   pnpm dev -- --dry-run       log decisions without sending commands
 *   pnpm conductor:check        one dry-run cycle, then exit (good for checking the config)
 */
import { parseArgs } from 'node:util';
import { BhyveClient } from './bhyve/client.ts';
import { loadConductorConfig } from './conductor/config.ts';
import { FileHistoryStore } from './conductor/history.ts';
import { Monitor } from './conductor/monitor.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { TuyaSoilSource } from './sensors/tuya-soil.ts';
import { TuyaClient } from './tuya/client.ts';

/** How long to keep the socket open after a one-shot command so it is flushed before closing. */
const SEND_GRACE_MS = 3_000;

const main = async (): Promise<void> => {
  const { values: args } = parseArgs({
    options: { once: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } },
  });

  const env = loadConfig([
    'BHYVE_EMAIL',
    'BHYVE_PASSWORD',
    'TUYA_CLIENT_ID',
    'TUYA_CLIENT_SECRET',
    'TUYA_BASE_URL',
    'TUYA_MOISTURE_CODE',
    'CONDUCTOR_CONFIG',
    'CONDUCTOR_STATE',
  ]);
  const config = await loadConductorConfig(env.CONDUCTOR_CONFIG);
  if (args['dry-run']) config.dryRun = true;

  const tuya = new TuyaClient({ clientId: env.TUYA_CLIENT_ID, clientSecret: env.TUYA_CLIENT_SECRET, baseUrl: env.TUYA_BASE_URL });
  const source = new TuyaSoilSource(tuya, {
    sensorIds: [...new Set(config.zones.flatMap((z) => z.sensorIds))],
    moistureCode: env.TUYA_MOISTURE_CODE,
  });
  const bhyve = new BhyveClient({ email: env.BHYVE_EMAIL, password: env.BHYVE_PASSWORD });
  const store = new FileHistoryStore(env.CONDUCTOR_STATE);
  const monitor = new Monitor({ config, source, bhyve, history: await store.load(), store });

  if (args.once) {
    const result = await monitor.runCycle();
    if (result.sent.length > 0 && !config.dryRun) await new Promise((r) => setTimeout(r, SEND_GRACE_MS));
    bhyve.close();
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }

  monitor.start();
  const shutdown = (signal: string) => {
    log.info(`${signal} received; stopping`);
    void monitor.stop().finally(() => bhyve.close());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
