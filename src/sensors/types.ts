export interface MoistureReading {
  sensorId: string;
  sensorName: string;
  /** Soil volumetric moisture, 0–100 %. */
  moisturePct: number;
  temperatureC?: number;
  batteryPct?: number;
  online: boolean;
  /** When this reading was taken by the sensor (or fetched, if the source has no timestamp). */
  at: Date;
}

/** Anything that can produce soil moisture readings (Tuya cloud, MQTT, DIY, ...). */
export interface MoistureSource {
  readonly id: string;
  read(): Promise<MoistureReading[]>;
}
