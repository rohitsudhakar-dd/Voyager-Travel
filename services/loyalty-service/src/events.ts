/**
 * The shared Kafka envelope (05-FUNCTIONALITY.md § 6.1) plus the projection of
 * `booking.confirmed` that accrual needs.
 *
 * Reading is deliberately tolerant: snake_case keys are accepted alongside the
 * camelCase the envelope specifies, and a missing fare class degrades to a
 * multiplier of 1.0 rather than dropping the message. A consumer that throws
 * on an unexpected-but-harmless field shape is a consumer that stops the
 * partition for no good reason.
 *
 * Datadog trace context travels in the message *headers*, not here. The
 * `traceId` field is for human debugging and log correlation only.
 */

import { randomUUID } from 'node:crypto';

import { config } from './config';

export interface Envelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  producer: string;
  traceId: string | null;
  correlationId: string | null;
  payload: T;
}

export class MalformedEventError extends Error {}

export function parseEnvelope(raw: Buffer | string | null): Envelope {
  if (raw === null) throw new MalformedEventError('Message has no value.');

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new MalformedEventError('Message is not valid JSON.');
  }
  if (typeof decoded !== 'object' || decoded === null) {
    throw new MalformedEventError('Message is not an object.');
  }

  const candidate = decoded as Partial<Envelope>;
  if (typeof candidate.eventType !== 'string' || candidate.eventType === '') {
    throw new MalformedEventError('Message has no eventType.');
  }

  return {
    eventId: candidate.eventId ?? `evt_${randomUUID()}`,
    eventType: candidate.eventType,
    eventVersion: Number(candidate.eventVersion ?? 1),
    occurredAt: candidate.occurredAt ?? new Date().toISOString(),
    producer: candidate.producer ?? 'unknown',
    traceId: candidate.traceId ?? null,
    correlationId: candidate.correlationId ?? null,
    payload: (candidate.payload ?? {}) as Record<string, unknown>,
  };
}

function pick(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export interface ConfirmedBooking {
  bookingId: string;
  userId: string | null;
  productType: string;
  currency: string;
  /** Fare plus ancillaries. Taxes do not earn points. */
  eligibleCents: number;
  totalCents: number;
  fareClassCode: string | null;
  pnr: string | null;
  /**
   * Carried forward onto `points.accrued` so notification-worker can address
   * the email. § 6 does not specify the accrual payload, and notification-worker
   * has no database of its own, so the address has to travel on the event.
   */
  contactEmail: string | null;
}

export function readConfirmedBooking(
  payload: Record<string, unknown>,
): ConfirmedBooking {
  const bookingId = pick(payload, 'bookingId', 'booking_id', 'id');
  if (typeof bookingId !== 'string' || bookingId === '') {
    throw new MalformedEventError('booking.confirmed payload has no bookingId.');
  }

  const userId = pick(payload, 'userId', 'user_id');
  const subtotal = asInt(pick(payload, 'subtotalCents', 'subtotal_cents'));
  const ancillaries = asInt(pick(payload, 'ancillariesCents', 'ancillaries_cents'));
  const total = asInt(pick(payload, 'totalCents', 'total_cents'));
  const taxes = asInt(pick(payload, 'taxesCents', 'taxes_cents'));

  // Prefer the explicit components; fall back to total minus taxes so an
  // event that only carries a total still accrues something sensible.
  const eligible = subtotal > 0 ? subtotal + ancillaries : Math.max(0, total - taxes);

  const fareClass = pick(payload, 'fareClassCode', 'fare_class_code', 'fareClass');
  const contactEmail = pick(payload, 'contactEmail', 'contact_email');

  return {
    bookingId,
    userId: typeof userId === 'string' && userId !== '' ? userId : null,
    productType: String(pick(payload, 'productType', 'product_type') ?? 'flight'),
    currency: String(pick(payload, 'currency') ?? 'GBP'),
    eligibleCents: eligible,
    totalCents: total,
    fareClassCode: typeof fareClass === 'string' && fareClass !== '' ? fareClass : null,
    pnr: typeof payload.pnr === 'string' ? payload.pnr : null,
    contactEmail: typeof contactEmail === 'string' ? contactEmail : null,
  };
}

export function buildEnvelope<T extends Record<string, unknown>>(
  eventType: string,
  payload: T,
  correlationId: string | null,
): Envelope<T> {
  return {
    eventId: `evt_${randomUUID()}`,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: config.service,
    traceId: null,
    correlationId,
    payload,
  };
}
