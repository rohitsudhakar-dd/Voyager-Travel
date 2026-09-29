/**
 * Every call the generator makes, against the public API in
 * 05-FUNCTIONALITY.md § 2. Requests go through `api-gateway` and nowhere
 * else, because a generator that shortcuts to a downstream service produces
 * traces that no real client could ever produce.
 *
 * Each helper returns the parsed body on success and `null` on anything else.
 * Journeys branch on `null` and stop; nothing here throws, because a chaos
 * scenario deliberately breaking search must degrade the traffic shape, not
 * take the generator down with it.
 */

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.GATEWAY_BASE_URL || 'http://api-gateway:4000';

/**
 * A search that misses cache fans out to four providers; a payment can sit
 * behind `payment_latency_ms` for several seconds. These match the gateway's
 * own upstream timeouts, so the generator gives up at the same moment a
 * browser would rather than earlier.
 */
const SEARCH_TIMEOUT = '25s';
const CHECKOUT_TIMEOUT = '30s';

function headers(extra) {
  return Object.assign(
    {
      'content-type': 'application/json',
      // Synthetic traffic should be obvious in a gateway log without having
      // to correlate source IPs against container names.
      'user-agent': 'voyager-loadgen-api/1.0 (k6)',
    },
    extra || {},
  );
}

/**
 * `name` is the route pattern, never the instantiated path. k6 tags every
 * metric with it, and a tag that carries a booking id turns one endpoint into
 * a hundred thousand unique series.
 */
function request(method, path, options) {
  const settings = options || {};
  const response = http.request(
    method,
    `${BASE_URL}${path}`,
    settings.body === undefined ? null : JSON.stringify(settings.body),
    {
      headers: headers(settings.headers),
      tags: { name: settings.name || path, journey: settings.journey || 'unknown' },
      timeout: settings.timeout || '20s',
    },
  );

  const expected = settings.expect || [200, 201];
  check(response, { [`${method} ${settings.name || path}`]: (r) => expected.indexOf(r.status) !== -1 });
  if (expected.indexOf(response.status) === -1) return null;

  try {
    return response.json();
  } catch (error) {
    return null;
  }
}

// ------------------------------------------------------------------ shop --

export function home(journey, token) {
  return request('GET', '/api/v1/bff/home', {
    journey,
    name: '/bff/home',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

export function suggestAirports(journey, prefix) {
  return request('GET', `/api/v1/ref/airports?q=${prefix}&limit=8`, {
    journey,
    name: '/ref/airports',
  });
}

export function searchFlights(journey, criteria) {
  return request('POST', '/api/v1/search/flights', {
    journey,
    name: '/search/flights',
    body: criteria,
    timeout: SEARCH_TIMEOUT,
  });
}

export function searchHotels(journey, criteria) {
  return request('POST', '/api/v1/search/hotels', {
    journey,
    name: '/search/hotels',
    body: criteria,
    timeout: SEARCH_TIMEOUT,
  });
}

/**
 * A cached result set lives 120 seconds and then answers 410. A traveller who
 * paged through results after wandering off gets exactly that, so 410 is an
 * expected outcome here rather than a failed check.
 */
export function resultsPage(journey, searchId, page) {
  return request('GET', `/api/v1/search/${searchId}/results?page=${page}&size=20`, {
    journey,
    name: '/search/{searchId}/results',
    expect: [200, 410],
  });
}

export function resultDetail(journey, searchId, resultId) {
  return request('GET', `/api/v1/search/${searchId}/results/${resultId}`, {
    journey,
    name: '/search/{searchId}/results/{resultId}',
  });
}

// -------------------------------------------------------------- checkout --

export function checkoutInit(journey, body) {
  return request('POST', '/api/v1/bff/checkout/init', {
    journey,
    name: '/bff/checkout/init',
    body,
    expect: [201],
    timeout: CHECKOUT_TIMEOUT,
  });
}

export function putPassengers(journey, bookingId, party) {
  return request('PUT', `/api/v1/bookings/${bookingId}/passengers`, {
    journey,
    name: '/bookings/{id}/passengers',
    body: { passengers: party },
  });
}

export function putAncillaries(journey, bookingId, ancillaries) {
  return request('PUT', `/api/v1/bookings/${bookingId}/ancillaries`, {
    journey,
    name: '/bookings/{id}/ancillaries',
    body: { ancillaries },
  });
}

/**
 * A decline is a business outcome, not a failure: `payment_decline_rate`
 * defaults to 2% and scenario S2 raises it. Treating a 201-with-DECLINED as a
 * broken check would make the generator's own health meaningless during the
 * scenario it exists to illuminate.
 */
export function authorize(journey, booking, card, key) {
  return request('POST', '/api/v1/payments/authorize', {
    journey,
    name: '/payments/authorize',
    headers: { 'idempotency-key': key },
    body: {
      bookingId: booking.id,
      amountCents: booking.totalCents,
      currency: booking.currency,
      card: Object.assign({ holderName: 'A TRAVELLER' }, card),
    },
    expect: [201],
    timeout: CHECKOUT_TIMEOUT,
  });
}

export function bookingByUuid(journey, bookingId) {
  return request('GET', `/api/v1/bff/booking/${bookingId}`, {
    journey,
    name: '/bff/booking/{id}',
  });
}

export function bookingByPnr(journey, pnr, lastName) {
  return request('GET', `/api/v1/bff/booking/${pnr}?lastName=${lastName}`, {
    journey,
    name: '/bff/booking/{pnr}',
  });
}

export function cancelBooking(journey, bookingId, reason) {
  return request('POST', `/api/v1/bookings/${bookingId}/cancel`, {
    journey,
    name: '/bookings/{id}/cancel',
    body: { reason },
  });
}

// ------------------------------------------------------- account and chat --

export function login(journey, email, password) {
  return request('POST', '/api/v1/auth/login', {
    journey,
    name: '/auth/login',
    body: { email, password },
  });
}

export function account(journey, token, page) {
  return request('GET', `/api/v1/bff/account?page=${page}&size=20`, {
    journey,
    name: '/bff/account',
    headers: { authorization: `Bearer ${token}` },
    // The gateway gives this call 30 seconds on purpose so scenario S3 shows
    // a slow query rather than a 504. Outwaiting it keeps the generator's
    // view of the endpoint the same as the browser's.
    timeout: '35s',
  });
}

export function openConversation(journey, subject) {
  return request('POST', '/api/v1/support/conversations', {
    journey,
    name: '/support/conversations',
    body: { subject },
  });
}

/**
 * The turn streams server-sent events. k6 has no SSE client, so this reads
 * the whole stream and returns the raw text -- which is what the request
 * costs the backend either way, and the only thing the generator needs.
 */
export function sendMessage(journey, conversationId, content) {
  const response = http.post(
    `${BASE_URL}/api/v1/support/conversations/${conversationId}/messages`,
    JSON.stringify({ content }),
    {
      headers: headers({ accept: 'text/event-stream' }),
      tags: { name: '/support/conversations/{id}/messages', journey },
      timeout: '60s',
    },
  );
  check(response, { 'POST /support/conversations/{id}/messages': (r) => r.status === 200 });
  return response.status === 200 ? response.body : null;
}
