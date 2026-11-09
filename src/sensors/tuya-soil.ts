import { log } from '../log.ts';
import { scaleOf, type TuyaClient, type TuyaDataPoint, type TuyaSpecification } from '../tuya/client.ts';
import type { MoistureReading, MoistureSource } from './types.ts';

export interface TuyaSoilOptions {
  sensorIds: string[];
  /** Data-point code for soil moisture; most Tuya Zigbee soil sensors use "humidity". */
  moistureCode: string;
  temperatureCodes?: string[];
  batteryCodes?: string[];
}

const DEFAULT_TEMP_CODES = ['temp_current', 'va_temperature', 'temperature'];
const DEFAULT_BATTERY_CODES = ['battery_percentage', 'va_battery', 'battery'];

/** Reads Tuya Zigbee soil moisture sensors (via the MOES gateway) from the Tuya cloud. */
export class TuyaSoilSource implements MoistureSource {
  readonly id = 'tuya-soil';
  readonly #tuya: TuyaClient;
  readonly #opts: Required<TuyaSoilOptions>;
  readonly #specs = new Map<string, TuyaSpecification>();

  constructor(tuya: TuyaClient, opts: TuyaSoilOptions) {
    this.#tuya = tuya;
    this.#opts = {
      temperatureCodes: DEFAULT_TEMP_CODES,
      batteryCodes: DEFAULT_BATTERY_CODES,
      ...opts,
    };
  }

  async #spec(deviceId: string): Promise<TuyaSpecification> {
    let spec = this.#specs.get(deviceId);
    if (!spec) {
      spec = await this.#tuya.getSpecification(deviceId);
      this.#specs.set(deviceId, spec);
    }
    return spec;
  }

  #numeric(status: TuyaDataPoint[], spec: TuyaSpecification, codes: string[]): number | undefined {
    for (const code of codes) {
      const dp = status.find((s) => s.code === code);
      if (dp && typeof dp.value === 'number') return dp.value / 10 ** scaleOf(spec, code);
    }
    return undefined;
  }

  async read(): Promise<MoistureReading[]> {
    const results = await Promise.allSettled(this.#opts.sensorIds.map((id) => this.#readOne(id)));
    const readings: MoistureReading[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') readings.push(r.value);
      else log.warn(`Tuya soil sensor ${this.#opts.sensorIds[i]} read failed`, r.reason);
    });
    return readings;
  }

  async #readOne(deviceId: string): Promise<MoistureReading> {
    // Device details include status + update_time + online, so one call covers most of it.
    const [device, spec] = await Promise.all([this.#tuya.getDevice(deviceId), this.#spec(deviceId)]);
    const status = device.status ?? (await this.#tuya.getStatus(deviceId));

    const moisture = this.#numeric(status, spec, [this.#opts.moistureCode]);
    if (moisture === undefined) {
      const codes = status.map((s) => s.code).join(', ');
      throw new Error(`No numeric "${this.#opts.moistureCode}" data point; available codes: ${codes}`);
    }

    const updateTime = typeof device.update_time === 'number' ? device.update_time : undefined;
    const temperatureC = this.#numeric(status, spec, this.#opts.temperatureCodes);
    const batteryPct = this.#numeric(status, spec, this.#opts.batteryCodes);

    return {
      sensorId: deviceId,
      sensorName: device.name,
      moisturePct: moisture,
      ...(temperatureC !== undefined ? { temperatureC } : {}),
      ...(batteryPct !== undefined ? { batteryPct } : {}),
      online: device.online ?? false,
      at: updateTime ? new Date(updateTime * 1000) : new Date(),
    };
  }
}
