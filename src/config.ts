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

const EnvSchema = z.object({
  BHYVE_EMAIL: z.email(),
  BHYVE_PASSWORD: z.string().min(1),

  TUYA_CLIENT_ID: z.string().min(1),
  TUYA_CLIENT_SECRET: z.string().min(1),
  TUYA_BASE_URL: z.url().default('https://openapi.tuyaus.com'),
  TUYA_SOIL_SENSOR_IDS: csv,
  TUYA_MOISTURE_CODE: z.string().default('humidity'),

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
