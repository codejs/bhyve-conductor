/**
 * Sends a manual command to a B-hyve device.
 *   npm run bhyve:cmd -- start <deviceId> <station> <minutes>
 *   npm run bhyve:cmd -- stop <deviceId>
 *   npm run bhyve:cmd -- delay <deviceId> <hours>      (0 cancels)
 */
import { BhyveClient } from '../bhyve/client.ts';
import { loadConfig } from '../config.ts';
import { log } from '../log.ts';

const [action, deviceId, a, b] = process.argv.slice(2);
const usage = 'Usage: bhyve:cmd start <deviceId> <station> <minutes> | stop <deviceId> | delay <deviceId> <hours>';

if (!action || !deviceId) {
  console.error(usage);
  process.exit(1);
}

const env = loadConfig(['BHYVE_EMAIL', 'BHYVE_PASSWORD']);
const client = new BhyveClient({ email: env.BHYVE_EMAIL, password: env.BHYVE_PASSWORD });

client.onEvent((e) => {
  if (e.device_id === deviceId) log.info(`event ${e.event}`, e);
});

switch (action) {
  case 'start':
    await client.startWatering(deviceId, [{ station: Number(a), runTime: Number(b) }]);
    break;
  case 'stop':
    await client.stopWatering(deviceId);
    break;
  case 'delay':
    await client.setRainDelay(deviceId, Number(a));
    break;
  default:
    console.error(usage);
    client.close();
    process.exit(1);
}

log.info(`Sent "${action}". Listening 10s for the device's response...`);
setTimeout(() => client.close(), 10_000);
