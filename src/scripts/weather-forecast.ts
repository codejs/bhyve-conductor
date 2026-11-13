/**
 * Shows the inputs of the forecast-based water budget, so you can check them against reality:
 * the resolved LOCATION, the daily ET₀ / rain forecast, and the upcoming runs read from your B-hyve
 * programs (compare these with the B-hyve app).
 * Usage: npm run weather:forecast -- [--hours 72]
 */
import { parseArgs } from 'node:util';
import { BhyveClient } from '../bhyve/client.ts';
import { upcomingRuns } from '../bhyve/schedule.ts';
import { loadConfig } from '../config.ts';
import { localParts } from '../time.ts';
import { parseLocation, resolveLocation } from '../weather/location.ts';
import { geocodeUS, OpenMeteoWeather } from '../weather/open-meteo.ts';

const { values } = parseArgs({ options: { hours: { type: 'string', default: '72' } } });
const hours = Number(values.hours);
const env = loadConfig(['LOCATION', 'BHYVE_EMAIL', 'BHYVE_PASSWORD']);
if (!env.LOCATION) {
  console.error('Set LOCATION in .env ("lat,lon", a US ZIP code, or "City, ST").');
  process.exit(1);
}

const point = await resolveLocation(parseLocation(env.LOCATION), geocodeUS);
const now = new Date();
const forecast = await new OpenMeteoWeather(point).getForecast(now, hours);
const tz = forecast.timeZone;
console.log(`${point.name ?? env.LOCATION}  (${point.latitude}, ${point.longitude})  time zone ${tz}\n`);

const day = (d: Date) => {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
const daily = new Map<string, { et0: number; rain: number; expected: number }>();
for (const h of forecast.hours) {
  const key = day(new Date(h.end.getTime() - 1));
  const t = daily.get(key) ?? { et0: 0, rain: 0, expected: 0 };
  t.et0 += h.et0Mm;
  t.rain += h.precipMm;
  t.expected += h.precipMm * ((h.precipProbabilityPct ?? 100) / 100);
  daily.set(key, t);
}
const inch = (mm: number) => `${(mm / 25.4).toFixed(2)}in`.padStart(7);
console.log('Day (partial days are only the hours ahead)   ET₀     rain  rain×chance');
for (const [d, t] of daily) console.log(`${d}                                 ${inch(t.et0)}  ${inch(t.rain)}  ${inch(t.expected)}`);

const bhyve = new BhyveClient({ email: env.BHYVE_EMAIL, password: env.BHYVE_PASSWORD });
const [devices, programs] = await Promise.all([bhyve.getDevices(), bhyve.getPrograms()]);
const { runs, warnings } = upcomingRuns(programs, devices, now, new Date(now.getTime() + hours * 3_600_000), tz);
const names = new Map(devices.map((d) => [d.id, d.name]));
console.log(`\nScheduled B-hyve runs in the next ${hours}h (local time):`);
if (runs.length === 0) console.log('  none');
for (const r of runs) {
  const p = localParts(r.start, tz);
  const when = `${day(r.start)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  console.log(`  ${when}  ${names.get(r.deviceId) ?? r.deviceId} station ${r.station}  ${r.minutes} min  (${r.program})`);
}
for (const w of warnings) console.log(`  ! ${w}`);
