/** The handful of connections every route shares. */

import Redis from 'ioredis';
import { Pool } from 'pg';

import { ChaosStore } from './admin/chaos-store';
import { config } from './config';

export interface Deps {
  redis: Redis;
  pool: Pool;
  chaos: ChaosStore;
  /**
   * Set by POST /admin/version to fake a deploy for scenario S6. It shadows
   * DD_VERSION in what this service reports, without a restart.
   */
  versionOverride: string | null;
}

export function createDeps(): Deps {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  // Without a handler an unreachable Redis takes the process down, which is
  // the opposite of failing open.
  redis.on('error', () => {});

  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    user: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,
    max: 10,
    options: '-c search_path=voyager,public',
  });
  pool.on('error', () => {});

  return { redis, pool, chaos: new ChaosStore(redis, pool), versionOverride: null };
}

export async function closeDeps(deps: Deps): Promise<void> {
  await deps.pool.end().catch(() => {});
  deps.redis.disconnect();
}

/** What this service reports as its version, honouring the S6 override. */
export function reportedVersion(deps: Deps): string {
  return deps.versionOverride ?? config.version;
}
