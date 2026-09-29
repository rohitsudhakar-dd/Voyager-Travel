import type {
  AncillariesRequest,
  AuthorizeRequest,
  Booking,
  BookingItem,
  CheckoutInitRequest,
  DeclineCode,
  PassengersRequest,
  Payment,
} from '@voyager/shared-schemas';
import { HttpResponse, http } from 'msw';
import { detectBrand } from '@/features/checkout/cardBrand';
import {
  DEMO_USER,
  HOLD_MINUTES,
  bookingByIdOrPnr,
  chaosNumber,
  chaosString,
  itemsForResult,
  pnr,
  recalculate,
  state,
  uuid,
} from '../fixtures/state';
import { delay, errorResponse, requestId } from './shared';

const API = '/api/v1';

/** The deterministic test cards from 05-FUNCTIONALITY.md § 5.2. */
const TEST_CARDS: Record<string, 'ok' | '3ds' | 'error' | DeclineCode> = {
  '4242424242424242': 'ok',
  '4000000000000002': 'card_declined',
  '4000000000009995': 'insufficient_funds',
  '4000000000000069': 'expired_card',
  '4000000000000127': 'do_not_honor',
  '4100000000000019': 'fraud_suspected',
  '4000000000003220': '3ds',
  '4000000000000119': 'error',
};

const DECLINE_CODES: DeclineCode[] = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'do_not_honor',
  'fraud_suspected',
];

const emailSentAt = new Map<string, number>();
const idempotency = new Map<string, Payment>();
const challenges = new Map<string, string>();

function ancillaryItems(request: AncillariesRequest, booking: Booking): BookingItem[] {
  const items: BookingItem[] = [];
  let id = 100;

  for (const seat of request.seats) {
    items.push({
      id: (id += 1),
      itemType: 'seat',
      description: `Seat ${seat.seat}, traveller ${seat.passengerIndex + 1}`,
      quantity: 1,
      unitPriceCents: seat.priceCents,
      totalPriceCents: seat.priceCents,
    });
  }

  for (const bag of request.baggage) {
    if (bag.extraBags <= 0) continue;
    items.push({
      id: (id += 1),
      itemType: 'baggage',
      description: `Extra baggage, traveller ${bag.passengerIndex + 1}`,
      quantity: bag.extraBags,
      unitPriceCents: Math.round(bag.priceCents / bag.extraBags),
      totalPriceCents: bag.priceCents,
    });
  }

  if (request.roomUpgrade) {
    items.push({
      id: (id += 1),
      itemType: 'upgrade',
      description: `Room upgrade: ${request.roomUpgrade.replace(/_/g, ' ')}`,
      quantity: 1,
      unitPriceCents: 3_400,
      totalPriceCents: 3_400,
    });
  }

  if (request.breakfast) {
    const nights = booking.items.find((item) => item.itemType === 'room_night')?.quantity ?? 1;
    items.push({
      id: (id += 1),
      itemType: 'upgrade',
      description: 'Breakfast for two',
      quantity: nights,
      unitPriceCents: 1_500,
      totalPriceCents: 1_500 * nights,
    });
  }

  if (request.insurance) {
    items.push({
      id: (id += 1),
      itemType: 'insurance',
      description: 'Travel insurance',
      quantity: 1,
      unitPriceCents: 1_990,
      totalPriceCents: 1_990,
    });
  }

  return items;
}

function pointsFor(booking: Booking): number {
  return Math.round(booking.totalCents / 100);
}

function policyFor(booking: Booking) {
  const refundable = booking.productType === 'flight' ? booking.totalCents > 60_000 : true;
  const penaltyCents = refundable ? 0 : Math.round(booking.totalCents * 0.35);
  return {
    refundable,
    penaltyCents,
    refundCents:
      booking.state === 'CANCELLED' || refundable ? booking.totalCents - penaltyCents : 0,
    summary: refundable
      ? 'Free cancellation up to 48 hours before departure.'
      : 'This fare is non-refundable. Cancelling releases the seats but returns no money.',
  };
}

function emailSent(booking: Booking): boolean {
  if (booking.state !== 'CONFIRMED') return false;
  const sentAt = emailSentAt.get(booking.id);
  if (sentAt === undefined) return true;
  return Date.now() >= sentAt;
}

export const bookingHandlers = [
  http.post(`${API}/bff/checkout/init`, async ({ request }) => {
    const body = (await request.json()) as CheckoutInitRequest;
    await delay(420);

    const record = state.searches.get(body.searchId);
    const result = record?.results.find((candidate) => candidate.id === body.resultId);

    if (!record || !result) {
      return errorResponse(
        410,
        'SearchResultExpiredError',
        'search_result_expired',
        'That fare has expired. Please search again.',
      );
    }

    const travellers = result.productType === 'flight' ? 1 : 1;
    const booking = recalculate({
      id: uuid(),
      pnr: null,
      productType: result.productType,
      state: 'HELD',
      currency: 'GBP',
      subtotalCents: 0,
      taxesCents: 0,
      ancillariesCents: 0,
      totalCents: 0,
      searchId: record.id,
      resultId: result.id,
      contactEmail: null,
      contactPhone: null,
      holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(),
      confirmedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      items: itemsForResult(result, travellers),
      passengers: [],
      createdAt: new Date().toISOString(),
    });

    state.bookings.set(booking.id, booking);

    return HttpResponse.json({
      booking,
      offer: result,
      holdExpiresAt: booking.holdExpiresAt,
      pointsPreview: pointsFor(booking),
      priceChanged: false,
      previousTotalCents: null,
      requestId: requestId(),
    });
  }),

  http.put(`${API}/bookings/:id/passengers`, async ({ params, request }) => {
    const body = (await request.json()) as PassengersRequest;
    await delay(260);

    const booking = state.bookings.get(String(params.id));
    if (!booking) {
      return errorResponse(404, 'BookingNotFoundError', 'booking_not_found', 'Booking not found.');
    }

    const updated: Booking = {
      ...booking,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      passengers: body.passengers.map((passenger, index) => ({
        ...passenger,
        id: index + 1,
        seatAssignment: booking.passengers[index]?.seatAssignment ?? null,
      })),
    };

    state.bookings.set(updated.id, updated);
    return HttpResponse.json({ booking: updated });
  }),

  http.put(`${API}/bookings/:id/ancillaries`, async ({ params, request }) => {
    const body = (await request.json()) as AncillariesRequest;
    await delay(340);

    const booking = state.bookings.get(String(params.id));
    if (!booking) {
      return errorResponse(404, 'BookingNotFoundError', 'booking_not_found', 'Booking not found.');
    }

    const core = booking.items.filter(
      (item) => item.itemType === 'flight_segment' || item.itemType === 'room_night',
    );
    const updated = recalculate({
      ...booking,
      items: [...core, ...ancillaryItems(body, booking)],
      passengers: booking.passengers.map((passenger, index) => ({
        ...passenger,
        seatAssignment:
          body.seats.find((seat) => seat.passengerIndex === index)?.seat ??
          passenger.seatAssignment,
      })),
    });

    state.bookings.set(updated.id, updated);
    return HttpResponse.json({ booking: updated });
  }),

  http.post(`${API}/payments/authorize`, async ({ request }) => {
    const body = (await request.json()) as AuthorizeRequest;
    const headerKey = request.headers.get('Idempotency-Key');

    if (headerKey !== body.idempotencyKey) {
      return errorResponse(
        400,
        'ValidationError',
        'idempotency_key_mismatch',
        'The Idempotency-Key header and body must match.',
      );
    }

    await delay(900, 'payment_latency_ms');

    const booking = state.bookings.get(body.bookingId);
    if (!booking) {
      return errorResponse(404, 'BookingNotFoundError', 'booking_not_found', 'Booking not found.');
    }
    if (booking.holdExpiresAt && Date.parse(booking.holdExpiresAt) < Date.now()) {
      return errorResponse(422, 'HoldExpiredError', 'hold_expired', 'Your fare hold has expired.');
    }

    const replay = idempotency.get(body.idempotencyKey);
    if (replay) {
      return HttpResponse.json({
        payment: replay,
        booking: state.bookings.get(booking.id)!,
        threeDsChallenge: null,
      });
    }

    const digits = body.card.number.replace(/\D/g, '');
    const brand = detectBrand(digits).name;
    const scripted = TEST_CARDS[digits];

    const basePayment: Payment = {
      id: uuid(),
      bookingId: booking.id,
      provider: 'mock-payments',
      state: 'AUTHORIZING',
      amountCents: body.amount,
      currency: body.currency,
      cardLast4: digits.slice(-4),
      cardBrand: brand,
      declineCode: null,
      failureMessage: null,
      requires3ds: false,
      authorizedAt: null,
      createdAt: new Date().toISOString(),
    };

    if (scripted === 'error' || Math.random() < chaosNumber('payment_error_rate')) {
      state.payments.set(booking.id, { ...basePayment, state: 'ERROR' });
      return errorResponse(
        502,
        'PaymentProviderError',
        'payment_provider_error',
        'We could not reach our payment provider.',
      );
    }

    const forcedMix = chaosString('payment_decline_mix');
    const declineCode: DeclineCode | null =
      scripted && scripted !== 'ok' && scripted !== '3ds'
        ? scripted
        : Math.random() < chaosNumber('payment_decline_rate')
          ? forcedMix && forcedMix !== 'mixed'
            ? (forcedMix as DeclineCode)
            : DECLINE_CODES[Math.floor(Math.random() * DECLINE_CODES.length)]
          : null;

    if (declineCode) {
      const declined: Payment = {
        ...basePayment,
        state: 'DECLINED',
        declineCode,
        failureMessage: 'Declined by issuer',
      };
      state.payments.set(booking.id, declined);
      idempotency.set(body.idempotencyKey, declined);
      return errorResponse(
        422,
        'PaymentDeclinedError',
        'payment_declined',
        'Your card was declined. Please try another payment method.',
        { declineCode },
      );
    }

    if (scripted === '3ds') {
      const pending: Payment = { ...basePayment, state: 'REQUIRES_3DS', requires3ds: true };
      state.payments.set(booking.id, pending);
      challenges.set(pending.id, body.idempotencyKey);
      return HttpResponse.json({
        payment: pending,
        booking,
        threeDsChallenge: {
          challengeId: uuid(),
          prompt:
            'Your bank has sent a six-digit code to the phone number on your account. Enter it to finish paying.',
        },
      });
    }

    return HttpResponse.json(authorise(basePayment, body.idempotencyKey));
  }),

  http.post(`${API}/payments/:id/3ds/complete`, async ({ params }) => {
    await delay(700);
    const payment = [...state.payments.values()].find(
      (candidate) => candidate.id === String(params.id),
    );
    if (!payment) {
      return errorResponse(404, 'NotFoundError', 'payment_not_found', 'Payment not found.');
    }
    return HttpResponse.json(authorise(payment, challenges.get(payment.id) ?? payment.id));
  }),

  http.post(`${API}/bookings/:id/cancel`, async ({ params, request }) => {
    const body = (await request.json()) as { reason: string };
    await delay(520);

    const booking = state.bookings.get(String(params.id));
    if (!booking) {
      return errorResponse(404, 'BookingNotFoundError', 'booking_not_found', 'Booking not found.');
    }

    const policy = policyFor(booking);
    const cancelled: Booking = {
      ...booking,
      state: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
      cancellationReason: body.reason,
    };
    state.bookings.set(cancelled.id, cancelled);

    const payment = state.payments.get(cancelled.id);
    if (payment && policy.refundCents > 0) {
      state.payments.set(cancelled.id, { ...payment, state: 'REFUNDED' });
    }

    return HttpResponse.json({ booking: cancelled, refundCents: policy.refundCents });
  }),

  http.get(`${API}/bookings`, async ({ request }) => {
    await delay(300);
    const url = new URL(request.url);
    const reference = (url.searchParams.get('pnr') ?? '').toUpperCase();
    const lastName = (url.searchParams.get('lastName') ?? '').trim().toLowerCase();

    const booking = [...state.bookings.values()].find(
      (candidate) =>
        candidate.pnr === reference &&
        candidate.passengers.some((passenger) => passenger.lastName.toLowerCase() === lastName),
    );

    if (!booking) {
      return errorResponse(
        404,
        'BookingNotFoundError',
        'booking_not_found',
        'No booking matches that reference and surname.',
      );
    }

    return HttpResponse.json({ booking });
  }),

  http.get(`${API}/bookings/mine`, async ({ request }) => {
    await delay(360, 'db_slow_query_ms');
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Number(url.searchParams.get('size') ?? 20);
    const all = summaries();

    return HttpResponse.json({
      bookings: all.slice((page - 1) * size, page * size),
      page,
      size,
      total: all.length,
      requestId: requestId(),
    });
  }),

  http.get(`${API}/bff/booking/:idOrPnr`, async ({ params }) => {
    await delay(210);
    const booking = bookingByIdOrPnr(String(params.idOrPnr));
    if (!booking) {
      return errorResponse(404, 'BookingNotFoundError', 'booking_not_found', 'Booking not found.');
    }

    const payment = state.payments.get(booking.id) ?? null;
    return HttpResponse.json({
      booking,
      payment,
      loyalty:
        booking.state === 'CONFIRMED'
          ? { pointsEarned: pointsFor(booking), accrued: emailSent(booking) }
          : { pointsEarned: pointsFor(booking), accrued: false },
      emailSent: emailSent(booking),
      cancellationPolicy: policyFor(booking),
      requestId: requestId(),
    });
  }),
];

function authorise(payment: Payment, idempotencyKey: string) {
  const authorized: Payment = {
    ...payment,
    state: 'AUTHORIZED',
    declineCode: null,
    failureMessage: null,
    authorizedAt: new Date().toISOString(),
  };
  state.payments.set(payment.bookingId, authorized);
  idempotency.set(idempotencyKey, authorized);

  const booking = state.bookings.get(payment.bookingId)!;
  const pending: Booking = { ...booking, state: 'PENDING_PAYMENT' };
  state.bookings.set(pending.id, pending);

  // The provider webhook arrives a moment later, which is what makes the
  // confirmation page's poll do real work.
  const webhookDelay = Math.max(600, chaosNumber('payment_webhook_delay_ms'));
  window.setTimeout(() => {
    const current = state.bookings.get(pending.id);
    if (!current || current.state !== 'PENDING_PAYMENT') return;
    state.bookings.set(current.id, {
      ...current,
      state: 'CONFIRMED',
      pnr: pnr(current.id),
      confirmedAt: new Date().toISOString(),
    });
    state.payments.set(current.id, { ...authorized, state: 'CAPTURED' });
    // Scenario S5: the itinerary email lags behind the confirmation.
    const emailLag =
      chaosNumber('kafka_slow_consumer_ms') * 8 +
      (chaosString('kafka_consumer_pause') ? 600_000 : 0);
    emailSentAt.set(current.id, Date.now() + emailLag);
  }, webhookDelay);

  return { payment: authorized, booking: pending, threeDsChallenge: null };
}

export function summaries() {
  return [...state.bookings.values()]
    .filter((booking) => booking.state !== 'DRAFT' && booking.state !== 'HELD')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((booking) => ({
      id: booking.id,
      pnr: booking.pnr,
      productType: booking.productType,
      state: booking.state,
      headline: booking.items[0]?.description ?? 'Booking',
      travelDate: booking.confirmedAt,
      totalCents: booking.totalCents,
      currency: booking.currency,
      createdAt: booking.createdAt,
    }));
}

export { DEMO_USER };
