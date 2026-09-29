import { describe, expect, it } from 'vitest';

import {
  MalformedEventError,
  parseEnvelope,
  readConfirmedBooking,
} from '../src/events';

const confirmed = {
  eventId: 'evt_01J8',
  eventType: 'booking.confirmed',
  eventVersion: 1,
  occurredAt: '2026-09-29T10:14:22.481Z',
  producer: 'voyager-booking',
  traceId: '5678901234567890',
  correlationId: 'req_01J8',
  payload: {
    bookingId: '4f1d9d64-8f7a-4d4f-9c86-3d6b0f9f1f2a',
    userId: 'c0ffee00-0000-4000-8000-000000000001',
    pnr: 'K8M2QR',
    productType: 'flight',
    currency: 'GBP',
    subtotalCents: 35_000,
    taxesCents: 4_200,
    ancillariesCents: 2_000,
    totalCents: 41_200,
    fareClassCode: 'ECOFLEX',
    contactEmail: 'traveller@example.test',
  },
};

describe('parseEnvelope', () => {
  it('reads the shared envelope', () => {
    const envelope = parseEnvelope(JSON.stringify(confirmed));
    expect(envelope.eventType).toBe('booking.confirmed');
    expect(envelope.correlationId).toBe('req_01J8');
  });

  it('rejects unparseable bytes', () => {
    expect(() => parseEnvelope('{"eventType":"points.accrued","payload":')).toThrow(
      MalformedEventError,
    );
  });

  it('rejects an envelope with no event type', () => {
    expect(() => parseEnvelope('{"payload":{}}')).toThrow(MalformedEventError);
  });
});

describe('readConfirmedBooking', () => {
  it('excludes taxes from the eligible spend', () => {
    const booking = readConfirmedBooking(confirmed.payload);
    expect(booking.eligibleCents).toBe(37_000);
    expect(booking.fareClassCode).toBe('ECOFLEX');
  });

  it('accepts snake_case keys', () => {
    const booking = readConfirmedBooking({
      booking_id: confirmed.payload.bookingId,
      user_id: confirmed.payload.userId,
      subtotal_cents: 10_000,
      ancillaries_cents: 500,
    });
    expect(booking.eligibleCents).toBe(10_500);
    expect(booking.userId).toBe(confirmed.payload.userId);
  });

  it('falls back to total minus taxes when components are absent', () => {
    const booking = readConfirmedBooking({
      bookingId: confirmed.payload.bookingId,
      totalCents: 41_200,
      taxesCents: 4_200,
    });
    expect(booking.eligibleCents).toBe(37_000);
  });

  it('treats a booking with no user as a guest booking', () => {
    const booking = readConfirmedBooking({ bookingId: confirmed.payload.bookingId });
    expect(booking.userId).toBeNull();
  });

  it('carries the contact address forward for the accrual email', () => {
    expect(readConfirmedBooking(confirmed.payload).contactEmail).toBe(
      'traveller@example.test',
    );
    expect(
      readConfirmedBooking({ ...confirmed.payload, contactEmail: undefined })
        .contactEmail,
    ).toBeNull();
  });

  it('refuses a payload with no booking id', () => {
    expect(() => readConfirmedBooking({ userId: 'x' })).toThrow(MalformedEventError);
  });
});
