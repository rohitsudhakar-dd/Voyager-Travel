/**
 * `GET /api/v1/chaos/frontend` -- the storefront's read-only view of the four
 * browser chaos flags (05-FUNCTIONALITY.md § 2.9).
 *
 * The rest of the chaos surface is admin-gated and has to stay that way: it can
 * drop an index, shrink a connection pool and pause a consumer group. But the
 * four `frontend_*` flags are only ever *read*, and only by a browser, and a
 * storefront tab has no business holding ADMIN_SECRET. Without this projection
 * those four flags cannot fire in a real session at all -- which is what the
 * Phase 7 report found, and why scenario S8 had nothing to act on.
 *
 * Two properties matter more than the handler's length:
 *
 *   1. It is narrow by construction. The four names are listed here rather than
 *      filtered out of the catalogue by group, so adding a flag -- or putting an
 *      existing one in the Frontend group by mistake -- cannot widen it.
 *   2. It fails open, like every other chaos reader in the stack. An unreachable
 *      Redis answers "all off" rather than 500, because a cache hiccup must not
 *      take the storefront's render path down with it.
 */

import type { FastifyInstance } from 'fastify';

import { coerce, flag } from '../admin/catalogue';
import type { Deps } from '../deps';

const FRONTEND_FLAGS = [
  'frontend_heavy_assets',
  'frontend_blocking_js',
  'frontend_js_error_rate',
  'frontend_layout_shift',
] as const;

export function registerChaosRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/chaos/frontend', async (_request, reply) => {
    let stored: Record<string, string> = {};
    try {
      stored = await deps.chaos.raw();
    } catch {
      /* fail open */
    }

    const flags: Record<string, boolean | number> = {};
    for (const name of FRONTEND_FLAGS) {
      const definition = flag(name);
      if (!definition) continue;
      flags[name] = coerce(definition, stored[name]) as boolean | number;
    }

    // The browser polls this on a five-second cadence and a cached answer would
    // make a toggle look like it did nothing.
    reply.header('cache-control', 'no-store');
    return { flags };
  });
}
