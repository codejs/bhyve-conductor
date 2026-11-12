import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Monitoring rules: which soil sensors watch which B-hyve zone, and when/how much to water.
 * Lives in a JSON file (see conductor.example.json) because the sensor → zone mapping is
 * too structured for environment variables.
 */

const minutes = (max: number) => z.number().positive().max(max);

const RulesSchema = z.object({
  /** Water the zone when any of its sensors reads below this soil moisture %. */
  thresholdPct: z.number().min(0).max(100),
  /** Length of one supplemental run, in minutes (B-hyve accepts up to 240). */
  runMinutes: minutes(240),
  /** Minimum time between supplemental runs of the same zone, so water can soak in and the sensor can catch up. */
  cooldownMinutes: z.number().min(0).max(7 * 24 * 60),
  /** Cap on supplemental watering per zone over any rolling 24 hours. */
  maxMinutesPerDay: minutes(24 * 60),
  /** Ignore readings older than this. A stale sensor must never trigger watering. */
  maxReadingAgeMinutes: minutes(7 * 24 * 60),
});

export type ZoneRules = z.infer<typeof RulesSchema>;

const DEFAULT_RULES: ZoneRules = {
  thresholdPct: 30,
  runMinutes: 10,
  cooldownMinutes: 240,
  maxMinutesPerDay: 30,
  maxReadingAgeMinutes: 180,
};

const ZoneSchema = RulesSchema.partial().extend({
  name: z.string().min(1).optional(),
  /** B-hyve device id (see `npm run bhyve:devices`). */
  deviceId: z.string().min(1),
  /** Station number of the zone on that device. */
  station: z.number().int().min(1),
  /** Tuya device ids of the soil sensors in this zone (see `npm run tuya:devices`). */
  sensorIds: z.array(z.string().min(1)).min(1),
});

const FileSchema = z
  .object({
    pollIntervalMinutes: minutes(24 * 60).default(15),
    /** Log decisions without sending any commands to B-hyve. */
    dryRun: z.boolean().default(false),
    defaults: RulesSchema.partial().default({}),
    zones: z.array(ZoneSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.zones.forEach((z, i) => {
      const key = zoneKey(z);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['zones', i], message: `duplicate zone ${key}` });
      }
      seen.add(key);
    });
  });

export interface ZoneConfig extends ZoneRules {
  /** Stable identifier "<deviceId>:<station>". */
  key: string;
  name: string;
  deviceId: string;
  station: number;
  sensorIds: string[];
}

export interface ConductorConfig {
  pollIntervalMinutes: number;
  dryRun: boolean;
  zones: ZoneConfig[];
}

export const zoneKey = (z: { deviceId: string; station: number }): string => `${z.deviceId}:${z.station}`;

/** Validates a parsed config object and fills in defaults (per-zone value > `defaults` > built-in). */
export const parseConductorConfig = (raw: unknown): ConductorConfig => {
  const result = FileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid conductor config:\n${issues}`);
  }
  const { pollIntervalMinutes, dryRun, defaults, zones } = result.data;

  return {
    pollIntervalMinutes,
    dryRun,
    zones: zones.map((z) => ({
      key: zoneKey(z),
      name: z.name ?? `zone ${z.station}`,
      deviceId: z.deviceId,
      station: z.station,
      sensorIds: [...new Set(z.sensorIds)],
      thresholdPct: z.thresholdPct ?? defaults.thresholdPct ?? DEFAULT_RULES.thresholdPct,
      runMinutes: z.runMinutes ?? defaults.runMinutes ?? DEFAULT_RULES.runMinutes,
      cooldownMinutes: z.cooldownMinutes ?? defaults.cooldownMinutes ?? DEFAULT_RULES.cooldownMinutes,
      maxMinutesPerDay: z.maxMinutesPerDay ?? defaults.maxMinutesPerDay ?? DEFAULT_RULES.maxMinutesPerDay,
      maxReadingAgeMinutes: z.maxReadingAgeMinutes ?? defaults.maxReadingAgeMinutes ?? DEFAULT_RULES.maxReadingAgeMinutes,
    })),
  };
};

export const loadConductorConfig = async (path: string): Promise<ConductorConfig> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read conductor config ${path} (copy conductor.example.json): ${String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Conductor config ${path} is not valid JSON: ${String(err)}`);
  }
  return parseConductorConfig(raw);
};
