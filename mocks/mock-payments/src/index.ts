/**
 * mock-payments -- simulated payment service provider.
 *
 * Contracts are in 05-FUNCTIONALITY.md § 5.2. Two distinctions matter more
 * than anything else here:
 *
 *  - a decline is a business outcome and returns 200 with a decline code;
 *  - an error is an infrastructure failure and returns 5xx.
 *
 * Conflating them is the classic modelling mistake in payment systems, and
 * keeping them apart is what makes the Error Tracking demo sharp.
 *
 * Card numbers and CVCs are read, used, and dropped. Only `card_last4` and
 * `card_brand` are ever stored or logged.
 */

import { createHash, randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import { brandFor, lastFour, luhnValid, normalizeCardNumber, pickDeclineCode, DECLINE_MESSAGES, testCardOutcome } from './cards';
import * as chaos from './chaos';
import { config } from './config';
import { createLogger } from './logger';
import {
  Charge,
  getCharge,
  lookupIdempotency,
  putCharge,
  rememberIdempotency,
  stats,
  sweepIdempotency,
  updateCharge,
} from './store';
import { scheduleWebhook } from './webhook';

const logger = createLogger(config.service, config.env, config.version);
const app = Fastify({ logger: false, bodyLimit: 262_144 });

interface CardInput {
  number?: string;
  exp_month?: number;
  exp_year?: number;
  cvc?: string;
  name?: string;
}

interface ChargeBody {
  amount?: number;
  currency?: string;
  card?: CardInput;
  idempotency_key?: string;
  capture?: boolean;
  metadata?: Record<string, unknown>;
}

function chargeId(): string {
  return `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Hash of the parts of the request that define the charge. The card number
 * is hashed, never retained -- two requests with the same key must be
 * comparable without keeping a PAN around to compare against.
 */
function requestFingerprint(body: ChargeBody): string {
  const digits = normalizeCardNumber(body.card?.number ?? '');
  return createHash('sha256')
    .update(
      JSON.stringify({
        amount: body.amount,
        currency: body.currency,
        card: createHash('sha256').update(digits).digest('hex'),
        metadata: body.metadata ?? {},
      }),
    )
    .digest('hex');
}

function publicView(charge: Charge) {
  return {
    id: charge.id,
    status: charge.status,
    amount: charge.amount,
    currency: charge.currency,
    captured_amount: charge.capturedAmount,
    refunded_amount: charge.refundedAmount,
    card: charge.card,
    decline_code: charge.declineCode,
    failure_message: charge.failureMessage,
    requires_3ds: charge.status === 'requires_3ds',
    three_ds: charge.threeDsToken
      ? {
          challenge_token: charge.threeDsToken,
          challenge_url: `/v1/charges/${charge.id}/3ds/complete`,
        }
      : null,
    metadata: charge.metadata,
    created_at: charge.createdAt,
    updated_at: charge.updatedAt,
  };
}

// ------------------------------------------------------------------ health --

app.get('/health', async () => ({
  status: 'ok',
  service: config.service,
  version: config.version,
  ...stats(),
}));

app.get('/ready', async () => ({ status: 'ready' }));

// ----------------------------------------------------------------- charges --

app.post('/v1/charges', async (request, reply) => {
  await chaos.refresh();
  await chaos.maybeDelay('payment_latency_ms');

  const body = (request.body ?? {}) as ChargeBody;
  const headerKey = request.headers['idempotency-key'];
  const idempotencyKey =
    (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? body.idempotency_key;

  if (!idempotencyKey) {
    return reply.code(422).send({
      error: { type: 'invalid_request', message: 'An idempotency key is required.' },
    });
  }
  if (body.idempotency_key && idempotencyKey !== body.idempotency_key) {
    return reply.code(422).send({
      error: {
        type: 'invalid_request',
        message: 'Idempotency-Key header and idempotency_key body field must match.',
      },
    });
  }

  const fingerprint = requestFingerprint(body);
  const replay = lookupIdempotency(idempotencyKey, fingerprint);
  if (replay.kind === 'conflict') {
    return reply.code(409).send({
      error: {
        type: 'idempotency_conflict',
        message: 'This idempotency key was already used with a different request.',
      },
    });
  }
  if (replay.kind === 'replay') {
    logger.info({ idempotency_key: idempotencyKey }, 'Idempotent replay served');
    return reply.code(replay.statusCode).header('Idempotent-Replay', 'true').send(replay.body);
  }

  const digits = normalizeCardNumber(body.card?.number ?? '');
  if (
    typeof body.amount !== 'number' ||
    body.amount <= 0 ||
    !body.currency ||
    !digits ||
    !body.card?.exp_month ||
    !body.card?.exp_year
  ) {
    return reply.code(422).send({
      error: {
        type: 'invalid_request',
        message: 'amount, currency and a complete card are required.',
      },
    });
  }

  const outcome = testCardOutcome(digits);
  if (outcome.kind === 'unknown' && !luhnValid(digits)) {
    return reply
      .code(422)
      .send({ error: { type: 'invalid_request', message: 'Card number is not valid.' } });
  }

  const card = {
    last4: lastFour(digits),
    brand: brandFor(digits),
    expMonth: body.card.exp_month,
    expYear: body.card.exp_year,
  };

  // Infrastructure failure: 5xx, no charge recorded, nothing to replay.
  const chaosErrorRate = chaos.getValue('payment_error_rate', 0);
  if (outcome.kind === 'error' || (chaosErrorRate > 0 && Math.random() < chaosErrorRate)) {
    logger.error(
      { card_last4: card.last4, card_brand: card.brand, amount: body.amount },
      'Charge failed at the provider',
    );
    return reply.code(500).send({
      error: {
        type: 'provider_error',
        message: 'The payment provider could not process this request.',
      },
    });
  }

  const now = new Date().toISOString();
  const charge: Charge = {
    id: chargeId(),
    status: 'authorized',
    amount: body.amount,
    currency: body.currency,
    capturedAmount: 0,
    refundedAmount: 0,
    card,
    declineCode: null,
    failureMessage: null,
    metadata: body.metadata ?? {},
    threeDsToken: null,
    createdAt: now,
    updatedAt: now,
  };

  if (outcome.kind === 'requires_3ds') {
    charge.status = 'requires_3ds';
    charge.threeDsToken = randomUUID();
  } else if (outcome.kind === 'decline') {
    charge.status = 'declined';
    charge.declineCode = outcome.code;
    charge.failureMessage = DECLINE_MESSAGES[outcome.code];
  } else if (outcome.kind !== 'approve') {
    // Not a test card: the probabilistic path.
    const declineRate = chaos.getValue('payment_decline_rate', config.baselineDeclineRate);
    if (Math.random() < declineRate) {
      const code = pickDeclineCode(chaos.getValue('payment_decline_mix', 'mixed'));
      charge.status = 'declined';
      charge.declineCode = code;
      charge.failureMessage = DECLINE_MESSAGES[code];
    }
  }

  if (charge.status === 'authorized' && body.capture) {
    charge.status = 'captured';
    charge.capturedAmount = charge.amount;
  }

  putCharge(charge);
  const view = publicView(charge);
  rememberIdempotency(idempotencyKey, fingerprint, 200, view);

  logger.info(
    {
      charge_id: charge.id,
      status: charge.status,
      decline_code: charge.declineCode,
      amount: charge.amount,
      currency: charge.currency,
      card_last4: charge.card.last4,
      card_brand: charge.card.brand,
    },
    'Charge processed',
  );

  if (charge.status === 'authorized' || charge.status === 'captured') {
    scheduleWebhook(charge, 'charge.authorized', logger);
  } else if (charge.status === 'declined') {
    scheduleWebhook(charge, 'charge.declined', logger);
  }

  return reply.send(view);
});

app.get('/v1/charges/:id', async (request, reply) => {
  await chaos.refresh();
  const { id } = request.params as { id: string };
  const charge = getCharge(id);
  if (!charge) {
    return reply
      .code(404)
      .send({ error: { type: 'not_found', message: 'Unknown charge.' } });
  }
  return reply.send(publicView(charge));
});

app.post('/v1/charges/:id/capture', async (request, reply) => {
  await chaos.refresh();
  await chaos.maybeDelay('payment_latency_ms');

  const { id } = request.params as { id: string };
  const body = (request.body ?? {}) as { amount?: number };
  const charge = getCharge(id);
  if (!charge) {
    return reply
      .code(404)
      .send({ error: { type: 'not_found', message: 'Unknown charge.' } });
  }
  if (charge.status !== 'authorized') {
    return reply.code(409).send({
      error: {
        type: 'invalid_state',
        message: `A charge in state ${charge.status} cannot be captured.`,
      },
    });
  }

  const amount = body.amount ?? charge.amount;
  if (amount <= 0 || amount > charge.amount) {
    return reply.code(422).send({
      error: { type: 'invalid_request', message: 'Capture amount is out of range.' },
    });
  }

  const updated = updateCharge(id, { status: 'captured', capturedAmount: amount })!;
  logger.info({ charge_id: id, amount }, 'Charge captured');
  scheduleWebhook(updated, 'charge.captured', logger);
  return reply.send(publicView(updated));
});

app.post('/v1/charges/:id/refund', async (request, reply) => {
  await chaos.refresh();
  await chaos.maybeDelay('payment_latency_ms');

  const { id } = request.params as { id: string };
  const body = (request.body ?? {}) as { amount?: number };
  const charge = getCharge(id);
  if (!charge) {
    return reply
      .code(404)
      .send({ error: { type: 'not_found', message: 'Unknown charge.' } });
  }
  if (charge.status !== 'captured' && charge.status !== 'partially_refunded') {
    return reply.code(409).send({
      error: {
        type: 'invalid_state',
        message: `A charge in state ${charge.status} cannot be refunded.`,
      },
    });
  }

  const refundable = charge.capturedAmount - charge.refundedAmount;
  const amount = body.amount ?? refundable;
  if (amount <= 0 || amount > refundable) {
    return reply.code(422).send({
      error: {
        type: 'invalid_request',
        message: `Refund amount exceeds the ${refundable} still refundable.`,
      },
    });
  }

  const refundedAmount = charge.refundedAmount + amount;
  const updated = updateCharge(id, {
    refundedAmount,
    status: refundedAmount >= charge.capturedAmount ? 'refunded' : 'partially_refunded',
  })!;
  logger.info({ charge_id: id, amount, status: updated.status }, 'Charge refunded');
  scheduleWebhook(updated, 'charge.refunded', logger);
  return reply.send(publicView(updated));
});

app.post('/v1/charges/:id/3ds/complete', async (request, reply) => {
  await chaos.refresh();
  await chaos.maybeDelay('payment_latency_ms');

  const { id } = request.params as { id: string };
  const body = (request.body ?? {}) as { challengeResponse?: string };
  const charge = getCharge(id);
  if (!charge) {
    return reply
      .code(404)
      .send({ error: { type: 'not_found', message: 'Unknown charge.' } });
  }
  if (charge.status !== 'requires_3ds') {
    return reply.code(409).send({
      error: {
        type: 'invalid_state',
        message: `Charge ${id} is not awaiting a 3-D Secure challenge.`,
      },
    });
  }
  if (!body.challengeResponse) {
    return reply.code(422).send({
      error: { type: 'invalid_request', message: 'challengeResponse is required.' },
    });
  }

  // Any non-empty response other than the literal "fail" passes. A demo needs
  // both branches reachable from the UI without a second test card.
  const passed = body.challengeResponse.toLowerCase() !== 'fail';
  const updated = passed
    ? updateCharge(id, { status: 'authorized', threeDsToken: null })!
    : updateCharge(id, {
        status: 'declined',
        declineCode: 'do_not_honor',
        failureMessage: 'Authentication failed.',
        threeDsToken: null,
      })!;

  logger.info({ charge_id: id, status: updated.status }, '3-D Secure challenge completed');
  scheduleWebhook(updated, passed ? 'charge.authorized' : 'charge.declined', logger);
  return reply.send(publicView(updated));
});

// ------------------------------------------------------------------- boot --

async function start(): Promise<void> {
  chaos.initChaos(config.redisUrl);
  setInterval(() => {
    const removed = sweepIdempotency();
    if (removed > 0) logger.info({ removed }, 'Expired idempotency keys swept');
  }, 60 * 60 * 1_000).unref();

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    {
      port: config.port,
      webhook_url: config.webhookUrl,
      baseline_decline_rate: config.baselineDeclineRate,
    },
    'Service started',
  );
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await chaos.closeChaos();
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
