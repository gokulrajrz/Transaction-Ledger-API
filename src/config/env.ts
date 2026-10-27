import { z } from 'zod';

const positiveInteger = (fallback: number, max = 2_147_483_647) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

export const databaseUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Expected a valid PostgreSQL URL',
      });
      return;
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.slice(1)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Expected a PostgreSQL URL with a host and database name',
      });
    }
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(ssl|host|port|user|password|database)/i.test(key),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Connection overrides and TLS query options are not supported; use DB_SSL_CA_FILE',
      });
    }
  });

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: positiveInteger(3000, 65535),
  DATABASE_URL: databaseUrl,
  DB_SSL_CA_FILE: z.string().min(1).optional(),
  DB_POOL_MAX: positiveInteger(10, 100),
  DB_CONNECTION_TIMEOUT_MS: positiveInteger(10000),
  DB_IDLE_TIMEOUT_MS: positiveInteger(30000),
  DB_STATEMENT_TIMEOUT_MS: positiveInteger(30000),
  DB_LOCK_TIMEOUT_MS: positiveInteger(5000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(
  source: Record<string, unknown> = process.env,
): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Do not echo the source or Zod input: it can contain connection credentials.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
