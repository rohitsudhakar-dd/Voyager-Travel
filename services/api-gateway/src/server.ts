/**
 * api-gateway: Voyager's public API.
 *
 * Auth, reference data, pass-through routes, the BFF aggregation endpoints,
 * and the admin control plane that drives every chaos scenario.
 */

import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { principalOf } from './auth';
import { config, redacted } from './config';
import { closeDeps, createDeps, reportedVersion } from './deps';
import { VoyagerError } from './errors';
import { log } from './logger';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerBffRoutes } from './routes/bff';
import { registerProxyRoutes } from './routes/proxy';
import { registerReferenceRoutes } from './routes/reference';
import { tag } from './tracing';

/** Liveness probes fire every ten seconds; logging them buries real traffic. */
const QUIET_PATHS = new Set(['/health', '/ready']);

async function main(): Promise<void> {
  const deps = createDeps();

  const app = Fastify({
    logger: false,
    trustProxy: true,
    // One id, generated here or taken from the caller, threaded through every
    // downstream call and every log line.
    genReqId: (request) =>
      (request.headers['x-request-id'] as string) ?? `req_${randomBytes(12).toString('hex')}`,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    // The API serves JSON to a separate origin, so CSP here would only ever
    // constrain the docs page. The frontend's own CSP is set by Caddy.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      'idempotency-key',
      'x-request-id',
      'x-voyager-admin',
    ],
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // Health checks and the admin surface are exempt: throttling the control
    // plane during an incident is exactly backwards.
    allowList: (request) =>
      QUIET_PATHS.has(request.url) || request.url.startsWith('/api/v1/admin'),
  });

  app.addHook('onRequest', async (request) => {
    (request as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
    if (QUIET_PATHS.has(request.url)) return;

    // Tagged here rather than in onResponse because dd-trace finishes the
    // request span from its own onResponse hook, and a tag written to a
    // finished span is dropped without complaint.
    //
    // The gateway is the entry point, so these two land on the trace root and
    // become facets for everything downstream: "every trace for this user",
    // "every trace taken while payment_decline_rate was up".
    const principal = principalOf(request);
    tag({
      'chaos.active_flags': (await deps.chaos.activeFlags()).join(','),
      ...(principal ? { 'usr.id': principal.id, 'usr.tier': principal.tier } : {}),
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  // § 12: exactly one request-completion line per request, from one place.
  app.addHook('onResponse', async (request, reply) => {
    if (QUIET_PATHS.has(request.url)) return;
    const startedAt = (request as { startedAt?: bigint }).startedAt;
    log.info(
      {
        http: {
          method: request.method,
          url_details: { path: request.routeOptions?.url ?? request.url },
          status_code: reply.statusCode,
          request_id: request.id,
        },
        duration: startedAt ? Number(process.hrtime.bigint() - startedAt) : 0,
        chaos: { active_flags: (await deps.chaos.activeFlags()).join(',') },
      },
      'Request completed',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof VoyagerError) {
      const level = error.status >= 500 ? 'error' : 'warn';
      log[level](
        { error: { kind: error.type, message: error.message }, request_id: request.id },
        'Request failed',
      );
      reply.code(error.status).send(error.envelope(request.id));
      return;
    }

    // Fastify's own errors (validation, rate limit, payload size) arrive with
    // a statusCode; anything else is genuinely ours and is a 500.
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    log[status >= 500 ? 'error' : 'warn'](
      {
        error: { kind: error.name || 'InternalError', message: error.message, stack: error.stack },
        request_id: request.id,
      },
      'Request failed',
    );
    reply.code(status).send(
      new VoyagerError(
        status >= 500 ? 'Something went wrong on our side.' : error.message,
        status,
        status === 429 ? 'rate_limited' : 'internal_error',
      ).envelope(request.id),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(new VoyagerError('No such endpoint.', 404, 'not_found').envelope(request.id));
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: config.service,
    version: reportedVersion(deps),
  }));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};

    try {
      await deps.redis.ping();
      checks.redis = 'ok';
    } catch (error) {
      checks.redis = `error: ${(error as Error).message}`;
    }

    try {
      await deps.pool.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (error) {
      checks.postgres = `error: ${(error as Error).message}`;
    }

    const ready = Object.values(checks).every((value) => value === 'ok');
    if (!ready) reply.code(503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });

  registerAuthRoutes(app, deps);
  registerReferenceRoutes(app, deps);
  registerProxyRoutes(app, deps);
  registerBffRoutes(app, deps);
  registerAdminRoutes(app, deps);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await app.close();
    await closeDeps(deps);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ config: redacted() }, 'Service started');
}

main().catch((error) => {
  log.error(
    { error: { kind: error?.name ?? 'StartupError', message: error?.message } },
    'Service failed to start',
  );
  process.exit(1);
});
