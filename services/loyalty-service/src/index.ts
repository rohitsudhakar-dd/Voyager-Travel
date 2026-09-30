/**
 * loyalty-service -- points accrual and tier calculation.
 *
 * Two halves: a Kafka consumer that accrues points when a booking confirms,
 * and a read API the gateway and the AI support tool call. The consumer must
 * never block the booking path, so nothing here is synchronous with checkout
 * (05-FUNCTIONALITY.md § 1).
 */

import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import * as chaos from './chaos';
import { config } from './config';
import { startConsumer, stopConsumer } from './consumer';
import {
  findAccount,
  findAccrualForBooking,
  findFareMultiplier,
  findRecentTransactions,
  ping as pingPostgres,
  pool,
} from './db';
import { NotFoundError, toEnvelope, ValidationError, VoyagerError } from './errors';
import { pingKafka } from './kafka';
import { createLogger } from './logger';
import { closeMetrics, initMetrics } from './metrics';
import { computePoints, nextTier, Tier, tierFor, TIER_EARN_MULTIPLIER } from './points';
import { span, tag } from './tracing';
import { startProducer, stopProducer } from './producer';

const logger = createLogger(config.service, config.env, config.version);
const app = Fastify({
  logger: false,
  bodyLimit: 1_048_576,
  genReqId: () => `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KAFKA_RETRY_MS = 10_000;

// ------------------------------------------------------------------ hooks --

/**
 * `service_latency_ms` and `service_error_rate` are the generic per-service
 * knobs, applied to every route except the probes -- a chaos flag that makes a
 * health check fail would restart the container instead of degrading it.
 */
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health' || request.url === '/ready') return;

  await chaos.refresh();
  await chaos.maybeServiceDelay(config.service);
  if (chaos.maybeServiceFail(config.service)) {
    await reply.code(500).send({
      error: {
        type: 'DependencyError',
        code: 'service_error',
        message: 'The service is temporarily unavailable.',
        details: { injectedBy: 'service_error_rate' },
        requestId: request.id,
        traceId: null,
      },
    });
    return reply;
  }
});

// One request log per request, at completion, as the schema requires.
app.addHook('onResponse', async (request, reply) => {
  if (request.url === '/health') return;
  logger.info(
    {
      http: {
        method: request.method,
        url_details: { path: request.url },
        status_code: reply.statusCode,
        request_id: request.id,
      },
      duration: Math.round(reply.elapsedTime * 1_000_000),
    },
    'Request completed',
  );
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof VoyagerError) {
    return reply.code(error.status).send(toEnvelope(error, String(request.id)));
  }
  logger.error(
    {
      http: { method: request.method, url_details: { path: request.url } },
      error: { kind: error.name, message: error.message, stack: error.stack },
    },
    'Unhandled error',
  );
  return reply.code(500).send({
    error: {
      type: 'VoyagerError',
      code: 'internal_error',
      message: 'Something went wrong. Please try again.',
      details: {},
      requestId: request.id,
      traceId: null,
    },
  });
});

// ----------------------------------------------------------------- health --

app.get('/health', async () => ({
  status: 'ok',
  service: config.service,
  version: config.version,
}));

async function withTimeout(name: string, probe: () => Promise<void>): Promise<[string, string]> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`timed out after ${config.readinessTimeoutMs}ms`)),
      config.readinessTimeoutMs,
    ).unref();
  });
  try {
    await Promise.race([probe(), timeout]);
    return [name, 'ok'];
  } catch (error) {
    return [name, `error: ${(error as Error).message}`];
  }
}

app.get('/ready', async (_request, reply) => {
  const checks = Object.fromEntries(
    await Promise.all([
      withTimeout('postgres', pingPostgres),
      withTimeout('redis', chaos.pingChaosStore),
      withTimeout('kafka', pingKafka),
    ]),
  );
  const ready = Object.values(checks).every((value) => value === 'ok');
  if (!ready) reply.code(503);
  return { status: ready ? 'ready' : 'not_ready', checks };
});

// ---------------------------------------------------------------- loyalty --

app.get('/v1/loyalty/:userId', async (request) => {
  const { userId } = request.params as { userId: string };
  if (!UUID_PATTERN.test(userId)) {
    throw new ValidationError('User id must be a UUID.', { field: 'userId' });
  }

  const account = await findAccount(userId);
  const transactions = account
    ? await findRecentTransactions(userId, config.recentTransactionLimit)
    : [];

  // A member with no accrual yet has no row, which is not an error: loyalty
  // state is derived, and "nothing earned yet" is a valid answer the gateway
  // should not have to special-case.
  const tier = (account?.tier ?? 'standard') as Tier;
  const lifetimePoints = account?.lifetime_points ?? 0;

  return {
    userId,
    pointsBalance: account?.points_balance ?? 0,
    lifetimePoints,
    tier,
    earnMultiplier: TIER_EARN_MULTIPLIER[tier] ?? 1,
    tierQualifiedAt: account?.tier_qualified_at?.toISOString() ?? null,
    nextTier: nextTier(lifetimePoints),
    transactions: transactions.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      type: row.transaction_type,
      points: row.points,
      balanceAfter: row.balance_after,
      description: row.description,
      createdAt: row.created_at.toISOString(),
    })),
  };
});

/**
 * What this spend would earn, for the checkout page (§ 2.7).
 *
 * Calculation only -- it writes nothing and creates no account. A guest has
 * no tier, so they are quoted the standard rate, which is what they would
 * actually earn if they signed up at the end of checkout.
 */
app.post('/v1/loyalty/preview', async (request) => {
  const body = (request.body ?? {}) as {
    userId?: string | null;
    amountCents?: number;
    taxesCents?: number;
    fareClassCode?: string | null;
    currency?: string;
  };

  const amountCents = Number(body.amountCents ?? 0);
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    throw new ValidationError('amountCents must be a positive whole number.', {
      field: 'amountCents',
    });
  }
  if (body.userId && !UUID_PATTERN.test(body.userId)) {
    throw new ValidationError('User id must be a UUID.', { field: 'userId' });
  }

  // Taxes never earn. When the caller does not break them out we have to
  // quote on the whole amount, which over-quotes slightly -- so the response
  // says which of the two it did.
  const taxesCents = Number(body.taxesCents ?? 0);
  const eligibleCents = Math.max(amountCents - (Number.isFinite(taxesCents) ? taxesCents : 0), 0);

  const account = body.userId ? await findAccount(body.userId) : null;
  const tier = (account?.tier ?? 'standard') as Tier;
  const lifetimePoints = account?.lifetime_points ?? 0;
  const fareMultiplier = await findFareMultiplier(body.fareClassCode ?? null);

  const points = span('loyalty.compute_points', () =>
    computePoints({ eligibleCents, fareMultiplier, tier }),
  );

  tag({
    'usr.tier': tier,
    ...(body.userId ? { 'usr.id': body.userId } : {}),
  });

  return {
    userId: body.userId ?? null,
    currency: body.currency ?? 'GBP',
    eligibleCents,
    taxesExcluded: taxesCents > 0,
    pointsToEarn: points,
    tier,
    earnMultiplier: TIER_EARN_MULTIPLIER[tier] ?? 1,
    fareMultiplier,
    // What the booking would leave them on, which is the interesting half of
    // the widget: "this trip takes you to silver".
    tierAfter: tierFor(lifetimePoints + points),
    nextTier: nextTier(lifetimePoints + points),
  };
});

/**
 * The accrual recorded for one booking (§ 2.7).
 *
 * Accrual is asynchronous, so a booking confirmed a moment ago legitimately
 * has none yet. That is `{accrual: null}`, not a 404 -- the confirmation page
 * polls this, and a 404 would have it render an error for a second.
 */
app.get('/v1/loyalty/:userId/accruals/:bookingId', async (request) => {
  const { userId, bookingId } = request.params as Record<string, string>;
  for (const [field, value] of [
    ['userId', userId],
    ['bookingId', bookingId],
  ] as const) {
    if (!UUID_PATTERN.test(value)) {
      throw new ValidationError(`${field} must be a UUID.`, { field });
    }
  }

  const row = await findAccrualForBooking(userId, bookingId);
  return {
    userId,
    bookingId,
    accrual: row
      ? {
          id: row.id,
          type: row.transaction_type,
          points: row.points,
          balanceAfter: row.balance_after,
          description: row.description,
          createdAt: row.created_at.toISOString(),
        }
      : null,
  };
});

// A 404 on an unknown route still has to speak the § 13.2 envelope.
app.setNotFoundHandler(async (request, reply) => {
  const error = new NotFoundError('That resource does not exist.', {
    path: request.url,
  });
  return reply.code(error.status).send(toEnvelope(error, String(request.id)));
});

// ------------------------------------------------------------------ boot --

/**
 * Kafka is allowed to be absent at boot. The HTTP surface comes up first so the
 * container reports healthy and `/ready` tells the truth about the broker,
 * rather than crash-looping until the broker is elected.
 */
function connectKafkaInBackground(): void {
  let attempt = 0;
  const attach = async (): Promise<void> => {
    attempt += 1;
    try {
      await startProducer();
      await startConsumer(logger);
      logger.info(
        {
          consumer_group: config.kafka.consumerGroup,
          topics: [config.kafka.bookingsTopic, config.kafka.accrualsTopic],
          attempt,
        },
        'Kafka attached',
      );
    } catch (error) {
      logger.warn(
        {
          attempt,
          retry_in_ms: KAFKA_RETRY_MS,
          error: { kind: (error as Error).name, message: (error as Error).message },
        },
        'Kafka attach failed',
      );
      await stopConsumer();
      await stopProducer();
      setTimeout(() => void attach(), KAFKA_RETRY_MS).unref();
    }
  };
  void attach();
}

async function start(): Promise<void> {
  initMetrics(logger);
  chaos.initChaos(config.redisUrl);
  await app.listen({ port: config.port, host: config.host });
  connectKafkaInBackground();

  logger.info(
    {
      port: config.port,
      consumer_group: config.kafka.consumerGroup,
      kafka_brokers: config.kafka.brokers,
      postgres_host: config.postgres.host,
      postgres_user: config.postgres.user,
      redis_url: config.redisUrl,
    },
    'Service started',
  );
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await stopConsumer();
    await stopProducer();
    await chaos.closeChaos();
    closeMetrics();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

start().catch((error) => {
  logger.error(
    { error: { kind: error?.constructor?.name, message: error?.message } },
    'Service failed to start',
  );
  process.exit(1);
});
