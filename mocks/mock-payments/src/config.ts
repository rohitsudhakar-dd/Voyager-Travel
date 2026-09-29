/** Runtime configuration. Everything comes from the environment. */

export const config = {
  service: process.env.DD_SERVICE ?? 'mock-payments',
  env: process.env.DD_ENV ?? 'demo',
  version: process.env.DD_VERSION ?? 'dev',
  port: Number(process.env.PORT ?? 4910),
  host: '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',

  /** Where the asynchronous authorization result is delivered. */
  webhookUrl:
    process.env.PAYMENT_WEBHOOK_URL ?? 'http://payment-service:4040/v1/webhooks/provider',
  webhookMinDelayMs: Number(process.env.PAYMENT_WEBHOOK_MIN_DELAY_MS ?? 1_000),
  webhookMaxDelayMs: Number(process.env.PAYMENT_WEBHOOK_MAX_DELAY_MS ?? 3_000),

  /** Baseline decline rate before chaos overrides it. */
  baselineDeclineRate: Number(process.env.MOCK_PAYMENTS_DECLINE_RATE ?? 0.02),

  /** How long an idempotency key is honoured. */
  idempotencyTtlMs: 24 * 60 * 60 * 1_000,
};
