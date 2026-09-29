/**
 * The admin control plane (05-FUNCTIONALITY.md § 2.8).
 *
 * Everything here is gated by the X-Voyager-Admin header. The gate is checked
 * in one hook rather than per route, so a new admin endpoint cannot be added
 * unprotected by accident.
 */

import type { FastifyInstance } from 'fastify';

import { requireAdmin } from '../auth';
import { UnknownChaosFlagError, UnknownScenarioError, ValidationError } from '../errors';
import { callService, gather, type Upstream } from '../http';
import { config } from '../config';
import { FLAGS, SCENARIOS, flag, scenario, validate } from '../admin/catalogue';
import { reportedVersion, type Deps } from '../deps';
import { log } from '../logger';

const ACTIVE_SCENARIO_KEY = 'voyager:chaos:active_scenario';
const LOADGEN_KEY = 'voyager:loadgen';

/** Every service that /admin/status aggregates, and where to reach it. */
const MONITORED: Array<{ name: string; upstream: Upstream }> = [
  { name: 'voyager-search', upstream: 'search' },
  { name: 'voyager-pricing', upstream: 'pricing' },
  { name: 'voyager-booking', upstream: 'booking' },
  { name: 'voyager-payment', upstream: 'payment' },
  { name: 'voyager-loyalty', upstream: 'loyalty' },
  { name: 'voyager-notifications', upstream: 'notifications' },
  { name: 'voyager-ai-support', upstream: 'aiSupport' },
];

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * The chaos view, identical everywhere it appears.
   *
   * GET, PUT, apply and revert all return this same shape so a client can
   * render the result of a change without re-fetching -- and so an operator
   * reading a PUT response sees the active scenario rather than a view that
   * looks like it just cleared one.
   */
  const view = async () => ({
    flags: await deps.chaos.describe(),
    activeScenario: await deps.redis.get(ACTIVE_SCENARIO_KEY),
    groups: [...new Set(FLAGS.map((definition) => definition.group))],
  });

  app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      requireAdmin(request);
    });

    // ------------------------------------------------------------ chaos --

    admin.get('/api/v1/admin/chaos', async () => view());

    admin.put('/api/v1/admin/chaos', async (request) => {
      const updates = (request.body ?? {}) as Record<string, unknown>;
      if (Object.keys(updates).length === 0) {
        throw new ValidationError('Send at least one flag to change.');
      }

      const unknown = Object.keys(updates).filter((name) => !flag(name));
      if (unknown.length > 0) throw new UnknownChaosFlagError(unknown);

      const rejected: Record<string, string> = {};
      for (const [name, value] of Object.entries(updates)) {
        // null means "put this one back to its default", so it is always legal.
        if (value === null) continue;
        const reason = validate(flag(name)!, value);
        if (reason) rejected[name] = reason;
      }
      if (Object.keys(rejected).length > 0) {
        throw new ValidationError('Some values are out of range.', rejected);
      }

      await deps.chaos.apply(updates);
      log.warn({ chaos: { changed: Object.keys(updates) } }, 'Chaos flags changed');

      return { ...(await view()), applied: Object.keys(updates) };
    });

    admin.post('/api/v1/admin/chaos/reset', async () => {
      const outcome = await deps.chaos.reset();
      await deps.redis.del(ACTIVE_SCENARIO_KEY);
      // A version override is part of the chaos story (S6), so it clears too.
      deps.versionOverride = null;
      return { status: 'reset', ...outcome, ...(await view()) };
    });

    // -------------------------------------------------------- scenarios --

    admin.get('/api/v1/admin/scenarios', async () => ({
      scenarios: SCENARIOS,
      active: await deps.redis.get(ACTIVE_SCENARIO_KEY),
    }));

    admin.post('/api/v1/admin/scenarios/:id/apply', async (request) => {
      const { id } = request.params as { id: string };
      const definition = scenario(id);
      if (!definition) throw new UnknownScenarioError(id);

      // § 2.8 says apply resets first. Without that, applying S3 on top of S1
      // leaves the GDS still degraded and the story becomes two stories.
      await deps.chaos.reset();
      await deps.chaos.apply(definition.flags);
      await deps.redis.set(ACTIVE_SCENARIO_KEY, definition.id);

      if (definition.flags.version_override) {
        deps.versionOverride = String(definition.flags.version_override);
      }

      log.warn(
        { chaos: { scenario: definition.id, flags: Object.keys(definition.flags) } },
        'Scenario applied',
      );
      return { status: 'applied', scenario: definition, ...(await view()) };
    });

    admin.post('/api/v1/admin/scenarios/:id/revert', async (request) => {
      const { id } = request.params as { id: string };
      const definition = scenario(id);
      if (!definition) throw new UnknownScenarioError(id);

      // Revert clears only this scenario's flags, so two scenarios running
      // together can be unwound one at a time.
      const cleared = Object.fromEntries(
        Object.keys(definition.flags).map((name) => [name, null]),
      );
      await deps.chaos.apply(cleared);
      if (definition.flags.version_override) deps.versionOverride = null;

      const active = await deps.redis.get(ACTIVE_SCENARIO_KEY);
      if (active === definition.id) await deps.redis.del(ACTIVE_SCENARIO_KEY);

      return { status: 'reverted', scenario: definition.id, ...(await view()) };
    });

    // ----------------------------------------------------------- status --

    admin.get('/api/v1/admin/status', async (request) => {
      const checks = await Promise.all(
        MONITORED.map(async (target) => {
          const startedAt = process.hrtime.bigint();
          try {
            const result = await callService<Record<string, unknown>>(target.upstream, {
              path: '/ready',
              requestId: request.id,
              timeoutMs: 3000,
            });
            return {
              service: target.name,
              status: 'ready',
              latencyMs: elapsedMs(startedAt),
              checks: result.body.checks ?? null,
            };
          } catch (error) {
            return {
              service: target.name,
              status: 'unreachable',
              latencyMs: elapsedMs(startedAt),
              error: (error as Error).message,
            };
          }
        }),
      );

      const vitals = await gather({
        postgres: postgresVitals(deps),
        redis: redisVitals(deps),
      });

      return {
        gateway: {
          service: config.service,
          version: reportedVersion(deps),
          env: config.env,
        },
        services: checks,
        healthy: checks.every((check) => check.status === 'ready'),
        vitals: vitals.results,
        activeFlags: await deps.chaos.activeFlags(),
        activeScenario: await deps.redis.get(ACTIVE_SCENARIO_KEY),
      };
    });

    // ---------------------------------------------------------- loadgen --

    admin.post('/api/v1/admin/loadgen', async (request) => {
      const body = (request.body ?? {}) as Record<string, Record<string, unknown>>;
      const settings = {
        api: {
          enabled: Boolean(body.api?.enabled ?? true),
          intensity: Number(body.api?.intensity ?? 1),
        },
        browser: {
          enabled: Boolean(body.browser?.enabled ?? true),
          concurrency: Number(body.browser?.concurrency ?? 2),
        },
      };
      // The generators read this key on their own cadence; Phase 11 builds
      // them. Writing it now keeps the admin contract stable.
      await deps.redis.set(LOADGEN_KEY, JSON.stringify(settings));
      return { status: 'updated', loadgen: settings };
    });

    // ------------------------------------------------------------- seed --

    admin.post('/api/v1/admin/seed/reset', async () => {
      // Re-seeding runs as a Compose job, not inside this process. Returning
      // a job id rather than pretending to do the work keeps the contract
      // honest until Phase 11 wires the runner.
      const jobId = `seed_${Date.now().toString(36)}`;
      await deps.redis.set(`voyager:seed:${jobId}`, 'queued', 'EX', 3600);
      return {
        status: 'queued',
        jobId,
        note: 'Run `make seed` on the host to execute the queued reseed.',
      };
    });

    // ---------------------------------------------------------- version --

    admin.post('/api/v1/admin/version', async (request) => {
      const body = (request.body ?? {}) as { version?: string };
      if (!body.version) throw new ValidationError('version is required.');

      // S6 fakes a deploy. The override also goes in the chaos hash so the
      // other services see it on their next refresh, without a restart.
      deps.versionOverride = body.version;
      await deps.chaos.apply({ version_override: body.version });

      log.warn({ version: body.version }, 'Version override set');
      return { status: 'overridden', version: body.version };
    });
  });
}

function elapsedMs(startedAt: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

async function postgresVitals(deps: Deps): Promise<Record<string, unknown>> {
  const { rows } = await deps.pool.query(
    `SELECT
       (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())
         AS connections,
       (SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock')
         AS waiting_on_locks,
       (SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'voyager'
          AND indexname = 'idx_bookings_user_id_created_at')
         AS bookings_index_present`,
  );
  return rows[0];
}

async function redisVitals(deps: Deps): Promise<Record<string, unknown>> {
  const info = await deps.redis.info('memory');
  const used = /used_memory_human:(\S+)/.exec(info)?.[1];
  return { usedMemory: used ?? null, chaosKeys: (await deps.chaos.activeFlags()).length };
}
