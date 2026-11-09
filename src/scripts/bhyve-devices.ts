/** Lists B-hyve devices and zones. Usage: pnpm bhyve:devices [--json] */
import { BhyveClient } from '../bhyve/client.ts';
import { loadConfig } from '../config.ts';

const env = loadConfig(['BHYVE_EMAIL', 'BHYVE_PASSWORD']);
const client = new BhyveClient({ email: env.BHYVE_EMAIL, password: env.BHYVE_PASSWORD });

const devices = await client.getDevices();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(devices, null, 2));
} else {
  for (const d of devices) {
    console.log(`\n${d.name}  [${d.type}]  id=${d.id}  connected=${d.is_connected ?? '?'}`);
    if (d.battery?.percent !== undefined) console.log(`  battery: ${d.battery.percent}%`);
    if (d.status) {
      console.log(`  run_mode=${d.status.run_mode ?? '?'}  rain_delay=${d.status.rain_delay ?? 0}h`);
    }
    for (const z of d.zones ?? []) console.log(`  zone ${z.station}: ${z.name ?? '(unnamed)'}`);
  }
}
