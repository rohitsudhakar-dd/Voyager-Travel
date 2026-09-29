/**
 * One Redis client per virtual user, shared by the settings reader, the
 * statistics mirror and the booking-reference pool. k6 gives every VU its own
 * module registry, so this is per-VU rather than per-process; opening a second
 * client per module would double the connection count for no benefit.
 */

import redis from 'k6/experimental/redis';

export const client = new redis.Client(__ENV.REDIS_URL || 'redis://redis:6379');
