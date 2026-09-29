import type { Deal, LoginRequest, SignupRequest, UpcomingTrip } from '@voyager/shared-schemas';
import { HttpResponse, http } from 'msw';
import { AIRPORTS } from '../fixtures/reference';
import { DEMO_PASSWORD, DEMO_USER, loyalty, state } from '../fixtures/state';
import { rngFrom } from '../fixtures/rng';
import { delay, errorResponse, requestId } from './shared';
import { summaries } from './booking';

const API = '/api/v1';

const DEALS: Deal[] = [
  {
    id: 'deal-1',
    productType: 'flight',
    origin: 'LHR',
    destination: 'JFK',
    cityName: 'New York',
    headline: 'Direct, autumn midweek',
    fromPriceCents: 32_900,
    currency: 'GBP',
    imageSeed: 3,
  },
  {
    id: 'deal-2',
    productType: 'hotel',
    origin: null,
    destination: null,
    cityName: 'Lisbon',
    headline: 'Three nights by the water',
    fromPriceCents: 18_400,
    currency: 'GBP',
    imageSeed: 7,
  },
  {
    id: 'deal-3',
    productType: 'flight',
    origin: 'MAN',
    destination: 'BCN',
    cityName: 'Barcelona',
    headline: 'Weekend fares, no bag',
    fromPriceCents: 6_700,
    currency: 'GBP',
    imageSeed: 11,
  },
  {
    id: 'deal-4',
    productType: 'hotel',
    origin: null,
    destination: null,
    cityName: 'Amsterdam',
    headline: 'Canal-side, breakfast in',
    fromPriceCents: 14_200,
    currency: 'GBP',
    imageSeed: 1,
  },
  {
    id: 'deal-5',
    productType: 'flight',
    origin: 'LHR',
    destination: 'SIN',
    cityName: 'Singapore',
    headline: 'Business, one stop',
    fromPriceCents: 148_000,
    currency: 'GBP',
    imageSeed: 14,
  },
  {
    id: 'deal-6',
    productType: 'hotel',
    origin: null,
    destination: null,
    cityName: 'Rome',
    headline: 'Four nights near the forum',
    fromPriceCents: 21_900,
    currency: 'GBP',
    imageSeed: 9,
  },
];

function upcomingTrips(): UpcomingTrip[] {
  return [...state.bookings.values()]
    .filter((booking) => booking.state === 'CONFIRMED' && booking.pnr)
    .slice(0, 3)
    .map((booking) => ({
      bookingId: booking.id,
      pnr: booking.pnr!,
      productType: booking.productType,
      headline: booking.items[0]?.description ?? 'Your trip',
      departAt: booking.confirmedAt ?? booking.createdAt,
      origin: null,
      destination: null,
    }));
}

function authenticated(request: Request): boolean {
  return Boolean(request.headers.get('Authorization'));
}

export const accountHandlers = [
  http.post(`${API}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as LoginRequest;
    await delay(340);

    // Any password is accepted in the fixture except an obviously wrong one, so
    // the failure state is still reachable on demand.
    if (body.password === 'wrong' || body.password.length < 8) {
      return errorResponse(
        401,
        'AuthenticationError',
        'invalid_credentials',
        'That email and password do not match an account.',
      );
    }

    return HttpResponse.json({
      user: { ...DEMO_USER, email: body.email },
      accessToken: `fixture-access-${Date.now()}`,
      refreshToken: 'fixture-refresh',
    });
  }),

  http.post(`${API}/auth/signup`, async ({ request }) => {
    const body = (await request.json()) as SignupRequest;
    await delay(420);

    if (body.email === DEMO_USER.email) {
      return errorResponse(
        409,
        'ConflictError',
        'email_already_registered',
        'There is already an account with that email.',
      );
    }

    return HttpResponse.json({
      user: {
        ...DEMO_USER,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        tier: 'bronze',
        loyaltyPoints: 0,
      },
      accessToken: `fixture-access-${Date.now()}`,
      refreshToken: 'fixture-refresh',
    });
  }),

  http.post(`${API}/auth/refresh`, async () => {
    await delay(120);
    return HttpResponse.json({ accessToken: `fixture-access-${Date.now()}` });
  }),

  http.post(`${API}/auth/logout`, async () => {
    await delay(80);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/auth/me`, async ({ request }) => {
    await delay(110);
    if (!authenticated(request)) {
      return errorResponse(401, 'AuthenticationError', 'unauthorized', 'Sign in to continue.');
    }
    return HttpResponse.json(DEMO_USER);
  }),

  http.get(`${API}/loyalty/me`, async ({ request }) => {
    await delay(180);
    if (!authenticated(request)) {
      return errorResponse(401, 'AuthenticationError', 'unauthorized', 'Sign in to continue.');
    }
    return HttpResponse.json(loyalty);
  }),

  http.get(`${API}/bff/home`, async ({ request }) => {
    await delay(280);
    const signedIn = authenticated(request);
    const rng = rngFrom('home');

    return HttpResponse.json({
      popularAirports: rng.some(AIRPORTS, 6),
      deals: DEALS,
      upcomingTrips: signedIn ? upcomingTrips() : [],
      loyalty: signedIn ? { tier: loyalty.tier, pointsBalance: loyalty.pointsBalance } : null,
      requestId: requestId(),
    });
  }),

  http.get(`${API}/bff/account`, async ({ request }) => {
    await delay(390, 'db_slow_query_ms');
    if (!authenticated(request)) {
      return errorResponse(401, 'AuthenticationError', 'unauthorized', 'Sign in to continue.');
    }

    const all = summaries();
    return HttpResponse.json({
      bookings: all.slice(0, 20),
      bookingsTotal: all.length,
      loyalty,
      savedPaymentMethods: [
        { id: 'pm-1', cardBrand: 'Solaris', cardLast4: '4242', expiryMonth: 7, expiryYear: 2029 },
      ],
      requestId: requestId(),
    });
  }),
];

export { DEMO_PASSWORD };
