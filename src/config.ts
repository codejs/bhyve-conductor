import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

/** An empty value (as copied from .env.example) means "not set". */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const EnvSchema = z.object({
  BHYVE_EMAIL: z.email(),
  BHYVE_PASSWORD: z.string().min(1),

  TUYA_CLIENT_ID: z.string().min(1),
  TUYA_CLIENT_SECRET: z.string().min(1),
  TUYA_BASE_URL: z.url().default('https://openapi.tuyaus.com'),
  TUYA_SOIL_SENSOR_IDS: csv,
  TUYA_MOISTURE_CODE: z.string().default('humidity'),

  /**
   * Where the lawn is, for the weather forecast: "lat,lon", a US ZIP code, "City, ST" or a place name.
   * Optional: without it, dry zones get their fixed run length instead of a forecast-based amount.
   */
  LOCATION: blankAsUnset(z.string().trim().optional()),

  /** Sensor → zone mapping and watering rules (see conductor.example.json). */
  CONDUCTOR_CONFIG: z.string().min(1).default('conductor.json'),
  /** Where recent supplemental runs are remembered, so cooldowns survive restarts. */
  CONDUCTOR_STATE: z.string().min(1).default('.conductor-state.json'),
  /** Append-only audit trail of watering and connectivity events (review with `npm run audit`). */
  CONDUCTOR_AUDIT: z.string().min(1).default('.conductor-audit.jsonl'),

  /** Telegram notifications (optional): the bot token from @BotFather and the chat to post to. */
  TELEGRAM_BOT_TOKEN: blankAsUnset(z.string().regex(/^\d+:[\w-]{20,}$/, 'expected a bot token like 123456789:AA...').optional()),
  /** Numeric chat id (negative for groups) or @channelname. */
  TELEGRAM_CHAT_ID: blankAsUnset(z.string().regex(/^(-?\d+|@\w{4,})$/, 'expected a numeric chat id or @channelname').optional()),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Validates only the variables a given script needs, so B-hyve scripts work before Tuya is set up and vice versa. */
export const loadConfig = <K extends keyof Env>(keys: readonly K[]): Pick<Env, K> => {
  const mask: Partial<Record<keyof Env, true>> = Object.fromEntries(keys.map((k) => [k, true]));
  const result = EnvSchema.pick(mask).safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment (see .env.example):\n${issues}`);
  }
  return result.data as Pick<Env, K>;
};
