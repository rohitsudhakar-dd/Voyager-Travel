/**
 * Synthetic travellers, routes and think time.
 *
 * Every name here is invented and every card is one of the mock provider's
 * test numbers (05-FUNCTIONALITY.md § 5.2). Nothing in this file may ever be
 * derived from a real person or a real payment instrument.
 */

import { sleep } from 'k6';

/**
 * Routes the seeder actually schedules. The flight table connects 220 ordered
 * pairs, not every combination of airports, so picking two airports at random
 * would spend most of the generator's day on searches that correctly return
 * nothing and exercise none of the pricing or checkout path.
 */
const ROUTES = [
  ['LHR', 'JFK'], ['JFK', 'LHR'], ['LHR', 'CDG'], ['CDG', 'LHR'],
  ['LHR', 'DXB'], ['DXB', 'LHR'], ['LHR', 'ZRH'], ['ZRH', 'LHR'],
  ['AMS', 'BCN'], ['BCN', 'AMS'], ['LAX', 'JFK'], ['JFK', 'LAX'],
  ['JFK', 'YYZ'], ['YYZ', 'JFK'], ['LAX', 'MAD'], ['MAD', 'LAX'],
  ['SIN', 'DXB'], ['DXB', 'SIN'], ['SEA', 'ARN'], ['ARN', 'SEA'],
  ['SEA', 'LIS'], ['LIS', 'SEA'], ['HEL', 'OSL'], ['OSL', 'HEL'],
  ['ATH', 'DOH'], ['DOH', 'ATH'], ['ATH', 'DEL'], ['DEL', 'ATH'],
  ['CPH', 'DUB'], ['DUB', 'CPH'], ['FRA', 'ORD'], ['ORD', 'FRA'],
  ['BKK', 'AKL'], ['AKL', 'BKK'], ['SFO', 'BOM'], ['BOM', 'SFO'],
];

/**
 * The seeded fare classes, weighted the way a real cabin mix is. There is no
 * `premium_economy`: the seed calls it `economy_plus`, and searching for a
 * cabin that does not exist returns an empty result set rather than an error,
 * which is the kind of mistake a generator can make silently for a week.
 */
const CABINS = ['economy', 'economy', 'economy', 'economy', 'economy_plus', 'business', 'first'];

/** City names exactly as the seeder wrote them; hotel search matches on them. */
const HOTEL_CITIES = [
  'London', 'New York', 'Paris', 'Amsterdam', 'Barcelona', 'Rome',
  'Madrid', 'Lisbon', 'Dublin', 'Copenhagen', 'Munich', 'Zurich',
];

const GIVEN_NAMES = [
  'Ada', 'Bruno', 'Chidi', 'Dagny', 'Elif', 'Farid', 'Greta', 'Hiro',
  'Imani', 'Jonas', 'Kira', 'Luca', 'Mira', 'Nils', 'Oona', 'Petra',
];

const FAMILY_NAMES = [
  'Okonkwo', 'Vasquez', 'Lindqvist', 'Haddad', 'Novak', 'Ferreira',
  'Bergmann', 'Kowalski', 'Moreau', 'Halvorsen', 'Dumitrescu', 'Ashworth',
];

/** The card that always authorises. Checkout journeys must actually convert. */
export const TEST_CARD = Object.freeze({
  number: '4242424242424242',
  expiryMonth: 12,
  expiryYear: 2029,
  cvc: '123',
});

/**
 * The seeded power users (01-PRD.md § 9). The manage journey signs in as one
 * of them on purpose: `GET /bff/account` is the query behind
 * `idx_bookings_user_id_created_at`, and scenario S3's plan flip is only
 * visible in DBM if that query is under continuous load before the flag goes
 * on. The password is the seeder's fixed demo password, not a secret.
 */
export const POWER_USER_COUNT = 20;
export const POWER_USER_PASSWORD = 'demo1234';

export function powerUserEmail() {
  return `power${randomInt(1, POWER_USER_COUNT)}@voyager.demo`;
}

export function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

export function randomInt(low, high) {
  return low + Math.floor(Math.random() * (high - low + 1));
}

export function route() {
  const [origin, destination] = pick(ROUTES);
  return { origin, destination };
}

export function cabin() {
  return pick(CABINS);
}

export function hotelCity() {
  return pick(HOTEL_CITIES);
}

/**
 * Departure dates stay inside the 1-360 day window § 15 allows, and lean
 * short, because a real booking curve is dense in the next few weeks and
 * thin at the edges. A uniform spread over a year would make the flight
 * inventory look evenly booked, which no airline's ever is.
 */
export function departureDate() {
  const daysAhead = randomInt(1, 4) === 1 ? randomInt(60, 300) : randomInt(7, 59);
  return isoDate(daysAhead);
}

export function isoDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

/**
 * Think time. Real people read the page; a generator that fires requests back
 * to back produces a latency distribution no production system has, and makes
 * every cache look better than it is.
 */
export function think(lowSeconds, highSeconds) {
  sleep(lowSeconds + Math.random() * (highSeconds - lowSeconds));
}

export function passengers(adults) {
  const family = pick(FAMILY_NAMES);
  const party = [];
  for (let index = 0; index < adults; index += 1) {
    party.push({
      passengerType: 'adult',
      title: pick(['Mr', 'Ms', 'Mx', 'Dr']),
      firstName: pick(GIVEN_NAMES),
      lastName: family,
      dateOfBirth: isoDate(-randomInt(22, 60) * 365 - randomInt(0, 364)),
      nationality: pick(['GB', 'IE', 'NL', 'DE', 'FR', 'ES', 'PT', 'SE']),
    });
  }
  return party;
}

/**
 * A domain that exists nowhere, on a subdomain that marks the booking as
 * generated. scripts/verify-loadgen.sh counts confirmed bookings by it, and
 * an operator clearing out demo data can do the same.
 */
export function contactEmail() {
  return `traveller-${randomInt(1, 1000000)}@loadgen.voyager.demo`;
}

export function idempotencyKey() {
  return `loadgen_${Date.now().toString(36)}_${randomInt(1, 1000000).toString(36)}`;
}
