/**
 * Producer for `voyager.loyalty.accruals` (`points.accrued`, `tier.upgraded`).
 *
 * Keyed by `user_id`, as the topic table requires, so a user's accrual and the
 * tier upgrade it triggered stay in order on the same partition.
 */

import { Producer } from 'kafkajs';

import * as chaos from './chaos';
import { config } from './config';
import { buildEnvelope } from './events';
import { kafka } from './kafka';

/**
 * `kafka_poison_rate` emits a malformed message instead of the real one. It has
 * to be genuinely unparseable for notification-worker's DLQ path to be worth
 * demonstrating, so it is truncated JSON rather than a valid object with a
 * field missing. The accrual itself is already committed to Postgres, so this
 * costs a notification and never a point.
 */
const POISON_VALUE = Buffer.from('{"eventType":"points.accrued","payload":');

export type PublishOutcome = 'sent' | 'poisoned' | 'suppressed';

let producer: Producer | null = null;

export async function startProducer(): Promise<void> {
  producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
}

export async function stopProducer(): Promise<void> {
  await producer?.disconnect().catch(() => {});
  producer = null;
}

async function publish(
  eventType: string,
  userId: string,
  payload: Record<string, unknown>,
  correlationId: string | null,
): Promise<PublishOutcome> {
  if (!producer) throw new Error('Producer is not connected.');

  if (chaos.maybeFail('kafka_producer_error_rate')) return 'suppressed';

  const poisoned = chaos.maybeFail('kafka_poison_rate');
  const value = poisoned
    ? POISON_VALUE
    : Buffer.from(JSON.stringify(buildEnvelope(eventType, payload, correlationId)));

  await producer.send({
    topic: config.kafka.accrualsTopic,
    messages: [{ key: userId, value }],
  });

  return poisoned ? 'poisoned' : 'sent';
}

export interface PointsAccruedPayload extends Record<string, unknown> {
  userId: string;
  bookingId: string;
  pnr: string | null;
  productType: string;
  points: number;
  balanceAfter: number;
  lifetimePoints: number;
  tier: string;
  currency: string;
  contactEmail: string | null;
}

export function publishPointsAccrued(
  payload: PointsAccruedPayload,
  correlationId: string | null,
): Promise<PublishOutcome> {
  return publish('points.accrued', payload.userId, payload, correlationId);
}

export interface TierUpgradedPayload extends Record<string, unknown> {
  userId: string;
  bookingId: string;
  pnr: string | null;
  fromTier: string;
  toTier: string;
  lifetimePoints: number;
  contactEmail: string | null;
}

export function publishTierUpgraded(
  payload: TierUpgradedPayload,
  correlationId: string | null,
): Promise<PublishOutcome> {
  return publish('tier.upgraded', payload.userId, payload, correlationId);
}
