/** Runtime configuration. Everything comes from the environment. */

export const config = {
  service: process.env.DD_SERVICE ?? 'mock-gds',
  env: process.env.DD_ENV ?? 'demo',
  version: process.env.DD_VERSION ?? 'dev',
  port: Number(process.env.PORT ?? 4900),
  host: '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',

  postgres: {
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    // A read-only role: this is a third party, and third parties do not get
    // to write to your database (infra/postgres/init/02-readonly-role.sql).
    user: process.env.MOCK_DB_USER ?? 'voyager_readonly',
    password: process.env.MOCK_DB_PASSWORD ?? '',
    database: process.env.POSTGRES_DB ?? 'voyager',
    max: 10,
  },

  /**
   * 60 requests per minute per provider, as specified. Cache-disabled chaos
   * blows straight through this, which is what makes scenario S4 cascade.
   */
  rateLimitPerMinute: Number(process.env.MOCK_GDS_RATE_LIMIT_PER_MIN ?? 60),
  aggressiveRateLimitPerMinute: Number(
    process.env.MOCK_GDS_RATE_LIMIT_AGGRESSIVE_PER_MIN ?? 10,
  ),

  /** Baseline failure rate, before any chaos is applied. */
  baselineErrorRate: Number(process.env.MOCK_GDS_BASELINE_ERROR_RATE ?? 0.005),
};
