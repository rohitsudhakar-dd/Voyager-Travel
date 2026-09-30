/**
 * The BFF aggregation endpoints (05-FUNCTIONALITY.md § 2.4).
 *
 * These exist so one frontend request fans out across several services. That
 * is ordinary BFF design, and it is also what produces a trace wide enough to
 * be worth looking at. Every panel is gathered independently, so a slow
 * loyalty lookup costs the traveller their points widget rather than the
 * whole page.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { principalOf, requirePrincipal } from '../auth';
import { openCart } from '../cart';
import { ValidationError } from '../errors';
import { callService, gather } from '../http';
import type { Deps } from '../deps';

/** A PNR is six characters from the unambiguous alphabet; a booking id is a UUID. */
const PNR_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

const CHECKOUT_TIMEOUT_MS = 20_000;

export function registerBffRoutes(app: FastifyInstance, deps: Deps): void {
  // ---------------------------------------------------------------- home --

  app.get('/api/v1/bff/home', async (request) => {
    const principal = principalOf(request);

    const { results, failures } = await gather({
      airports: popularAirports(deps),

      deals: callService<Record<string, unknown>>('search', {
        method: 'POST',
        path: '/v1/search/flights',
        body: dealSearch(),
        requestId: request.id,
        timeoutMs: 8000,
      }).then((result) => result.body),

      loyalty: principal
        ? callService<Record<string, unknown>>('loyalty', {
            path: `/v1/loyalty/${principal.id}`,
            requestId: request.id,
            timeoutMs: 3000,
          }).then((result) => result.body)
        : Promise.resolve(null),

      upcoming: principal
        ? callService<{ bookings: unknown[] }>('booking', {
            path: '/v1/bookings',
            query: { user_id: principal.id, limit: 5, offset: 0 },
            requestId: request.id,
            timeoutMs: 5000,
          }).then((result) => result.body.bookings)
        : Promise.resolve([]),
    });

    return {
      popularAirports: results.airports ?? [],
      deals: summariseDeals(results.deals),
      loyalty: results.loyalty,
      upcomingTrips: results.upcoming ?? [],
      // Naming what did not load lets the UI show a retry on one panel
      // instead of an error page over all four.
      degraded: Object.keys(failures).length > 0 ? failures : undefined,
      requestId: request.id,
    };
  });

  // ------------------------------------------------------- checkout init --

  app.post('/api/v1/bff/checkout/init', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const searchId = String(body.searchId ?? '');
    const resultId = String(body.resultId ?? '');
    if (!searchId || !resultId) {
      throw new ValidationError('searchId and resultId are required.');
    }

    const principal = principalOf(request);
    const contactEmail = String(body.contactEmail ?? principal?.email ?? '');
    if (!contactEmail.includes('@')) {
      throw new ValidationError('A contact email is required.');
    }

    // 1. The offer still exists. Search results live 120 seconds, and a
    //    traveller who wandered off mid-checkout needs telling, not a booking
    //    against a price that has gone.
    const offer = await callService<{ result: Record<string, unknown> }>('search', {
      path: `/v1/search/${encodeURIComponent(searchId)}/results/${encodeURIComponent(resultId)}`,
      requestId: request.id,
      timeoutMs: 5000,
    });
    const quotedFare = (offer.body.result as Record<string, Record<string, number>>).fare;

    // 2. Re-price it. Prices move, and a price that moved is a real UX state
    //    rather than an error.
    const repriced = await callService<{ quotes: Array<Record<string, number>> }>(
      'pricing',
      {
        method: 'POST',
        path: '/v1/price/batch',
        body: { offers: [priceRequest(offer.body.result, body)] },
        requestId: request.id,
        timeoutMs: 5000,
      },
    );
    const quote = repriced.body.quotes?.[0];
    const priceChanged =
      quote !== undefined && quote.totalAmountCents !== quotedFare.totalAmountCents;

    // 3. Create the draft.
    const created = await callService<Record<string, unknown>>('booking', {
      method: 'POST',
      path: '/v1/bookings',
      body: {
        searchId,
        resultId,
        userId: principal?.id ?? null,
        contactEmail,
        contactPhone: body.contactPhone ?? null,
        passengerCounts: body.passengerCounts ?? { adult: 1, child: 0, infant: 0 },
      },
      requestId: request.id,
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });
    const bookingId = String(created.body.id);

    // 4. Hold the inventory.
    const held = await callService<Record<string, unknown>>('booking', {
      method: 'POST',
      path: `/v1/bookings/${bookingId}/hold`,
      requestId: request.id,
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });

    // The traveller is now on /checkout/review with a live hold. Tracked so
    // `voyager.cart.abandoned` can say where they stopped if they never pay.
    await openCart(
      deps,
      bookingId,
      String(held.body.productType ?? 'unknown'),
      held.body.holdExpiresAt as string | null,
    );

    // 5. Points preview, which is decoration. It never blocks a checkout.
    let pointsPreview: unknown = null;
    try {
      const preview = await callService<Record<string, unknown>>('loyalty', {
        method: 'POST',
        path: '/v1/loyalty/preview',
        body: {
          userId: principal?.id ?? null,
          amountCents: held.body.totalCents,
          // Broken out so the quote excludes taxes, which never earn.
          taxesCents: held.body.taxesCents,
          fareClassCode: (held.body.metadata as Record<string, unknown>)?.fareClassCode,
          currency: held.body.currency,
        },
        requestId: request.id,
        timeoutMs: 3000,
      });
      pointsPreview = preview.body;
    } catch {
      pointsPreview = null;
    }

    reply.code(201);
    return {
      booking: held.body,
      holdExpiresAt: held.body.holdExpiresAt,
      priceChanged,
      quotedTotalCents: quotedFare.totalAmountCents,
      currentTotalCents: quote?.totalAmountCents ?? quotedFare.totalAmountCents,
      pointsPreview,
      requestId: request.id,
    };
  });

  // ------------------------------------------------------------- booking --

  app.get('/api/v1/bff/booking/:idOrPnr', async (request) => {
    const { idOrPnr } = request.params as { idOrPnr: string };
    const { lastName } = request.query as { lastName?: string };

    // The checkout poll uses the UUID, because the PNR does not exist until
    // the booking is CONFIRMED.
    const booking = PNR_PATTERN.test(idOrPnr.toUpperCase())
      ? await bookingByPnr(request, idOrPnr, lastName)
      : (
          await callService<Record<string, unknown>>('booking', {
            path: `/v1/bookings/${encodeURIComponent(idOrPnr)}`,
            requestId: request.id,
            timeoutMs: 8000,
          })
        ).body;

    const bookingId = String(booking.id);
    const { results, failures } = await gather({
      payment: callService<Record<string, unknown>>('payment', {
        path: `/v1/payments/by-booking/${bookingId}`,
        requestId: request.id,
        timeoutMs: 4000,
      }).then((result) => result.body),

      loyalty: booking.userId
        ? callService<Record<string, unknown>>('loyalty', {
            path: `/v1/loyalty/${booking.userId}/accruals/${bookingId}`,
            requestId: request.id,
            timeoutMs: 3000,
          }).then((result) => result.body)
        : Promise.resolve(null),
    });

    return {
      booking,
      payment: results.payment,
      loyalty: results.loyalty,
      degraded: Object.keys(failures).length > 0 ? failures : undefined,
      requestId: request.id,
    };
  });

  // ------------------------------------------------------------- account --

  app.get('/api/v1/bff/account', async (request) => {
    const principal = requirePrincipal(request);
    const { page = '1', size = '20' } = request.query as Record<string, string>;
    const limit = Math.min(Number(size) || 20, 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const { results, failures } = await gather({
      // This is the call scenario S3 wrecks. It is given a long timeout on
      // purpose: the demo is watching it get slow, and a gateway timeout at
      // five seconds would hide the plan flip behind a 504.
      bookings: callService<{ bookings: unknown[]; count: number }>('booking', {
        path: '/v1/bookings',
        query: { user_id: principal.id, limit, offset },
        requestId: request.id,
        timeoutMs: 30_000,
      }).then((result) => result.body),

      loyalty: callService<Record<string, unknown>>('loyalty', {
        path: `/v1/loyalty/${principal.id}`,
        requestId: request.id,
        timeoutMs: 4000,
      }).then((result) => result.body),

      payments: callService<Record<string, unknown>>('payment', {
        path: `/v1/payments/methods/${principal.id}`,
        requestId: request.id,
        timeoutMs: 4000,
      }).then((result) => result.body),
    });

    return {
      bookings: results.bookings?.bookings ?? [],
      bookingCount: results.bookings?.count ?? 0,
      loyalty: results.loyalty,
      savedMethods: results.payments ?? { methods: [] },
      degraded: Object.keys(failures).length > 0 ? failures : undefined,
      requestId: request.id,
    };
  });
}

async function bookingByPnr(
  request: FastifyRequest,
  pnr: string,
  lastName: string | undefined,
): Promise<Record<string, unknown>> {
  if (!lastName) {
    throw new ValidationError(
      'Looking a booking up by reference also needs the lead passenger\u2019s surname.',
    );
  }
  const found = await callService<{ bookings: Record<string, unknown>[] }>('booking', {
    path: '/v1/bookings',
    query: { pnr, lastName },
    requestId: request.id,
    timeoutMs: 8000,
  });
  return found.body.bookings[0];
}

async function popularAirports(deps: Deps): Promise<unknown[]> {
  // Ranked by the city's popularity rather than by counting departures. The
  // count would mean grouping 150k flight rows on every home-page load, which
  // is a lot of work for a widget that changes about once a quarter.
  const { rows } = await deps.pool.query(
    `SELECT a.iata_code AS code, a.name, c.name AS city,
            a.country_code AS country, c.popularity_rank AS "popularityRank"
     FROM voyager.airports a
     JOIN voyager.cities c ON c.id = a.city_id
     WHERE c.popularity_rank IS NOT NULL
     ORDER BY c.popularity_rank, a.iata_code
     LIMIT 8`,
  );
  return rows;
}

function dealSearch(): Record<string, unknown> {
  const departure = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  return {
    origin: 'LHR',
    destination: 'CDG',
    departDate: departure,
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin: 'economy',
    sort: 'price_asc',
  };
}

function summariseDeals(deals: unknown): unknown[] {
  if (!deals || typeof deals !== 'object') return [];
  const results = (deals as { results?: unknown[] }).results ?? [];
  return results.slice(0, 4);
}

function priceRequest(
  offer: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const fare = offer.fare as Record<string, unknown>;
  const segment = ((offer.segments as Record<string, unknown>[]) ?? [{}])[0];
  return {
    id: String(offer.id),
    productType: 'flights',
    origin: segment.origin,
    destination: segment.destination,
    departDate: String(segment.departAt ?? '').slice(0, 10),
    returnDate: body.returnDate ?? undefined,
    fareClass: fare.basis,
    cabin: fare.cabin,
    baseAmountCents: fare.baseAmountCents,
    currency: fare.currency,
  };
}
