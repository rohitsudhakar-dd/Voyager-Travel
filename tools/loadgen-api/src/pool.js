/**
 * The pool of booking references the generator has created for itself.
 *
 * The manage, cancel and support journeys all need a real PNR and surname.
 * They must not take one from the seeded 400,000 bookings: cancelling seeded
 * data erodes the demo subject a little more every hour, and scenario S3
 * needs the power users' booking history intact. So checkout journeys post
 * what they confirm to the Redis list `voyager:loadgen:pnrs`, and the
 * journeys that consume bookings only ever consume those.
 *
 * Cancellation claims an entry and removes it; support borrows one and leaves
 * it. The list is trimmed from the head by the control scenario, so the pool
 * stays recent without growing without bound.
 */

import { client } from './redis.js';

export const POOL_KEY = 'voyager:loadgen:pnrs';

/** Deep enough that the consumers never collide, shallow enough to stay warm. */
export const POOL_LIMIT = 200;

export async function remember(booking) {
  try {
    await client.rpush(POOL_KEY, JSON.stringify(booking));
  } catch (error) {
    /* A lost reference costs one future manage journey, nothing more. */
  }
}

/** Take a booking out of the pool. The caller is going to cancel it. */
export async function claim() {
  try {
    return JSON.parse(await client.lpop(POOL_KEY));
  } catch (error) {
    return null;
  }
}

/** Read one without removing it, for journeys that only look. */
export async function borrow() {
  try {
    const window = await client.lrange(POOL_KEY, 0, 19);
    if (window.length === 0) return null;
    return JSON.parse(window[Math.floor(Math.random() * window.length)]);
  } catch (error) {
    return null;
  }
}

export async function depth() {
  try {
    return await client.llen(POOL_KEY);
  } catch (error) {
    return 0;
  }
}

/**
 * k6's Redis module has no LTRIM, so the oldest entries are popped one at a
 * time. Only the single control VU calls this, so the extra round trips are
 * once a minute rather than once a journey.
 */
export async function trim() {
  try {
    let length = await client.llen(POOL_KEY);
    while (length > POOL_LIMIT) {
      await client.lpop(POOL_KEY);
      length -= 1;
    }
  } catch (error) {
    /* Left for the next pass. */
  }
}
