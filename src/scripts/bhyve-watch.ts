/** Prints live B-hyve events (watering started/finished, mode changes, ...). Ctrl+C to quit. */
import { BhyveClient } from '../bhyve/client.ts';
import { loadConfig } from '../config.ts';
import { log } from '../log.ts';

const env = loadConfig(['BHYVE_EMAIL', 'BHYVE_PASSWORD']);
const client = new BhyveClient({ email: env.BHYVE_EMAIL, password: env.BHYVE_PASSWORD });

client.onEvent((e) => {
  if (e.event === 'pong') return;
  log.info(`event ${e.event}${e.device_id ? ` device=${e.device_id}` : ''}`, e);
});

await client.connect();
log.info('Watching B-hyve events. Trigger something from the B-hyve app to see it here.');

process.on('SIGINT', () => {
  client.close();
  process.exit(0);
});
