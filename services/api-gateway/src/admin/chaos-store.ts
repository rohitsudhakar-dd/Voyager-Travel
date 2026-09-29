/**
 * Reads and writes the `voyager:chaos` hash, and owns the compensating
 * actions that make a reset genuinely a reset.
 *
 * Two flags leave something behind that clearing a hash key cannot undo:
 * `db_drop_index` drops an index, and `booking_memory_leak` fills a cache.
 * A reset that only cleared the hash would leave the system looking healthy
 * while the account page stayed slow, which is precisely the kind of
 * half-truth that destroys trust in a demo.
 */

import type { Pool } from 'pg';
import type Redis from 'ioredis';

import { FLAGS, coerce, encode, flag, type FlagDefinition } from './catalogue';
import { log } from '../logger';

export const CHAOS_HASH = 'voyager:chaos';

/** The index scenario S3 drops, recreated exactly as 05-FUNCTIONALITY.md § 3.3 defines it. */
const BOOKINGS_INDEX = 'idx_bookings_user_id_created_at';
const CREATE_BOOKINGS_INDEX = `
  CREATE INDEX IF NOT EXISTS ${BOOKINGS_INDEX}
  ON voyager.bookings (user_id, created_at DESC)
`;

export interface FlagView {
  name: string;
  group: string;
  type: FlagDefinition['type'];
  default: unknown;
  value: unknown;
  active: boolean;
  options?: string[];
  injection: string;
  scenarios: string[];
}

export class ChaosStore {
  constructor(
    private readonly redis: Redis,
    private readonly pool: Pool,
  ) {}

  async raw(): Promise<Record<string, string>> {
    return (await this.redis.hgetall(CHAOS_HASH)) ?? {};
  }

  /** Every flag with its current value -- the self-describing view § 10.1 asks for. */
  async describe(): Promise<FlagView[]> {
    const stored = await this.raw();
    return FLAGS.map((definition) => {
      const value = coerce(definition, stored[definition.name]);
      return {
        name: definition.name,
        group: definition.group,
        type: definition.type,
        default: definition.default,
        value,
        active: stored[definition.name] !== undefined && !isDefault(definition, value),
        options: definition.options,
        injection: definition.injection,
        scenarios: definition.scenarios,
      };
    });
  }

  async activeFlags(): Promise<string[]> {
    return (await this.describe()).filter((view) => view.active).map((view) => view.name);
  }

  /**
   * Apply a partial update. Setting a flag back to its default clears the key
   * rather than storing the default, so `activeFlags()` stays a short, honest
   * list instead of all thirty-eight names.
   */
  async apply(updates: Record<string, unknown>): Promise<void> {
    const toSet: string[] = [];
    const toDelete: string[] = [];

    for (const [name, value] of Object.entries(updates)) {
      const definition = flag(name);
      if (!definition) continue;
      if (value === null || isDefault(definition, value)) {
        toDelete.push(name);
      } else {
        toSet.push(name, encode(definition, value));
      }
    }

    const pipeline = this.redis.pipeline();
    if (toSet.length > 0) pipeline.hset(CHAOS_HASH, ...toSet);
    if (toDelete.length > 0) pipeline.hdel(CHAOS_HASH, ...toDelete);
    await pipeline.exec();

    await this.runSideEffects(updates);
  }

  /** Clear every flag and undo anything a flag left behind. */
  async reset(): Promise<{ cleared: string[]; compensated: string[] }> {
    const cleared = Object.keys(await this.raw());
    await this.redis.del(CHAOS_HASH);

    const compensated: string[] = [];
    if (await this.recreateBookingsIndex()) compensated.push(BOOKINGS_INDEX);

    // The services poll the hash every two seconds, so pool sizes, consumer
    // pauses, and leak caches unwind on their own from here. Only the index
    // needs us.
    log.info({ chaos: { cleared, compensated } }, 'Chaos reset');
    return { cleared, compensated };
  }

  private async runSideEffects(updates: Record<string, unknown>): Promise<void> {
    if ('db_drop_index' in updates) {
      const enable = truthy(updates.db_drop_index);
      if (enable) {
        await this.dropBookingsIndex();
      } else {
        await this.recreateBookingsIndex();
      }
    }
  }

  private async dropBookingsIndex(): Promise<void> {
    try {
      await this.pool.query(`DROP INDEX IF EXISTS voyager.${BOOKINGS_INDEX}`);
      log.warn({ chaos: { flag: 'db_drop_index', index: BOOKINGS_INDEX } }, 'Index dropped');
    } catch (error) {
      log.error(
        {
          error: { kind: 'ChaosCompensationError', message: (error as Error).message },
          chaos: { flag: 'db_drop_index' },
        },
        'Index could not be dropped',
      );
    }
  }

  private async recreateBookingsIndex(): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query(
        `SELECT 1 FROM pg_indexes
         WHERE schemaname = 'voyager' AND indexname = $1`,
        [BOOKINGS_INDEX],
      );
      if (rowCount && rowCount > 0) return false;

      // 400k rows, so this is not instant. Blocking the reset until it
      // finishes is deliberate: reporting success while the index is still
      // building would have the operator testing against a half-fixed system.
      await this.pool.query(CREATE_BOOKINGS_INDEX);
      await this.pool.query('ANALYZE voyager.bookings');
      log.info({ chaos: { index: BOOKINGS_INDEX } }, 'Index recreated');
      return true;
    } catch (error) {
      log.error(
        {
          error: { kind: 'ChaosCompensationError', message: (error as Error).message },
          chaos: { index: BOOKINGS_INDEX },
        },
        'Index could not be recreated',
      );
      return false;
    }
  }
}

function isDefault(definition: FlagDefinition, value: unknown): boolean {
  if (definition.type === 'map') {
    return Object.keys((value as Record<string, unknown>) ?? {}).length === 0;
  }
  if (definition.type === 'bool') return truthy(value) === truthy(definition.default);
  if (definition.type === 'int' || definition.type === 'float') {
    return Number(value) === Number(definition.default);
  }
  return String(value) === String(definition.default);
}

function truthy(value: unknown): boolean {
  return typeof value === 'boolean'
    ? value
    : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
