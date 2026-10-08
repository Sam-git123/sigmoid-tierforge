import { z } from 'zod';

const positiveInt = (value: number) => z.coerce.number().int().positive().default(value);
const httpUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
  message: 'Must be an HTTP(S) URL',
});

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z
      .url()
      .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
        message: 'Must be a PostgreSQL URL',
      }),
    API_PORT: positiveInt(3001).pipe(z.number().max(65535)),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DB_POOL_MAX: positiveInt(10).pipe(z.number().max(100)),
    DB_CONNECTION_TIMEOUT_MS: positiveInt(3000),
    DB_STATEMENT_TIMEOUT_MS: positiveInt(5000),
    ENRICHMENT_API_BASE_URL: httpUrl.default('http://127.0.0.1:8000'),
    WORKER_CONCURRENCY: positiveInt(5).pipe(z.number().max(100)),
    ENRICHMENT_MAX_RPS: positiveInt(5).pipe(z.number().max(5)),
    MIN_DISPATCH_INTERVAL_MS: positiveInt(210),
    ENRICHMENT_TIMEOUT_MS: positiveInt(10000),
    MAX_ATTEMPTS: positiveInt(6),
    LEASE_DURATION_MS: positiveInt(20000),
    LEASE_REAPER_INTERVAL_MS: positiveInt(1000),
    RETRY_BASE_MS: positiveInt(1000),
    RETRY_CAP_MS: positiveInt(30000),
    SYSTEMIC_FAILURE_STREAK: positiveInt(30),
    MAX_UPSTREAM_COOLDOWN_MS: positiveInt(120000),
  })
  .superRefine((env, context) => {
    if (env.LEASE_DURATION_MS < env.ENRICHMENT_TIMEOUT_MS + 5000) {
      context.addIssue({
        code: 'custom',
        path: ['LEASE_DURATION_MS'],
        message: 'Must exceed HTTP timeout by at least 5000ms',
      });
    }
    if (env.RETRY_CAP_MS < env.RETRY_BASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['RETRY_CAP_MS'],
        message: 'Must be at least RETRY_BASE_MS',
      });
    }
    if (env.MIN_DISPATCH_INTERVAL_MS < Math.ceil(1000 / env.ENRICHMENT_MAX_RPS)) {
      context.addIssue({
        code: 'custom',
        path: ['MIN_DISPATCH_INTERVAL_MS'],
        message: 'Must respect ENRICHMENT_MAX_RPS',
      });
    }
  });

export type Environment = z.infer<typeof envSchema>;

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    // Only field names are exposed: a malformed URL can contain a password.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
