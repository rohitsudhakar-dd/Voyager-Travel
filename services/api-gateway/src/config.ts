/**
 * Runtime configuration. Every value comes from the environment; the two
 * secrets have no default at all, because a gateway that silently falls back
 * to a well-known JWT secret is worse than one that refuses to start.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required -- see .env.example`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  service: process.env.DD_SERVICE ?? 'voyager-gateway',
  env: process.env.DD_ENV ?? 'demo',
  version: process.env.DD_VERSION ?? 'dev',
  port: int('PORT', 4000),

  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',

  postgres: {
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: int('POSTGRES_PORT', 5432),
    user: process.env.POSTGRES_USER ?? 'voyager',
    password: process.env.POSTGRES_PASSWORD ?? '',
    database: process.env.POSTGRES_DB ?? 'voyager',
  },

  upstreams: {
    search: process.env.SEARCH_BASE_URL ?? 'http://search-service:4010',
    pricing: process.env.PRICING_BASE_URL ?? 'http://pricing-service:4020',
    booking: process.env.BOOKING_BASE_URL ?? 'http://booking-service:4030',
    payment: process.env.PAYMENT_BASE_URL ?? 'http://payment-service:4040',
    loyalty: process.env.LOYALTY_BASE_URL ?? 'http://loyalty-service:4050',
    notifications: process.env.NOTIFICATIONS_BASE_URL ?? 'http://notification-worker:4060',
    aiSupport: process.env.AI_SUPPORT_BASE_URL ?? 'http://ai-support-service:4070',
  },

  auth: {
    jwtSecret: required('JWT_SECRET'),
    // § 2.1: 15-minute access tokens, 30-day opaque refresh tokens held in
    // Redis so a logout can actually revoke one.
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTokenTtlSeconds: int('REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
  },

  adminSecret: required('ADMIN_SECRET'),

  // Generous enough that a demo's load generator is never throttled, tight
  // enough that the gateway is not an open proxy.
  rateLimit: {
    max: int('RATE_LIMIT_MAX', 600),
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  },

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  referenceCache: {
    // § 2.2: airports and cities for an hour, airlines for a day.
    airportsTtlSeconds: int('REF_AIRPORTS_TTL_SECONDS', 3600),
    airlinesTtlSeconds: int('REF_AIRLINES_TTL_SECONDS', 86_400),
  },
} as const;

/** What the startup log prints. Secrets are named, never valued. */
export function redacted(): Record<string, unknown> {
  return {
    port: config.port,
    upstreams: config.upstreams,
    cors_origins: config.corsOrigins,
    rate_limit: config.rateLimit,
    jwt_secret: '<set>',
    admin_secret: '<set>',
  };
}
