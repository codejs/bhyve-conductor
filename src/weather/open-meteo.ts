import { z } from 'zod';
import { log } from '../log.ts';
import { assertTimeZone } from '../time.ts';
import type { Forecast, ForecastHour, GeoPoint, WeatherProvider } from './types.ts';

/**
 * Open-Meteo (https://open-meteo.com): free, no API key, covers the US, and publishes FAO-56 reference
 * evapotranspiration (ET₀), which is what a lawn water budget needs. Free for non-commercial use.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HOUR_MS = 3_600_000;
/** Open-Meteo updates its models hourly at most; no point asking more often than this. */
const DEFAULT_CACHE_MS = 30 * 60_000;

const nullableNumbers = z.array(z.number().nullable());

const ForecastResponse = z.object({
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().refine((tz) => {
    try {
      assertTimeZone(tz);
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone'),
  hourly_units: z.object({
    et0_fao_evapotranspiration: z.literal('mm'),
    precipitation: z.literal('mm'),
  }),
  hourly: z.object({
    /** Unix seconds (we request timeformat=unixtime). Each value covers the preceding hour. */
    time: z.array(z.number()),
    et0_fao_evapotranspiration: nullableNumbers,
    precipitation: nullableNumbers,
    precipitation_probability: nullableNumbers.optional(),
  }),
});

const GeocodingResponse = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country_code: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

export interface GeocodeResult extends GeoPoint {
  name: string;
  /** State, for US results. */
  admin1?: string;
  countryCode?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

const getJson = async (url: URL, timeoutMs: number): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err instanceof DOMException && err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : String(err);
    throw new Error(`Open-Meteo ${url.pathname} ${why}`, { cause: err });
  }
  if (!res.ok) {
    throw new Error(`Open-Meteo ${url.pathname} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
};

/** Place-name / ZIP search, restricted to the US. */
export const geocodeUS = async (query: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GeocodeResult[]> => {
  const url = new URL(GEOCODING_URL);
  url.search = new URLSearchParams({ name: query, count: '10', language: 'en', format: 'json', countryCode: 'US' }).toString();
  const parsed = GeocodingResponse.safeParse(await getJson(url, timeoutMs));
  if (!parsed.success) throw new Error(`Unexpected Open-Meteo geocoding response: ${parsed.error.message}`);
  return (parsed.data.results ?? [])
    .filter((r) => r.country_code === undefined || r.country_code === 'US')
    .map((r) => ({
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      ...(r.admin1 !== undefined ? { admin1: r.admin1 } : {}),
      ...(r.country_code !== undefined ? { countryCode: r.country_code } : {}),
    }));
};

export class OpenMeteoWeather implements WeatherProvider {
  readonly #location: GeoPoint;
  readonly #cacheMs: number;
  readonly #timeoutMs: number;
  #cache: { forecast: Forecast; days: number } | undefined;

  constructor(location: GeoPoint, opts: { cacheMs?: number; requestTimeoutMs?: number } = {}) {
    this.#location = location;
    this.#cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
    this.#timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getForecast(from: Date, hours: number): Promise<Forecast> {
    // +1 day because "today" is partly over; Open-Meteo allows up to 16.
    const days = Math.min(16, Math.ceil(hours / 24) + 1);
    const cached = this.#cache;
    if (cached && cached.days >= days && from.getTime() - cached.forecast.fetchedAt.getTime() < this.#cacheMs) {
      return sliceForecast(cached.forecast, from, hours);
    }

    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
      latitude: String(this.#location.latitude),
      longitude: String(this.#location.longitude),
      hourly: 'et0_fao_evapotranspiration,precipitation,precipitation_probability',
      forecast_days: String(days),
      timezone: 'auto',
      timeformat: 'unixtime',
      precipitation_unit: 'mm',
    }).toString();

    const parsed = ForecastResponse.safeParse(await getJson(url, this.#timeoutMs));
    if (!parsed.success) throw new Error(`Unexpected Open-Meteo forecast response: ${parsed.error.message}`);
    const { hourly, timezone } = parsed.data;

    const all: ForecastHour[] = [];
    hourly.time.forEach((t, i) => {
      const et0 = hourly.et0_fao_evapotranspiration[i];
      const precip = hourly.precipitation[i];
      // Models leave the far end of the range empty; those hours are just unknown, not zero.
      if (typeof et0 !== 'number' || typeof precip !== 'number') return;
      const pop = hourly.precipitation_probability?.[i];
      all.push({
        end: new Date(t * 1000),
        et0Mm: Math.max(0, et0),
        precipMm: Math.max(0, precip),
        ...(typeof pop === 'number' ? { precipProbabilityPct: Math.min(100, Math.max(0, pop)) } : {}),
      });
    });

    const forecast: Forecast = { location: this.#location, timeZone: timezone, fetchedAt: from, hours: all };
    this.#cache = { forecast, days };
    log.debug(`Open-Meteo forecast: ${all.length} hours for ${timezone}`);
    return sliceForecast(forecast, from, hours);
  }
}

/** Hours ending after `from`, up to `from + hours`. Throws if the forecast doesn't reach far enough. */
export const sliceForecast = (forecast: Forecast, from: Date, hours: number): Forecast => {
  const start = from.getTime();
  const end = start + hours * HOUR_MS;
  const slice = forecast.hours.filter((h) => h.end.getTime() > start && h.end.getTime() - HOUR_MS < end);
  const last = slice.at(-1);
  // Allow one hour of slack for the partial hour at the start.
  if (!last || last.end.getTime() < end - HOUR_MS) {
    const got = last ? Math.round((last.end.getTime() - start) / HOUR_MS) : 0;
    throw new Error(`Forecast only covers ${got} of the next ${hours} hours`);
  }
  return { ...forecast, hours: slice };
};
