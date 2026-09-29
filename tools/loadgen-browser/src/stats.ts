/**
 * What the generator currently believes, published to the Redis hash
 * `voyager:loadgen:stats` alongside the k6 generator's own fields.
 *
 * The admin console's Load tab and scripts/verify-loadgen.sh both need to
 * answer "is it running, at what concurrency, and is the UI even there?"
 * without attaching to the container. `browser_ui_reachable` is the field
 * that matters most before Phase 7 lands: it is the difference between a
 * generator that is broken and one that is correctly waiting.
 *
 * Writes are best-effort. Losing a counter is not worth abandoning a session.
 */

import { redis } from './redis';

export const STATS_KEY = 'voyager:loadgen:stats';

export async function count(field: string): Promise<void> {
  try {
    await redis.hincrby(STATS_KEY, field, 1);
  } catch (error) {
    /* Statistics are decoration; sessions are the product. */
  }
}

export async function publish(fields: Record<string, string | number>): Promise<void> {
  try {
    await redis.hset(STATS_KEY, fields);
  } catch (error) {
    /* As above. */
  }
}
