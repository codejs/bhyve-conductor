import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCall, hangingFetch, jsonResponse, mockFetch, type FetchMock } from '../utils/fetch.ts';
import { geocodeUS, OpenMeteoWeather, sliceForecast } from '../../weather/open-meteo.ts';
import type { Forecast } from '../../weather/types.ts';

const NOW = new Date('2026-07-01T12:00:00Z');
const HOUR_S = 3600;
const nowS = NOW.getTime() / 1000;

/** Open-Meteo-shaped response: hours ending at NOW−2h … NOW+(count−3)h. */
const forecastBody = (count = 100, overrides: Record<string, unknown> = {}) => {
  const time = Array.from({ length: count }, (_, i) => nowS + (i - 2) * HOUR_S);
  return {
    latitude: 30.27,
    longitude: -97.74,
    timezone: 'America/Chicago',
    hourly_units: { time: 'unixtime', et0_fao_evapotranspiration: 'mm', precipitation: 'mm', precipitation_probability: '%' },
    hourly: {
      time,
      et0_fao_evapotranspiration: time.map(() => 0.2),
      precipitation: time.map(() => 0),
      precipitation_probability: time.map(() => 10),
    },
    ...overrides,
  };
};

describe('OpenMeteoWeather', () => {
  let fetchMock: FetchMock;
  const weather = () => new OpenMeteoWeather({ latitude: 30.27, longitude: -97.74 });

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests hourly ET₀, precipitation and its probability in mm, unix time and local time zone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(forecastBody()));

    await weather().getForecast(NOW, 72);

    const url = new URL(fetchCall(fetchMock, 0).url);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '30.27',
      longitude: '-97.74',
      hourly: 'et0_fao_evapotranspiration,precipitation,precipitation_probability',
      forecast_days: '4',
      timezone: 'auto',
      timeformat: 'unixtime',
      precipitation_unit: 'mm',
    });
  });

  it('returns the hours of the window with the location time zone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(forecastBody()));

    const f = await weather().getForecast(NOW, 72);

    expect(f.timeZone).toBe('America/Chicago');
    expect(f.hours).toHaveLength(72);
    expect(f.hours[0]).toEqual({ end: new Date(NOW.getTime() + 3_600_000), et0Mm: 0.2, precipMm: 0, precipProbabilityPct: 10 });
    expect(f.hours.at(-1)?.end).toEqual(new Date(NOW.getTime() + 72 * 3_600_000));
  });

  it('asks for more days for a longer window (max 16)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(forecastBody(400)));

    await new OpenMeteoWeather({ latitude: 1, longitude: 2 }).getForecast(NOW, 120);
    expect(new URL(fetchCall(fetchMock, 0).url).searchParams.get('forecast_days')).toBe('6');
  });

  it('drops hours with missing values and keeps a missing probability optional', async () => {
    const body = forecastBody();
    body.hourly.et0_fao_evapotranspiration[90] = null as unknown as number;
    body.hourly.precipitation_probability[5] = null as unknown as number;
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    const f = await weather().getForecast(NOW, 72);

    expect(f.hours[2]).not.toHaveProperty('precipProbabilityPct');
    expect(f.hours).toHaveLength(72); // hour 90 is beyond the window anyway
  });

  it('clamps negative amounts and out-of-range probabilities', async () => {
    const body = forecastBody();
    body.hourly.precipitation[3] = -0.1; // index 3 is the first hour of the window
    body.hourly.precipitation_probability[3] = 130;
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    const f = await weather().getForecast(NOW, 72);

    expect(f.hours[0]).toMatchObject({ precipMm: 0, precipProbabilityPct: 100 });
  });

  it('fails if the forecast does not reach far enough', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(forecastBody(40)));

    await expect(weather().getForecast(NOW, 72)).rejects.toThrow('Forecast only covers 37 of the next 72 hours');
  });

  it.each(['precipitation', 'et0_fao_evapotranspiration'] as const)(
    'rejects %s in other units rather than mis-scaling it',
    async (field) => {
      const body = forecastBody();
      body.hourly_units[field] = 'inch';
      fetchMock.mockResolvedValueOnce(jsonResponse(body));

      await expect(weather().getForecast(NOW, 72)).rejects.toThrow('Unexpected Open-Meteo forecast response');
    },
  );

  it('rejects an unknown time zone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(forecastBody(100, { timezone: 'Nowhere/Land' })));

    await expect(weather().getForecast(NOW, 72)).rejects.toThrow('unknown time zone');
  });

  it('turns network failures into descriptive errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(weather().getForecast(NOW, 72)).rejects.toThrow('Open-Meteo /v1/forecast TypeError: fetch failed');
  });

  it('times out instead of hanging (a stuck server cannot stall the monitor)', async () => {
    fetchMock.mockImplementationOnce(hangingFetch);
    const quick = new OpenMeteoWeather({ latitude: 30.27, longitude: -97.74 }, { requestTimeoutMs: 50 });

    await expect(quick.getForecast(NOW, 72)).rejects.toThrow('Open-Meteo /v1/forecast timed out after 0.05s');
  });

  it('reports HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"reason":"bad lat"}', { status: 400 }));

    await expect(weather().getForecast(NOW, 72)).rejects.toThrow('Open-Meteo /v1/forecast failed: HTTP 400 {"reason":"bad lat"}');
  });

  describe('caching', () => {
    it('reuses a forecast for 30 minutes, sliced to the new start time', async () => {
      fetchMock.mockResolvedValue(jsonResponse(forecastBody()));
      const w = weather();

      await w.getForecast(NOW, 72);
      const later = await w.getForecast(new Date(NOW.getTime() + 29 * 60_000), 72);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(later.hours[0]?.end).toEqual(new Date(NOW.getTime() + 3_600_000));
    });

    it('fetches again after 30 minutes', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(forecastBody(200)));
      const w = weather();

      await w.getForecast(NOW, 72);
      await w.getForecast(new Date(NOW.getTime() + 30 * 60_000), 72);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetches again when a longer window is needed', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(forecastBody(200)));
      const w = weather();

      await w.getForecast(NOW, 24);
      await w.getForecast(NOW, 72);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache failures', async () => {
      fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 })).mockResolvedValueOnce(jsonResponse(forecastBody()));
      const w = weather();

      await expect(w.getForecast(NOW, 72)).rejects.toThrow('HTTP 503');
      await expect(w.getForecast(NOW, 72)).resolves.toMatchObject({ timeZone: 'America/Chicago' });
    });
  });
});

describe('sliceForecast', () => {
  const forecast: Forecast = {
    location: { latitude: 0, longitude: 0 },
    timeZone: 'UTC',
    fetchedAt: NOW,
    hours: Array.from({ length: 10 }, (_, i) => ({ end: new Date(NOW.getTime() + i * 3_600_000), et0Mm: i, precipMm: 0 })),
  };

  it('keeps hours ending after `from`, through the window', () => {
    const s = sliceForecast(forecast, NOW, 5);
    expect(s.hours.map((h) => h.et0Mm)).toEqual([1, 2, 3, 4, 5]);
  });

  it('includes the hour in progress', () => {
    const s = sliceForecast(forecast, new Date(NOW.getTime() + 30 * 60_000), 3);
    expect(s.hours.map((h) => h.et0Mm)).toEqual([1, 2, 3, 4]);
  });

  it('throws when the window runs past the data', () => {
    expect(() => sliceForecast(forecast, NOW, 12)).toThrow('Forecast only covers 9 of the next 12 hours');
  });
});

describe('geocodeUS', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  it('searches US places by name or ZIP and returns coordinates with the state', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { name: 'Austin', latitude: 30.27, longitude: -97.74, country_code: 'US', admin1: 'Texas' },
          { name: 'Austin', latitude: 43.67, longitude: -92.97, country_code: 'US', admin1: 'Minnesota' },
        ],
      }),
    );

    const results = await geocodeUS('Austin');

    const url = new URL(fetchCall(fetchMock, 0).url);
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(url.searchParams.get('name')).toBe('Austin');
    expect(url.searchParams.get('countryCode')).toBe('US');
    expect(results).toEqual([
      { name: 'Austin', latitude: 30.27, longitude: -97.74, countryCode: 'US', admin1: 'Texas' },
      { name: 'Austin', latitude: 43.67, longitude: -92.97, countryCode: 'US', admin1: 'Minnesota' },
    ]);
  });

  it('drops non-US results in case the filter is ignored', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35, country_code: 'FR' }] }),
    );

    await expect(geocodeUS('Paris')).resolves.toEqual([]);
  });

  it('returns nothing when Open-Meteo has no results field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ generationtime_ms: 0.5 }));

    await expect(geocodeUS('Nowhereville')).resolves.toEqual([]);
  });

  it('times out instead of hanging', async () => {
    fetchMock.mockImplementationOnce(hangingFetch);

    await expect(geocodeUS('Austin', 50)).rejects.toThrow('Open-Meteo /v1/search timed out after 0.05s');
  });

  it('rejects malformed responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{ name: 'X' }] }));

    await expect(geocodeUS('X')).rejects.toThrow('Unexpected Open-Meteo geocoding response');
  });
});
