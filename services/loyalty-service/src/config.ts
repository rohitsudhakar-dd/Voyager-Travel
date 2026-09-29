/** Runtime configuration. Everything comes from the environment. */

export const config = {
  service: process.env.DD_SERVICE ?? 'voyager-loyalty',
  env: process.env.DD_ENV ?? 'demo',
  version: process.env.DD_VERSION ?? 'dev',
  port: Number(process.env.PORT ?? 4050),
  host: '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',

  postgres: {
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'voyager',
    password: process.env.POSTGRES_PASSWORD ?? '',
    database: process.env.POSTGRES_DB ?? 'voyager',
    max: 10,
  },

  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(',').map((b) => b.trim()),
    // Topic and group names are contracts, not configuration
    // (05-FUNCTIONALITY.md § 6). An operator who changes them breaks the
    // Data Streams topology, so they are not env-overridable.
    consumerGroup: 'voyager-loyalty-v1',
    bookingsTopic: 'voyager.bookings.events',
    accrualsTopic: 'voyager.loyalty.accruals',
  },

  /** How long a readiness probe waits on any single dependency. */
  readinessTimeoutMs: 2_000,

  /** Recent transactions returned by GET /v1/loyalty/{userId}. */
  recentTransactionLimit: Number(process.env.LOYALTY_RECENT_TRANSACTIONS ?? 20),
};
