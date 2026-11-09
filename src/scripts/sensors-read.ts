/** Reads the configured soil sensors once. Usage: pnpm sensors:read */
import { loadConfig } from '../config.ts';
import { TuyaSoilSource } from '../sensors/tuya-soil.ts';
import { TuyaClient } from '../tuya/client.ts';

const env = loadConfig([
  'TUYA_CLIENT_ID',
  'TUYA_CLIENT_SECRET',
  'TUYA_BASE_URL',
  'TUYA_SOIL_SENSOR_IDS',
  'TUYA_MOISTURE_CODE',
]);

if (env.TUYA_SOIL_SENSOR_IDS.length === 0) {
  console.error('Set TUYA_SOIL_SENSOR_IDS in .env (find IDs with `pnpm tuya:devices`).');
  process.exit(1);
}

const tuya = new TuyaClient({
  clientId: env.TUYA_CLIENT_ID,
  clientSecret: env.TUYA_CLIENT_SECRET,
  baseUrl: env.TUYA_BASE_URL,
});
const source = new TuyaSoilSource(tuya, {
  sensorIds: env.TUYA_SOIL_SENSOR_IDS,
  moistureCode: env.TUYA_MOISTURE_CODE,
});

for (const r of await source.read()) {
  const ageMin = Math.round((Date.now() - r.at.getTime()) / 60_000);
  console.log(
    `${r.sensorName.padEnd(24)} moisture=${r.moisturePct}%` +
      (r.temperatureC !== undefined ? `  temp=${r.temperatureC}°C` : '') +
      (r.batteryPct !== undefined ? `  battery=${r.batteryPct}%` : '') +
      `  online=${r.online}  updated ${ageMin} min ago`,
  );
}
