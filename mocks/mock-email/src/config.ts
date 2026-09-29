/** Runtime configuration. Everything comes from the environment. */

export const config = {
  service: process.env.DD_SERVICE ?? 'mock-email',
  env: process.env.DD_ENV ?? 'demo',
  version: process.env.DD_VERSION ?? 'dev',
  port: Number(process.env.PORT ?? 4920),
  host: '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',

  /** The outbox is a ring buffer; this is how deep it goes. */
  outboxCapacity: Number(process.env.MOCK_EMAIL_OUTBOX_CAPACITY ?? 200),
};
