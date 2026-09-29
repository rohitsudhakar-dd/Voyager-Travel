/**
 * Asynchronous result delivery.
 *
 * A real PSP tells you the outcome twice: once in the response and again on a
 * webhook, arriving seconds later and possibly out of order. Reproducing that
 * here is what makes payment-service's async path real rather than decorative.
 */

import { createHmac, randomUUID } from 'node:crypto';

import * as chaos from './chaos';
import { config } from './config';
import type { Charge } from './store';
import type { Logger } from './logger';

const MAX_ATTEMPTS = 3;

function signature(body: string): string {
  // Signed with the webhook URL as the shared secret only because this is a
  // mock; the point is that payment-service has a signature header to verify.
  return createHmac('sha256', config.webhookUrl).update(body).digest('hex');
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
    metadata: charge.metadata,
    created_at: charge.createdAt,
    updated_at: charge.updatedAt,
  };
}

async function post(body: string, logger: Logger, eventType: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-payments-signature': signature(body),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        logger.info({ event_type: eventType, attempt }, 'Webhook delivered');
        return;
      }
      logger.warn(
        { event_type: eventType, attempt, status_code: response.status },
        'Webhook rejected by receiver',
      );
    } catch (error) {
      logger.warn(
        {
          event_type: eventType,
          attempt,
          error: { kind: (error as Error).name, message: (error as Error).message },
        },
        'Webhook delivery failed',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  logger.error({ event_type: eventType }, 'Webhook abandoned after retries');
}

/**
 * Schedule delivery 1-3 s out, or at whatever delay `payment_webhook_delay_ms`
 * asks for. Deliberately fire-and-forget: the HTTP response must not wait on
 * it, which is the entire point.
 */
export function scheduleWebhook(charge: Charge, eventType: string, logger: Logger): void {
  const override = chaos.getValue('payment_webhook_delay_ms', 0);
  const delay =
    override > 0
      ? override
      : config.webhookMinDelayMs +
        Math.random() * (config.webhookMaxDelayMs - config.webhookMinDelayMs);

  const body = JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: eventType,
    created_at: new Date().toISOString(),
    data: publicView(charge),
  });

  setTimeout(() => {
    void post(body, logger, eventType);
  }, delay).unref();
}
