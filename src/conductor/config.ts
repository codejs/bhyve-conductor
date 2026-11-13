import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Monitoring rules: which soil sensors watch which B-hyve zone, and when/how much to water.
 * Lives in a JSON file (see conductor.example.json) because the sensor → zone mapping is
 * too structured for environment variables.
 */

const minutes = (max: number) => z.number().positive().max(max);

/** Connection-failure handling for watering sequences (see sequencer.ts). */
export interface RecoveryOptions {
  /** How long to wait for the device to acknowledge a command before checking its status. */
  confirmTimeoutSeconds: number;
  /** Keep retrying a wave for this long after it was due, then abandon the rest of the sequence. */
  retryWindowMinutes: number;
  /** After a restart, resume a sequence only if its next wave was due at most this long ago. */
  resumeWindowMinutes: number;
}

export const DEFAULT_RECOVERY: RecoveryOptions = {
  confirmTimeoutSeconds: 20,
  retryWindowMinutes: 30,
  resumeWindowMinutes: 60,
};

/** Health checks beyond watering (see alerts.ts). */
export interface AlertOptions {
  /** Warn when a sensor's or timer's battery is at or below this %. */
  lowBatteryPct: number;
  /** How often to check the B-hyve controllers (connectivity, battery) even when nothing needs water. 0 = only when watering. */
  deviceCheckMinutes: number;
}

export const DEFAULT_ALERTS: AlertOptions = { lowBatteryPct: 20, deviceCheckMinutes: 60 };

export type Severity = 'info' | 'warning' | 'critical';

/** What gets sent to Telegram (see notify/notifier.ts). Everything is in the audit trail regardless. */
export interface NotificationOptions {
  /** Least severe notification to send. */
  minSeverity: Severity;
  /** Also notify every cycle of a cycle-and-soak sequence (not just its start and end). */
  cycles: boolean;
  /** Only report a lost connection if it's still lost after this long (ignores blips). */
  connectionGraceMinutes: number;
  /** Time zone for times in messages (default: this machine's). */
  timeZone?: string;
}

export const DEFAULT_NOTIFICATIONS: NotificationOptions = { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 };

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
  /**
   * How the zone's sensors are combined: `driest` waters when any sensor is below the threshold
   * (protects the driest spot, but one sensor in a dry corner or on a slope can overwater the rest);
   * `average`/`median` water by the typical reading instead.
   */
  sensorAggregation: z.enum(['driest', 'average', 'median']),
  /** Longest continuous run; anything more is split into cycles so the water can soak in, not run off. */
  maxCycleMinutes: minutes(240),
  /** Pause between those cycles for the soil to absorb the water. */
  soakMinutes: z.number().min(0).max(240),

  // --- Forecast-based amounts (used when LOCATION is set; see water-budget.ts) ---
  /** Depth of the root zone the sensors represent, in inches. */
  rootDepthIn: z.number().min(1).max(24),
  /** Turf water use relative to reference ET₀: ~0.8 cool-season grass, ~0.6 warm-season. */
  cropCoefficient: z.number().min(0.1).max(1.5),
  /** Share of forecast rain that soaks into the root zone. */
  rainEfficiency: z.number().min(0).max(1),
  /** How long a dry zone may wait for forecast rain or a scheduled B-hyve run before we water it. */
  maxWaitHours: z.number().min(0).max(48),
});

export type ZoneRules = z.infer<typeof RulesSchema>;

const DEFAULT_RULES: ZoneRules = {
  thresholdPct: 30,
  runMinutes: 10,
  cooldownMinutes: 240,
  maxMinutesPerDay: 30,
  maxReadingAgeMinutes: 180,
  sensorAggregation: 'driest',
  maxCycleMinutes: 20,
  soakMinutes: 30,
  rootDepthIn: 6,
  cropCoefficient: 0.8,
  rainEfficiency: 0.8,
  maxWaitHours: 6,
};

/** Settings without a built-in default. */
const ExtraSchema = z.object({
  /** Refill level: supplemental watering never raises the soil above this. Defaults to threshold + 10. */
  targetPct: z.number().min(0).max(100).optional(),
  /** Inches per hour this zone's sprinklers apply. Required for forecast-based amounts. */
  precipRateInPerHour: z.number().min(0.05).max(5).optional(),
  /** Alert when any sensor reads below this (default: threshold − 10). */
  criticalLowPct: z.number().min(0).max(100).optional(),
  /** Alert when any sensor reads above this: waterlogged, leak, or overwatering (default: target + 20). */
  criticalHighPct: z.number().min(0).max(100).optional(),
});

const ZoneSchema = RulesSchema.partial().extend(ExtraSchema.shape).extend({
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
    /** How far ahead to look at the weather forecast and B-hyve schedule. */
    forecastHours: z.number().int().min(12).max(120).default(72),
    /** Connection-failure handling for watering sequences (see sequencer.ts). */
    recovery: z
      .object({
        confirmTimeoutSeconds: z.number().min(0).max(300).default(DEFAULT_RECOVERY.confirmTimeoutSeconds),
        retryWindowMinutes: z.number().min(1).max(24 * 60).default(DEFAULT_RECOVERY.retryWindowMinutes),
        resumeWindowMinutes: z.number().min(0).max(24 * 60).default(DEFAULT_RECOVERY.resumeWindowMinutes),
      })
      // A plain .default({}) would skip the field defaults above in zod 4.
      .default({ ...DEFAULT_RECOVERY }),
    alerts: z
      .object({
        lowBatteryPct: z.number().min(0).max(100).default(DEFAULT_ALERTS.lowBatteryPct),
        deviceCheckMinutes: z.number().min(0).max(24 * 60).default(DEFAULT_ALERTS.deviceCheckMinutes),
      })
      .default({ ...DEFAULT_ALERTS }),
    notifications: z
      .object({
        minSeverity: z.enum(['info', 'warning', 'critical']).default(DEFAULT_NOTIFICATIONS.minSeverity),
        cycles: z.boolean().default(DEFAULT_NOTIFICATIONS.cycles),
        connectionGraceMinutes: z.number().min(0).max(24 * 60).default(DEFAULT_NOTIFICATIONS.connectionGraceMinutes),
        timeZone: z
          .string()
          .refine((tz) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: tz });
              return true;
            } catch {
              return false;
            }
          }, 'unknown time zone')
          .optional(),
      })
      .default({ ...DEFAULT_NOTIFICATIONS }),
    defaults: RulesSchema.partial().extend(ExtraSchema.shape).default({}),
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

      const threshold = z.thresholdPct ?? cfg.defaults.thresholdPct ?? DEFAULT_RULES.thresholdPct;
      const target = z.targetPct ?? cfg.defaults.targetPct;
      if (target !== undefined && target <= threshold) {
        ctx.addIssue({
          code: 'custom',
          path: ['zones', i, 'targetPct'],
          message: `targetPct (${target}) must be above thresholdPct (${threshold})`,
        });
      }
      const low = z.criticalLowPct ?? cfg.defaults.criticalLowPct;
      if (low !== undefined && low >= threshold) {
        ctx.addIssue({
          code: 'custom',
          path: ['zones', i, 'criticalLowPct'],
          message: `criticalLowPct (${low}) must be below thresholdPct (${threshold})`,
        });
      }
      const high = z.criticalHighPct ?? cfg.defaults.criticalHighPct;
      const effectiveTarget = target ?? Math.min(100, threshold + 10);
      if (high !== undefined && high <= effectiveTarget) {
        ctx.addIssue({
          code: 'custom',
          path: ['zones', i, 'criticalHighPct'],
          message: `criticalHighPct (${high}) must be above targetPct (${effectiveTarget})`,
        });
      }
    });
  });

export interface ZoneConfig extends ZoneRules {
  /** Stable identifier "<deviceId>:<station>". */
  key: string;
  name: string;
  deviceId: string;
  station: number;
  sensorIds: string[];
  targetPct: number;
  precipRateInPerHour?: number;
  criticalLowPct: number;
  criticalHighPct: number;
}

export interface ConductorConfig {
  pollIntervalMinutes: number;
  dryRun: boolean;
  forecastHours: number;
  recovery: RecoveryOptions;
  alerts: AlertOptions;
  notifications: NotificationOptions;
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
  const { pollIntervalMinutes, dryRun, forecastHours, recovery, alerts, notifications, defaults, zones } = result.data;

  return {
    pollIntervalMinutes,
    dryRun,
    forecastHours,
    recovery,
    alerts,
    notifications: {
      minSeverity: notifications.minSeverity,
      cycles: notifications.cycles,
      connectionGraceMinutes: notifications.connectionGraceMinutes,
      ...(notifications.timeZone ? { timeZone: notifications.timeZone } : {}),
    },
    zones: zones.map((z) => {
      const thresholdPct = z.thresholdPct ?? defaults.thresholdPct ?? DEFAULT_RULES.thresholdPct;
      const targetPct = z.targetPct ?? defaults.targetPct ?? Math.min(100, thresholdPct + 10);
      const precipRate = z.precipRateInPerHour ?? defaults.precipRateInPerHour;
      return {
      key: zoneKey(z),
      name: z.name ?? `zone ${z.station}`,
      deviceId: z.deviceId,
      station: z.station,
      sensorIds: [...new Set(z.sensorIds)],
      thresholdPct,
      runMinutes: z.runMinutes ?? defaults.runMinutes ?? DEFAULT_RULES.runMinutes,
      cooldownMinutes: z.cooldownMinutes ?? defaults.cooldownMinutes ?? DEFAULT_RULES.cooldownMinutes,
      maxMinutesPerDay: z.maxMinutesPerDay ?? defaults.maxMinutesPerDay ?? DEFAULT_RULES.maxMinutesPerDay,
      maxReadingAgeMinutes: z.maxReadingAgeMinutes ?? defaults.maxReadingAgeMinutes ?? DEFAULT_RULES.maxReadingAgeMinutes,
      sensorAggregation: z.sensorAggregation ?? defaults.sensorAggregation ?? DEFAULT_RULES.sensorAggregation,
      maxCycleMinutes: z.maxCycleMinutes ?? defaults.maxCycleMinutes ?? DEFAULT_RULES.maxCycleMinutes,
      soakMinutes: z.soakMinutes ?? defaults.soakMinutes ?? DEFAULT_RULES.soakMinutes,
      targetPct,
      criticalLowPct: z.criticalLowPct ?? defaults.criticalLowPct ?? Math.max(0, thresholdPct - 10),
      criticalHighPct: z.criticalHighPct ?? defaults.criticalHighPct ?? Math.min(100, targetPct + 20),
      rootDepthIn: z.rootDepthIn ?? defaults.rootDepthIn ?? DEFAULT_RULES.rootDepthIn,
      cropCoefficient: z.cropCoefficient ?? defaults.cropCoefficient ?? DEFAULT_RULES.cropCoefficient,
      rainEfficiency: z.rainEfficiency ?? defaults.rainEfficiency ?? DEFAULT_RULES.rainEfficiency,
      maxWaitHours: z.maxWaitHours ?? defaults.maxWaitHours ?? DEFAULT_RULES.maxWaitHours,
      ...(precipRate !== undefined ? { precipRateInPerHour: precipRate } : {}),
      };
    }),
  };
};

/**
 * Forecast-based amounts need each zone's sprinkler rate (inches/hour) to turn inches into minutes.
 * There's no safe default (spray heads ≈ 1.5, rotors ≈ 0.5), so it must be configured.
 */
export const assertForecastReady = (config: ConductorConfig): void => {
  const missing = config.zones.filter((z) => z.precipRateInPerHour === undefined).map((z) => `${z.name} [${z.key}]`);
  if (missing.length > 0) {
    throw new Error(
      `LOCATION is set, so watering amounts come from the forecast, but these zones have no precipRateInPerHour ` +
        `(set it per zone or in "defaults"; measure it with a catch-cup test): ${missing.join(', ')}`,
    );
  }
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
