export interface GeoPoint {
  latitude: number;
  longitude: number;
  /** Human-readable place name, when known (for logs). */
  name?: string;
}

/** One forecast hour. Values are totals for the hour ending at `end`. */
export interface ForecastHour {
  end: Date;
  /** Reference evapotranspiration (FAO-56 ET₀): water a well-watered grass field loses, in mm. */
  et0Mm: number;
  /** Forecast precipitation, in mm. */
  precipMm: number;
  /** Chance of precipitation, 0–100, if the provider gives one. */
  precipProbabilityPct?: number;
}

export interface Forecast {
  location: GeoPoint;
  /** IANA time zone of the location (e.g. "America/Chicago"); B-hyve schedules are read in this zone. */
  timeZone: string;
  fetchedAt: Date;
  /** Consecutive hours, in order, starting at or after the time of the request. */
  hours: ForecastHour[];
}

/** Anything that can produce an hourly ET₀ + precipitation forecast (Open-Meteo, OpenWeather, ...). */
export interface WeatherProvider {
  /** Forecast covering at least the next `hours` hours from `from`. */
  getForecast(from: Date, hours: number): Promise<Forecast>;
}
