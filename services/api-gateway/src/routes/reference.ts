/**
 * Reference data (05-FUNCTIONALITY.md § 2.2).
 *
 * Airports and cities change roughly never, so these are read straight from
 * Postgres and cached in Redis. The cache matters for a reason beyond speed:
 * autocomplete fires on every keystroke, and an uncached prefix query against
 * 500 airports would be the noisiest query in the whole application.
 */

import type { FastifyInstance } from 'fastify';

import { config } from '../config';
import type { Deps } from '../deps';

const MAX_LIMIT = 20;

export function registerReferenceRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/ref/airports', async (request) => {
    const { q = '', limit } = request.query as { q?: string; limit?: string };
    const size = clamp(limit, 8);
    const key = `ref:airports:${q.toLowerCase()}:${size}`;

    return cached(deps, key, config.referenceCache.airportsTtlSeconds, async () => {
      const { rows } = await deps.pool.query(
        // The city name lives on `cities`, not on `airports`, so the join is
        // not optional: an autocomplete that cannot match "London" is useless.
        `SELECT a.iata_code AS code, a.name, c.name AS city,
                a.country_code AS country, a.timezone
         FROM voyager.airports a
         LEFT JOIN voyager.cities c ON c.id = a.city_id
         WHERE $1 = ''
            OR a.iata_code ILIKE $1 || '%'
            OR c.name ILIKE $1 || '%'
            OR a.name ILIKE '%' || $1 || '%'
         -- An exact code first, then a city match, then anything else: typing
         -- "lon" should offer London before Long Beach.
         --
         -- NULLS LAST on the city clause is load-bearing. The join is a LEFT
         -- join, so an airport with no city row makes that expression NULL,
         -- and a DESC sort puts NULLs first by default -- which ranked
         -- "Barcelonnette" and "Palonegro" above London Heathrow for "LON",
         -- purely because they have no city and matched on the name
         -- substring.
         ORDER BY (a.iata_code ILIKE $1) DESC NULLS LAST,
                  (c.name ILIKE $1 || '%') DESC NULLS LAST,
                  c.popularity_rank NULLS LAST,
                  a.iata_code
         LIMIT $2`,
        [q.trim(), size],
      );
      return { airports: rows };
    });
  });

  app.get('/api/v1/ref/cities', async (request) => {
    const { q = '', limit } = request.query as { q?: string; limit?: string };
    const size = clamp(limit, 8);
    const key = `ref:cities:${q.toLowerCase()}:${size}`;

    return cached(deps, key, config.referenceCache.airportsTtlSeconds, async () => {
      const { rows } = await deps.pool.query(
        `SELECT c.id, c.name, c.country_code AS country, c.region,
                c.popularity_rank AS "popularityRank"
         FROM voyager.cities c
         WHERE $1 = '' OR c.name ILIKE $1 || '%'
         ORDER BY (c.name ILIKE $1 || '%') DESC,
                  c.popularity_rank NULLS LAST,
                  c.name
         LIMIT $2`,
        [q.trim(), size],
      );
      return { cities: rows };
    });
  });

  app.get('/api/v1/ref/airlines', async () =>
    cached(deps, 'ref:airlines', config.referenceCache.airlinesTtlSeconds, async () => {
      const { rows } = await deps.pool.query(
        `SELECT iata_code AS code, name, alliance
         FROM voyager.airlines ORDER BY name`,
      );
      return { airlines: rows };
    }),
  );
}

function clamp(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Read-through cache that fails open in both directions: an unreachable
 * Redis costs a cache, not a page.
 */
async function cached<T>(
  deps: Deps,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const disabled = (await deps.chaos.raw())['redis_disabled'];
  const skip = disabled !== undefined && ['1', 'true', 'yes', 'on'].includes(disabled);

  if (!skip) {
    try {
      const hit = await deps.redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch {
      // fall through to the database
    }
  }

  const fresh = await load();
  if (!skip) {
    try {
      await deps.redis.set(key, JSON.stringify(fresh), 'EX', ttlSeconds);
    } catch {
      // a cache write that fails costs the next caller a query, nothing more
    }
  }
  return fresh;
}
