/**
 * One Redis connection for the process, shared by the settings reader and
 * the statistics mirror.
 *
 * The error handler is not optional: without one, ioredis turns an
 * unreachable Redis into an unhandled error event and takes the process
 * down, which is precisely the failure mode both callers are written to
 * avoid.
 */

import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

redis.on('error', () => {});

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => {});
}
