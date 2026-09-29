/**
 * Consumer of `voyager.bookings.events` on `voyager-loyalty-v1`.
 *
 * Its own consumer group is the point: loyalty can be paused, slowed or broken
 * without touching notification-worker, which is what makes the fan-out shape
 * in Data Streams Monitoring worth looking at.
 */

import { Consumer } from 'kafkajs';

import * as chaos from './chaos';
import { config } from './config';
import { accrue, findFareMultiplier, UnknownBookingError, UnknownUserError } from './db';
import { MalformedEventError, parseEnvelope, readConfirmedBooking } from './events';
import { kafka } from './kafka';
import type { Logger } from './logger';
import { computePoints } from './points';
import { publishPointsAccrued, publishTierUpgraded } from './producer';

const PAUSE_POLL_MS = 1_000;

let consumer: Consumer | null = null;
let pausePoll: NodeJS.Timeout | null = null;
let paused = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleConfirmed(
  envelope: ReturnType<typeof parseEnvelope>,
  logger: Logger,
): Promise<void> {
  const booking = readConfirmedBooking(envelope.payload);

  // Guests have no loyalty account to credit. Not an error, just nothing to do.
  if (!booking.userId) {
    logger.info(
      { event_id: envelope.eventId, booking: { id: booking.bookingId } },
      'Accrual skipped for guest booking',
    );
    return;
  }

  const fareMultiplier = await findFareMultiplier(booking.fareClassCode);

  let result;
  try {
    result = await accrue({
      userId: booking.userId,
      bookingId: booking.bookingId,
      description: `Accrual for booking ${booking.pnr ?? booking.bookingId}`,
      points: (tier) =>
        computePoints({
          eligibleCents: booking.eligibleCents,
          fareMultiplier,
          tier,
        }),
    });
  } catch (error) {
    if (error instanceof UnknownUserError) {
      logger.warn(
        {
          event_id: envelope.eventId,
          booking: { id: booking.bookingId },
          usr: { id: booking.userId },
        },
        'Accrual skipped for unknown user',
      );
      return;
    }
    if (error instanceof UnknownBookingError) {
      logger.warn(
        {
          event_id: envelope.eventId,
          booking: { id: booking.bookingId },
          usr: { id: booking.userId },
        },
        'Accrual skipped for unknown booking',
      );
      return;
    }
    throw error;
  }

  if (result.duplicate) {
    logger.info(
      {
        event_id: envelope.eventId,
        booking: { id: booking.bookingId },
        usr: { id: booking.userId },
        loyalty: { transaction_id: result.transactionId },
      },
      'Accrual already recorded',
    );
    return;
  }

  logger.info(
    {
      event_id: envelope.eventId,
      booking: {
        id: booking.bookingId,
        pnr: booking.pnr,
        product_type: booking.productType,
        total_cents: booking.totalCents,
      },
      usr: { id: booking.userId, tier: result.tierAfter },
      loyalty: {
        transaction_id: result.transactionId,
        points: result.points,
        balance_after: result.balanceAfter,
        lifetime_points: result.lifetimePoints,
        fare_multiplier: fareMultiplier,
      },
      chaos: { active_flags: chaos.activeFlags().join(',') },
    },
    'Points accrued',
  );

  // Publishing happens after the commit: the accrual is the record of truth,
  // and a failed publish must not roll it back or award it twice.
  const accrued = await publishPointsAccrued(
    {
      userId: booking.userId,
      bookingId: booking.bookingId,
      pnr: booking.pnr,
      productType: booking.productType,
      points: result.points,
      balanceAfter: result.balanceAfter,
      lifetimePoints: result.lifetimePoints,
      tier: result.tierAfter,
      currency: booking.currency,
      contactEmail: booking.contactEmail,
    },
    envelope.correlationId,
  );
  if (accrued !== 'sent') {
    logger.warn(
      { event_id: envelope.eventId, outcome: accrued, topic: config.kafka.accrualsTopic },
      'Accrual event not published cleanly',
    );
  }

  if (result.tierAfter !== result.tierBefore) {
    logger.info(
      {
        usr: { id: booking.userId, tier: result.tierAfter },
        loyalty: {
          from_tier: result.tierBefore,
          to_tier: result.tierAfter,
          lifetime_points: result.lifetimePoints,
        },
      },
      'Tier upgraded',
    );
    await publishTierUpgraded(
      {
        userId: booking.userId,
        bookingId: booking.bookingId,
        pnr: booking.pnr,
        fromTier: result.tierBefore,
        toTier: result.tierAfter,
        lifetimePoints: result.lifetimePoints,
        contactEmail: booking.contactEmail,
      },
      envelope.correlationId,
    );
  }
}

export async function startConsumer(logger: Logger): Promise<void> {
  consumer = kafka.consumer({
    groupId: config.kafka.consumerGroup,
    sessionTimeout: 30_000,
    allowAutoTopicCreation: false,
  });

  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.bookingsTopic, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message, partition }) => {
      await chaos.refresh();
      // Per-message processing delay. Real lag on a real consumer group, which
      // is what `kafka_slow_consumer_ms` is for.
      const slow = chaos.getValue('kafka_slow_consumer_ms', 0);
      if (slow > 0) await sleep(slow);

      let envelope;
      try {
        envelope = parseEnvelope(message.value);
      } catch (error) {
        // A poison message is dropped rather than retried forever: this service
        // has no DLQ topic of its own (§ 6), and a stuck partition would stall
        // every later accrual behind it.
        logger.error(
          {
            partition,
            offset: message.offset,
            error: {
              kind: (error as Error).constructor.name,
              message: (error as Error).message,
            },
          },
          'Dropped malformed booking event',
        );
        return;
      }

      if (envelope.eventType !== 'booking.confirmed') return;

      try {
        await handleConfirmed(envelope, logger);
      } catch (error) {
        if (error instanceof MalformedEventError) {
          logger.error(
            {
              partition,
              offset: message.offset,
              event_id: envelope.eventId,
              error: { kind: error.constructor.name, message: error.message },
            },
            'Dropped malformed booking event',
          );
          return;
        }
        // Anything else is transient -- Postgres or Kafka. Rethrow so KafkaJS
        // redelivers rather than silently losing the accrual.
        throw error;
      }
    },
  });

  // `kafka_consumer_pause` names a consumer group. Pausing the subscription is
  // what produces genuine, growing lag; skipping messages would not.
  pausePoll = setInterval(() => {
    void (async () => {
      await chaos.refresh();
      const target = chaos.getValue<string>('kafka_consumer_pause', '');
      const shouldPause = target === config.kafka.consumerGroup;
      if (shouldPause === paused || !consumer) return;

      if (shouldPause) {
        consumer.pause([{ topic: config.kafka.bookingsTopic }]);
      } else {
        consumer.resume([{ topic: config.kafka.bookingsTopic }]);
      }
      paused = shouldPause;
      logger.warn(
        { consumer_group: config.kafka.consumerGroup, paused: shouldPause },
        shouldPause ? 'Consumer paused by chaos flag' : 'Consumer resumed',
      );
    })();
  }, PAUSE_POLL_MS);
}

export async function stopConsumer(): Promise<void> {
  if (pausePoll) clearInterval(pausePoll);
  pausePoll = null;
  await consumer?.disconnect().catch(() => {});
  consumer = null;
}
