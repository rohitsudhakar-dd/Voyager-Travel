/**
 * The six journeys, in the proportions in mix.js.
 *
 * Each one starts by asking admission control whether it should run at all,
 * so a journey either happens in full or does not happen. Half-executed
 * journeys would be indistinguishable from abandonment in the funnel, and the
 * API generator's job is to be the clean baseline that the browser
 * generator's drop-off is measured against.
 */

import * as gateway from './gateway.js';
import { admit } from './settings.js';
import { count, countJourney } from './stats.js';
import { borrow, claim, remember } from './pool.js';
import {
  POWER_USER_PASSWORD,
  TEST_CARD,
  cabin,
  contactEmail,
  departureDate,
  hotelCity,
  idempotencyKey,
  passengers,
  pick,
  powerUserEmail,
  randomInt,
  route,
  think,
} from './travellers.js';

/** What an airport autocomplete actually receives after a 250 ms debounce. */
const SUGGEST_PREFIXES = ['lon', 'new', 'par', 'ams', 'bar', 'rom', 'mad', 'lis', 'dub', 'mun', 'zur', 'sto'];

const SUPPORT_OPENERS = [
  'I need to change the dates on my flight.',
  'What is the baggage allowance on my booking?',
  'How long does a refund usually take?',
  'Can I add a checked bag after booking?',
];

async function run(journey, steps) {
  const gate = await admit();
  if (!gate) return;
  await countJourney(journey);
  await steps();
}

function chance(probability) {
  return Math.random() < probability;
}

/** Search criteria for a party of one to three adults, flights or hotels. */
function flightCriteria() {
  const legs = route();
  const adults = chance(0.6) ? 1 : randomInt(2, 3);
  const departDate = departureDate();
  return {
    origin: legs.origin,
    destination: legs.destination,
    departDate,
    returnDate: chance(0.45) ? addDays(departDate, randomInt(3, 14)) : undefined,
    passengers: { adults, children: 0, infants: 0 },
    cabin: cabin(),
    sort: pick(['price_asc', 'price_asc', 'duration_asc']),
  };
}

function hotelCriteria() {
  const checkIn = departureDate();
  return {
    city: hotelCity(),
    checkIn,
    checkOut: addDays(checkIn, randomInt(1, 7)),
    guests: randomInt(1, 3),
    rooms: 1,
  };
}

function addDays(isoDay, days) {
  return new Date(Date.parse(isoDay) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * The shared front half of every shopping journey: land, maybe type into the
 * autocomplete, search, read the results. Returns the search alongside the
 * criteria that produced it -- the response carries neither, and checkout
 * needs the party size to fill in the passenger counts.
 *
 * Returns null when there was nothing to look at. Empty result sets are
 * normal: not every airport pair in the seed is connected, and a search that
 * finds nothing is a real user experience rather than an error.
 */
function shop(journey, productType) {
  if (chance(0.6)) {
    gateway.home(journey);
    think(2, 6);
  }

  const criteria = productType === 'hotels' ? hotelCriteria() : flightCriteria();

  let search;
  if (productType === 'hotels') {
    search = gateway.searchHotels(journey, criteria);
  } else {
    gateway.suggestAirports(journey, pick(SUGGEST_PREFIXES));
    think(1, 3);
    search = gateway.searchFlights(journey, criteria);
  }
  if (!search || !search.results || search.results.length === 0) return null;

  think(4, 14);
  if (chance(0.4)) {
    gateway.resultsPage(journey, search.searchId, 2);
    think(3, 9);
  }
  return { search, criteria };
}

// ------------------------------------------------------------------ 52% --

export async function browse() {
  await run('browse', async () => {
    shop('browse', chance(0.3) ? 'hotels' : 'flights');
  });
}

// ------------------------------------------------------------------ 20% --

export async function deepBrowse() {
  await run('deep_browse', async () => {
    const shopped = shop('deep_browse', chance(0.3) ? 'hotels' : 'flights');
    if (!shopped) return;
    const { search } = shopped;

    // Opening two or three fares before losing interest is the commonest
    // shape in an OTA's own analytics, and it is what makes the
    // results-to-selection step of the funnel the steep one it is.
    const views = Math.min(randomInt(1, 3), search.results.length);
    for (let index = 0; index < views; index += 1) {
      gateway.resultDetail('deep_browse', search.searchId, search.results[index].id);
      think(4, 12);
    }
  });
}

// ------------------------------------------------------------------ 17% --

export async function checkout() {
  await run('checkout', async () => {
    // Flights only. `POST /bff/checkout/init` re-prices through
    // `pricing-service` with `productType: 'flights'` hard-coded, so a hotel
    // offer cannot currently complete this path.
    const shopped = shop('checkout', 'flights');
    if (!shopped) return;
    const { search, criteria } = shopped;

    const offer = search.results[randomInt(0, Math.min(4, search.results.length - 1))];
    if (!gateway.resultDetail('checkout', search.searchId, offer.id)) return;
    think(5, 15);

    const adults = criteria.passengers.adults;
    const initialised = gateway.checkoutInit('checkout', {
      searchId: search.searchId,
      resultId: offer.id,
      contactEmail: contactEmail(),
      passengerCounts: { adult: adults, child: 0, infant: 0 },
    });
    if (!initialised || !initialised.booking) return;

    let booking = initialised.booking;
    think(6, 16);

    if (chance(0.55)) {
      const priced = gateway.putAncillaries('checkout', booking.id, [
        { type: pick(['baggage', 'seat']), description: 'Checked bag, 23kg', quantity: 1 },
      ]);
      if (priced && priced.totalCents) booking = priced;
      think(4, 10);
    }

    const party = passengers(adults);
    const named = gateway.putPassengers('checkout', booking.id, party);
    if (!named) return;
    if (named.totalCents) booking = named;

    // Typing passport details is the slowest step of a real checkout, and
    // the step where the hold countdown starts to matter.
    think(12, 28);

    const payment = gateway.authorize('checkout', booking, TEST_CARD, idempotencyKey());
    if (!payment) return;

    const confirmed = awaitConfirmation('checkout', booking.id);
    if (!confirmed) return;

    // Counted separately from the journey, because "started a checkout" and
    // "has a PNR" are different claims and only the second one proves the
    // async confirmation path is alive.
    await count('api_confirmations');
    await remember({
      pnr: confirmed.pnr,
      lastName: party[0].lastName,
      bookingId: confirmed.id,
    });
    think(3, 8);
  });
}

/**
 * Confirmation is asynchronous: payment-service emits, booking-service
 * consumes, and only then does a PNR exist. The frontend polls once a second
 * for thirty seconds (05-FUNCTIONALITY.md § 8) and so does this, because a
 * generator that waited differently would report a different confirmation
 * latency than the product does.
 */
function awaitConfirmation(journey, bookingId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const view = gateway.bookingByUuid(journey, bookingId);
    if (view && view.booking && view.booking.state === 'CONFIRMED') return view.booking;
    think(1, 1);
  }
  return null;
}

// ------------------------------------------------------------------- 5% --

export async function manage() {
  await run('manage', async () => {
    // Signed in as a seeded power user, because `/bff/account` is the query
    // behind `idx_bookings_user_id_created_at`. Keeping it warm all day is
    // what gives scenario S3 a before-and-after to compare against.
    const session = gateway.login('manage', powerUserEmail(), POWER_USER_PASSWORD);
    if (!session) return;
    think(1, 3);

    const history = gateway.account('manage', session.accessToken, 1);
    if (!history || !history.bookings || history.bookings.length === 0) return;
    think(4, 12);

    if (chance(0.35)) {
      gateway.account('manage', session.accessToken, 2);
      think(3, 8);
    }

    const chosen = pick(history.bookings);
    gateway.bookingByUuid('manage', chosen.id);
    think(3, 9);
  });
}

// ------------------------------------------------------------------- 3% --

export async function cancel() {
  await run('cancel', async () => {
    // Only bookings this generator created. Cancelling seeded bookings would
    // eat away at the power users' history, which is the subject of the S3
    // demo, and the damage would be invisible until the demo failed.
    const held = await claim();
    if (!held) {
      gateway.home('cancel');
      return;
    }

    if (!gateway.bookingByPnr('cancel', held.pnr, held.lastName)) return;
    think(6, 18);

    gateway.cancelBooking('cancel', held.bookingId, pick(['plans changed', 'found a better fare', 'trip postponed']));
    think(2, 6);
  });
}

export async function support() {
  await run('support', async () => {
    const conversation = gateway.openConversation('support', 'Help with my booking');
    const conversationId = conversation && (conversation.conversationId || conversation.id);
    if (!conversationId) return;
    think(3, 9);

    // A real reference when there is one, because that is what makes the
    // model reach for `lookup_booking` and produce a tool span worth looking
    // at in LLM Observability.
    const known = await borrow();
    const opener = known
      ? `Where is my booking ${known.pnr}? My last name is ${known.lastName}`
      : pick(SUPPORT_OPENERS);

    gateway.sendMessage('support', conversationId, opener);
    think(8, 20);

    if (chance(0.5)) {
      gateway.sendMessage('support', conversationId, pick(['Thanks, that helps.', 'What are my options?']));
      think(4, 10);
    }
  });
}
