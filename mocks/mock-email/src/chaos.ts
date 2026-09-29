/**
 * Chaos flag reader.
 *
 * All state lives in the single Redis hash `voyager:chaos`
 * (05-FUNCTIONALITY.md § 10). This module is the only place in the service
 * that reads it, and it is deliberately small enough to read on a slide.
 *
 * Three rules it must obey:
 *  - fail open: if Redis is unreachable, chaos is off. A demo must never
 *    break because Redis hiccuped.
 *  - no restarts: a flag takes effect on the next request.
 *  - 2 second cache: long enough not to hammer Redis, short enough that a
 *    toggle feels instant on stage.
 */

import Redis from 'ioredis';

export const CHAOS_HASH = 'voyager:chaos';
const CACHE_TTL_MS = 2_000;

export type LatencyMode = 'fixed' | 'jitter' | 'p99_tail';

let snapshot: Record<string, string> = {};
let loadedAt = 0;
let inFlight: Promise<void> | null = null;

let redis: Redis | null = null;

export function initChaos(redisUrl: string): void {
  redis = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  // Without a handler an unreachable Redis takes the process down, which is
  // the opposite of failing open.
  redis.on('error', () => {});
}

/** Refresh the snapshot if it is older than the cache TTL. */
export async function refresh(): Promise<void> {
  if (!redis) return;
  if (Date.now() - loadedAt < CACHE_TTL_MS) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      snapshot = await redis!.hgetall(CHAOS_HASH);
    } catch {
      snapshot = {};
    } finally {
      loadedAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}

function raw(flag: string): string | undefined {
  return snapshot[flag];
}

export function isEnabled(flag: string): boolean {
  const value = raw(flag);
  if (value === undefined) return false;
  return value === 'true' || value === '1' || value === '"true"';
}

export function getValue<T extends string | number>(flag: string, fallback: T): T {
  const value = raw(flag);
  if (value === undefined || value === '') return fallback;
  // Values are JSON-encoded scalars, but a bare value set by hand with
  // redis-cli should work too -- an operator mid-demo should not have to
  // remember to quote things.
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* keep the raw string */
  }
  if (typeof fallback === 'number') {
    const asNumber = Number(parsed);
    return (Number.isFinite(asNumber) ? asNumber : fallback) as T;
  }
  return String(parsed) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply the latency configured by `flag`, in the mode configured by
 * `modeFlag`. Real waiting, not fake work -- this is a third party being
 * slow, which is exactly what a network delay looks like.
 */
export async function maybeDelay(flag: string, modeFlag?: string): Promise<number> {
  const base = getValue(flag, 0);
  if (base <= 0) return 0;

  const mode = (modeFlag ? getValue(modeFlag, 'jitter') : 'jitter') as LatencyMode;
  let delay = base;

  if (mode === 'jitter') {
    delay = base * (0.5 + Math.random());
  } else if (mode === 'p99_tail') {
    // Only the tail is slow, which is the whole point of scenario S1: p95
    // barely moves while p99 goes through the roof.
    const roll = Math.random();
    if (roll < 0.01) delay = base;
    else if (roll < 0.05) delay = base * 0.5;
    else delay = 0;
  }

  if (delay > 0) await sleep(delay);
  return Math.round(delay);
}

/** Probabilistic failure. Returns true when the caller should fail. */
export function maybeFail(flag: string): boolean {
  const rate = getValue(flag, 0);
  return rate > 0 && Math.random() < rate;
}

/** Sorted, for the `chaos.active_flags` span tag added in Phase 8. */
export function activeFlags(): string[] {
  return Object.keys(snapshot)
    .filter((flag) => {
      const value = raw(flag);
      return value !== undefined && value !== '' && value !== 'false' && value !== '0';
    })
    .sort();
}

export async function closeChaos(): Promise<void> {
  await redis?.quit().catch(() => {});
}
