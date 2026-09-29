/**
 * What the generator currently believes, published to Redis.
 *
 * k6 keeps its counters in-process and only prints them when a test ends,
 * which for a generator that runs for weeks is never. The admin console's
 * Load tab and scripts/verify-loadgen.sh both need to answer "is it running,
 * at what intensity, and in what mix?" from outside the container, so the
 * answers go in the hash `voyager:loadgen:stats` where anything with a Redis
 * connection can read them.
 *
 * Writes are best-effort. Losing a counter is not worth abandoning a journey
 * that is already in flight.
 */

import { client } from './redis.js';

export const STATS_KEY = 'voyager:loadgen:stats';

export async function countJourney(journey) {
  await count(`api_journeys_${journey}`);
}

export async function count(field) {
  try {
    await client.hincrby(STATS_KEY, field, 1);
  } catch (error) {
    /* Statistics are decoration; traffic is the product. */
  }
}

export async function publish(fields) {
  try {
    for (const name of Object.keys(fields)) {
      await client.hset(STATS_KEY, name, String(fields[name]));
    }
  } catch (error) {
    /* As above. */
  }
}
