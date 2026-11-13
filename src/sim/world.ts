import type { BhyveDevice, BhyveEvent, BhyveProgram, StationRun } from '../bhyve/types.ts';
import type { Clock } from '../clock.ts';
import type { BhyveControl } from '../conductor/monitor.ts';
import type { MoistureReading, MoistureSource } from '../sensors/types.ts';
import type { Forecast, ForecastHour, WeatherProvider } from '../weather/types.ts';

/**
 * A small simulated garden plus fake Tuya / B-hyve / Open-Meteo services, driven by a VirtualClock.
 * Scenarios change it (dry spells, storms, dead batteries, outages, a stuck valve...) and the real
 * conductor code reacts to it exactly as it would to the real services.
 */

export interface SimSensor {
  id: string;
  name: string;
  /** Zone (deviceId:station) whose water reaches this sensor. */
  zone: string;
  moisture: number;
  battery: number;
  online: boolean;
  /** When set, the sensor stopped reporting at this time (its last reading keeps that timestamp). */
  silentSince?: number;
}

export interface SimDevice {
  id: string;
  name: string;
  stations: number[];
  runMode: 'auto' | 'off';
  rainDelayHours: number;
  connected: boolean;
  battery?: number;
}

export type ServiceState = 'up' | 'down' | 'hang';

export interface Services {
  tuya: ServiceState;
  /** B-hyve REST (devices, programs, status). */
  bhyveRest: ServiceState;
  /** B-hyve WebSocket carrying watering commands. */
  bhyveSocket: ServiceState;
  weather: ServiceState;
}

export interface WorldOptions {
  /** Soil drying, % moisture per hour (simplification of evapotranspiration). */
  dryingPctPerHour: number;
  /** Moisture % added per minute of watering at a sensor. */
  wateringPctPerMinute: number;
  /** Reference ET₀ reported by the fake forecast, mm/hour. */
  et0MmPerHour: number;
}

interface Segment {
  zone: string;
  start: number;
  end: number;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export class SimWorld {
  readonly clock: Clock;
  readonly sensors = new Map<string, SimSensor>();
  readonly devices = new Map<string, SimDevice>();
  readonly services: Services = { tuya: 'up', bhyveRest: 'up', bhyveSocket: 'up', weather: 'up' };
  readonly options: WorldOptions;
  /** Device misbehaviour: the controller ignores commands (no ack, no water). */
  readonly ignoresCommands = new Set<string>();
  /** Stations whose valve is stuck shut: the controller runs, but no water arrives. */
  readonly stuckValves = new Set<string>();
  /** Rain the forecast announces: time → mm (and chance). */
  readonly forecastRain: { at: number; mm: number; chancePct: number }[] = [];
  programs: BhyveProgram[] = [];

  readonly #segments: Segment[] = [];
  readonly #listeners = new Set<(e: BhyveEvent) => void>();
  #lastUpdate: number;

  constructor(clock: Clock, options: Partial<WorldOptions> = {}) {
    this.clock = clock;
    this.options = { dryingPctPerHour: 0.4, wateringPctPerMinute: 0.42, et0MmPerHour: 0.25, ...options };
    this.#lastUpdate = clock.now().getTime();
  }

  // ---------- scenario controls ----------

  addSensor(s: Omit<SimSensor, 'online' | 'battery'> & Partial<Pick<SimSensor, 'online' | 'battery'>>): void {
    this.sensors.set(s.id, { online: true, battery: 90, ...s });
  }

  addDevice(d: Omit<SimDevice, 'runMode' | 'rainDelayHours' | 'connected'> & Partial<SimDevice>): void {
    this.devices.set(d.id, { runMode: 'auto', rainDelayHours: 0, connected: true, ...d });
  }

  sensor(id: string): SimSensor {
    const s = this.sensors.get(id);
    if (!s) throw new Error(`no sensor ${id}`);
    return s;
  }

  device(id: string): SimDevice {
    const d = this.devices.get(id);
    if (!d) throw new Error(`no device ${id}`);
    return d;
  }

  /** Rain falling now: adds moisture to every sensor. */
  rain(pct: number): void {
    this.update();
    for (const s of this.sensors.values()) s.moisture = Math.min(100, s.moisture + pct);
  }

  /** Is any station of the device running right now? */
  isWatering(deviceId: string): boolean {
    const now = this.clock.now().getTime();
    return this.#segments.some((s) => s.zone.startsWith(`${deviceId}:`) && s.start <= now && now < s.end);
  }

  /** Brings moisture up to date: drying over time, plus water from runs in progress. */
  update(): void {
    const now = this.clock.now().getTime();
    const from = this.#lastUpdate;
    if (now <= from) return;
    const hours = (now - from) / HOUR_MS;
    for (const s of this.sensors.values()) {
      s.moisture = Math.max(0, s.moisture - this.options.dryingPctPerHour * hours);
      for (const seg of this.#segments) {
        if (seg.zone !== s.zone || this.stuckValves.has(seg.zone)) continue;
        const overlap = Math.min(now, seg.end) - Math.max(from, seg.start);
        if (overlap > 0) s.moisture = Math.min(100, s.moisture + (overlap / MINUTE_MS) * this.options.wateringPctPerMinute);
      }
    }
    this.#lastUpdate = now;
  }

  // ---------- fake services ----------

  /** Fake Tuya soil sensors (like TuyaSoilSource). */
  readonly source: MoistureSource & { lastErrors: { sensorId: string; error: string }[] } = {
    id: 'sim-tuya',
    lastErrors: [],
    read: () => {
      this.update();
      if (this.services.tuya === 'hang') return new Promise<never>(() => {});
      if (this.services.tuya === 'down') {
        this.source.lastErrors = [...this.sensors.keys()].map((sensorId) => ({
          sensorId,
          error: 'Tuya GET /v1.0/token failed: code 500 internal error',
        }));
        return Promise.resolve([]);
      }
      this.source.lastErrors = [];
      const now = this.clock.now().getTime();
      return Promise.resolve(
        [...this.sensors.values()].map(
          (s): MoistureReading => ({
            sensorId: s.id,
            sensorName: s.name,
            moisturePct: Math.round(s.moisture * 10) / 10,
            batteryPct: s.battery,
            online: s.online,
            at: new Date(s.silentSince ?? now),
          }),
        ),
      );
    },
  };

  #deviceView(d: SimDevice): BhyveDevice {
    return {
      id: d.id,
      name: d.name,
      type: 'sprinkler_timer',
      is_connected: d.connected,
      zones: d.stations.map((station) => ({ station })),
      status: {
        run_mode: d.runMode,
        rain_delay: d.rainDelayHours,
        watering_status: this.isWatering(d.id) ? { current_station: 1 } : null,
      },
      ...(d.battery !== undefined ? { battery: { percent: d.battery } } : {}),
    };
  }

  #rest<T>(what: string, fn: () => T): Promise<T> {
    this.update();
    if (this.services.bhyveRest === 'hang') return new Promise<never>(() => {});
    if (this.services.bhyveRest === 'down') return Promise.reject(new Error(`B-hyve GET ${what} failed: HTTP 503 Service Unavailable`));
    return Promise.resolve(fn());
  }

  /** Fake B-hyve account (like BhyveClient). */
  readonly bhyve: BhyveControl = {
    getDevices: () => this.#rest('/devices', () => [...this.devices.values()].map((d) => this.#deviceView(d))),
    getDevice: (id: string) => this.#rest(`/devices/${id}`, () => this.#deviceView(this.device(id))),
    getPrograms: () => this.#rest('/sprinkler_timer_programs', () => this.programs),
    onEvent: (listener) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
    startWatering: (deviceId: string, runs: StationRun[]) => {
      this.update();
      if (this.services.bhyveSocket === 'down') return Promise.reject(new Error('B-hyve socket did not open within 15s'));
      if (this.services.bhyveSocket === 'hang') return new Promise<never>(() => {});
      const d = this.device(deviceId);
      if (!d.connected || this.ignoresCommands.has(deviceId)) return Promise.resolve(); // lost on the way
      // A new manual run replaces whatever was running.
      const now = this.clock.now().getTime();
      for (let i = this.#segments.length - 1; i >= 0; i--) {
        const seg = this.#segments[i];
        if (seg && seg.zone.startsWith(`${deviceId}:`) && seg.end > now) this.#segments.splice(i, 1);
      }
      let at = now;
      for (const r of runs) {
        this.#segments.push({ zone: `${deviceId}:${r.station}`, start: at, end: at + r.runTime * MINUTE_MS });
        at += r.runTime * MINUTE_MS;
      }
      for (const l of this.#listeners) l({ event: 'watering_in_progress_notification', device_id: deviceId });
      return Promise.resolve();
    },
  };

  /** Fake Open-Meteo. */
  readonly weather: WeatherProvider = {
    getForecast: (from: Date, hours: number): Promise<Forecast> => {
      if (this.services.weather === 'hang') return new Promise<never>(() => {});
      if (this.services.weather === 'down') return Promise.reject(new Error('Open-Meteo /v1/forecast HTTP 503'));
      const start = Math.ceil(from.getTime() / HOUR_MS) * HOUR_MS;
      const list: ForecastHour[] = Array.from({ length: hours + 1 }, (_, i) => {
        const end = start + i * HOUR_MS;
        const rain = this.forecastRain.filter((r) => r.at > end - HOUR_MS && r.at <= end);
        return {
          end: new Date(end),
          et0Mm: this.options.et0MmPerHour,
          precipMm: rain.reduce((sum, r) => sum + r.mm, 0),
          ...(rain.length > 0 ? { precipProbabilityPct: Math.max(...rain.map((r) => r.chancePct)) } : {}),
        };
      });
      return Promise.resolve({ location: { latitude: 30.27, longitude: -97.74 }, timeZone: 'America/Chicago', fetchedAt: from, hours: list });
    },
  };
}
