/**
 * Lists Tuya devices linked to your cloud project, with their current data points and scales.
 * Use it to find the soil sensors' IDs and the moisture data-point code.
 * Usage: pnpm tuya:devices [--json]
 */
import { loadConfig } from '../config.ts';
import { scaleOf, TuyaClient } from '../tuya/client.ts';

const env = loadConfig(['TUYA_CLIENT_ID', 'TUYA_CLIENT_SECRET', 'TUYA_BASE_URL']);
const tuya = new TuyaClient({
  clientId: env.TUYA_CLIENT_ID,
  clientSecret: env.TUYA_CLIENT_SECRET,
  baseUrl: env.TUYA_BASE_URL,
});

const devices = await tuya.listDevices();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(devices, null, 2));
  process.exit(0);
}

if (devices.length === 0) {
  console.log('No devices. Link your Smart Life / MOES app account to the cloud project (Devices > Link App Account).');
}

for (const d of devices) {
  const via = d.gateway_id ? `  via gateway ${d.gateway_id}` : '';
  console.log(`\n${d.name}  [${d.category ?? '?'} / ${d.product_name ?? d.model ?? '?'}]  id=${d.id}  online=${d.online}${via}`);
  const spec = await tuya.getSpecification(d.id).catch(() => undefined);
  for (const dp of d.status ?? []) {
    const scale = spec ? scaleOf(spec, dp.code) : 0;
    const real = typeof dp.value === 'number' && scale ? `  (= ${dp.value / 10 ** scale})` : '';
    console.log(`  ${dp.code}: ${JSON.stringify(dp.value)}${real}`);
  }
}
