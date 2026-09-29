/**
 * The four simulated GDS providers and their behaviour.
 *
 * search-service queries all four in parallel and the slowest one determines
 * the response time, which is what makes the trace waterfall interesting.
 * Each provider has its own latency profile so that "one provider is the
 * whole tail" is a true statement you can prove on a dashboard.
 */

import { config } from './config';

export const PROVIDERS = ['AMDS', 'SABR', 'TRVP', 'DRCT'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Per-provider latency multipliers. They average to 1.0 so the aggregate
 * distribution still lands on the p50/p95/p99 targets in
 * 03-EXECUTION-ORDER.md phase 2.
 */
const LATENCY_MULTIPLIER: Record<Provider, number> = {
  AMDS: 0.9,
  SABR: 1.0,
  TRVP: 1.25,
  DRCT: 0.85,
};

/**
 * Baseline latency: log-normal with a separate tail component.
 *
 * A single log-normal cannot hit p50 180 / p95 600 / p99 1800 at once -- the
 * shape that gives you the p99 ruins the p95. A mostly-tight body plus a
 * small heavy tail is both closer to the targets and closer to how a real
 * remote API behaves.
 */
const BODY_MEDIAN_MS = 178;
const BODY_SIGMA = 0.62;
const TAIL_PROBABILITY = 0.025;
const TAIL_MIN_MS = 600;
const TAIL_MAX_MS = 2_200;

function standardNormal(): number {
  // Box-Muller. Math.random() is never 0 here because of the 1 - u.
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function baselineLatencyMs(provider: Provider): number {
  const body = BODY_MEDIAN_MS * Math.exp(BODY_SIGMA * standardNormal());
  const tail =
    Math.random() < TAIL_PROBABILITY
      ? TAIL_MIN_MS + Math.random() * (TAIL_MAX_MS - TAIL_MIN_MS)
      : 0;
  return Math.round((body + tail) * LATENCY_MULTIPLIER[provider]);
}

/**
 * Sliding-window rate limiter, one window per provider.
 *
 * Deliberately global rather than per-client: a GDS quota belongs to the
 * agency, not to the request.
 */
const windows = new Map<Provider, number[]>();

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
}

export function checkRateLimit(provider: Provider, aggressive: boolean): RateLimitResult {
  const limit = aggressive
    ? config.aggressiveRateLimitPerMinute
    : config.rateLimitPerMinute;

  const now = Date.now();
  const cutoff = now - 60_000;
  const hits = (windows.get(provider) ?? []).filter((at) => at > cutoff);

  if (hits.length >= limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((hits[0] + 60_000 - now) / 1000),
    );
    windows.set(provider, hits);
    return { limited: true, retryAfterSeconds, limit, remaining: 0 };
  }

  hits.push(now);
  windows.set(provider, hits);
  return {
    limited: false,
    retryAfterSeconds: 0,
    limit,
    remaining: limit - hits.length,
  };
}

export function resetRateLimits(): void {
  windows.clear();
}
