/**
 * mock-gds -- simulated Global Distribution System.
 *
 * Reads from Postgres so results are consistent with the seed data, but
 * behaves like a remote API: log-normal latency with a real tail, a per
 * provider rate limit, random 503s, and one provider that sometimes answers
 * in a different schema. Contracts are in 05-FUNCTIONALITY.md § 5.1.
 */

import { randomUUID } from 'node:crypto';

import Fastify, { FastifyReply, FastifyRequest } from 'fastify';

import * as chaos from './chaos';
import { config } from './config';
import {
  findFareClasses,
  findFlightById,
  findFlights,
  findProperties,
  ping,
  pool,
} from './db';
import { createLogger } from './logger';
import {
  buildOffers,
  decodeOfferId,
  toTrvpLegacy,
  TRVP_LEGACY_SCHEMA_RATE,
} from './offers';
import {
  baselineLatencyMs,
  checkRateLimit,
  isProvider,
  Provider,
  PROVIDERS,
} from './providers';

const logger = createLogger(config.service, config.env, config.version);
const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

const MAX_FLIGHTS_PER_SEARCH = 24;
const MAX_FARE_CLASSES_PER_FLIGHT = 3;
const MAX_PROPERTY_ROWS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveProvider(request: FastifyRequest): Provider {
  const body = (request.body ?? {}) as { provider?: string };
  const query = request.query as { provider?: string };
  const candidate = body.provider ?? query?.provider ?? 'AMDS';
  return isProvider(candidate) ? candidate : 'AMDS';
}

/**
 * Everything that makes this feel like a third party rather than a local
 * function call: quota, downed providers, injected latency, and errors.
 *
 * Returns a reply when the request should be short-circuited.
 */
async function applyProviderBehaviour(
  provider: Provider,
  reply: FastifyReply,
): Promise<{ handled: boolean; latencyMs: number }> {
  await chaos.refresh();

  const aggressive = chaos.isEnabled('gds_rate_limit_aggressive');
  const limit = checkRateLimit(provider, aggressive);
  if (limit.limited) {
    reply
      .code(429)
      .header('Retry-After', String(limit.retryAfterSeconds))
      .header('X-RateLimit-Limit', String(limit.limit))
      .header('X-RateLimit-Remaining', '0')
      .send({
        error: 'rate_limited',
        provider,
        message: `Quota of ${limit.limit} requests per minute exceeded for ${provider}.`,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    return { handled: true, latencyMs: 0 };
  }

  // A downed provider times out rather than failing fast, because that is
  // what makes partial results interesting in the trace.
  if (chaos.getValue<string>('gds_provider_down', '') === provider) {
    await sleep(3_500);
    reply.code(504).send({
      error: 'provider_timeout',
      provider,
      message: `${provider} did not respond in time.`,
    });
    return { handled: true, latencyMs: 3_500 };
  }

  const baseline = baselineLatencyMs(provider);
  await sleep(baseline);
  const injected = await chaos.maybeDelay('gds_latency_ms', 'gds_latency_mode');
  const latencyMs = baseline + injected;

  const errorRate = chaos.getValue('gds_error_rate', 0) || config.baselineErrorRate;
  if (Math.random() < errorRate) {
    reply.code(503).send({
      error: 'provider_unavailable',
      provider,
      message: `${provider} is temporarily unavailable.`,
    });
    return { handled: true, latencyMs };
  }

  return { handled: false, latencyMs };
}

// ------------------------------------------------------------------ health --

app.get('/health', async () => ({
  status: 'ok',
  service: config.service,
  version: config.version,
}));

app.get('/ready', async (_request, reply) => {
  const checks: Record<string, string> = {};
  try {
    await ping();
    checks.postgres = 'ok';
  } catch (error) {
    checks.postgres = `error: ${(error as Error).message}`;
  }
  const ready = Object.values(checks).every((value) => value === 'ok');
  if (!ready) reply.code(503);
  return { status: ready ? 'ready' : 'not_ready', checks };
});

app.get('/gds/v2/providers', async () => ({ providers: PROVIDERS }));

// --------------------------------------------------------------- flights --

interface FlightAvailabilityBody {
  provider?: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  passengers?: { adults?: number; children?: number; infants?: number };
  cabin?: string;
}

app.post('/gds/v2/flights/availability', async (request, reply) => {
  const started = Date.now();
  const provider = resolveProvider(request);
  const behaviour = await applyProviderBehaviour(provider, reply);
  if (behaviour.handled) return reply;

  const body = request.body as FlightAvailabilityBody;
  if (!body?.origin || !body?.destination || !body?.departDate) {
    return reply.code(422).send({
      error: 'invalid_request',
      message: 'origin, destination and departDate are required.',
    });
  }

  const cabin = body.cabin ?? 'economy';
  const [flights, fareClasses] = await Promise.all([
    findFlights({
      origin: body.origin.toUpperCase(),
      destination: body.destination.toUpperCase(),
      departDate: body.departDate,
      limit: MAX_FLIGHTS_PER_SEARCH,
    }),
    findFareClasses(cabin),
  ]);

  const offers = buildOffers(
    provider,
    flights,
    fareClasses,
    MAX_FARE_CLASSES_PER_FLIGHT,
  );

  const requestId = randomUUID();
  const searchLatencyMs = Date.now() - started;

  // TRVP occasionally answers in its legacy schema.
  if (provider === 'TRVP' && Math.random() < TRVP_LEGACY_SCHEMA_RATE) {
    logger.info(
      { provider, requestId, offer_count: offers.length, schema: 'trvp-legacy-v1' },
      'GDS flight availability served',
    );
    return reply.send({
      provider,
      requestId,
      schemaVersion: 'trvp-legacy-v1',
      searchLatencyMs,
      results: toTrvpLegacy(offers),
    });
  }

  logger.info(
    { provider, requestId, offer_count: offers.length, schema: 'v2' },
    'GDS flight availability served',
  );
  return reply.send({
    provider,
    requestId,
    schemaVersion: 'v2',
    searchLatencyMs,
    offers,
  });
});

app.post('/gds/v2/flights/verify', async (request, reply) => {
  const provider = resolveProvider(request);
  const behaviour = await applyProviderBehaviour(provider, reply);
  if (behaviour.handled) return reply;

  const body = request.body as { offerId?: string };
  const decoded = body?.offerId ? decodeOfferId(body.offerId) : null;
  if (!decoded) {
    return reply
      .code(422)
      .send({ error: 'invalid_request', message: 'offerId is malformed.' });
  }

  const flight = await findFlightById(decoded.flightId);
  if (!flight || flight.seats_available <= 0) {
    return reply.send({
      provider,
      offerId: body.offerId,
      bookable: false,
      reason: 'inventory_unavailable',
    });
  }

  // Prices move. A "price changed" state is a real thing an OTA has to
  // handle, so it happens here occasionally.
  const priceChanged = Math.random() < 0.04;
  const fareClasses = await findFareClasses('economy');
  const offers = buildOffers(provider, [flight], fareClasses, 1);
  const current = offers[0]?.fare.totalAmountCents ?? flight.base_price_cents;

  return reply.send({
    provider,
    offerId: body.offerId,
    bookable: true,
    priceChanged,
    totalAmountCents: priceChanged ? Math.round(current * 1.06) : current,
    currency: flight.currency,
    seatsRemaining: flight.seats_available,
  });
});

app.get('/gds/v2/seatmap/:flightId', async (request, reply) => {
  const provider = resolveProvider(request);
  const behaviour = await applyProviderBehaviour(provider, reply);
  if (behaviour.handled) return reply;

  const { flightId } = request.params as { flightId: string };
  const flight = await findFlightById(flightId);
  if (!flight) {
    return reply
      .code(404)
      .send({ error: 'not_found', message: 'Unknown flight.' });
  }

  const columns = ['A', 'B', 'C', 'D', 'E', 'F'];
  const rowCount = Math.ceil(flight.seats_available / columns.length) || 1;
  const occupancy = 1 - flight.seats_available / Math.max(1, rowCount * columns.length);

  const rows = Array.from({ length: Math.min(rowCount, 40) }, (_, index) => {
    const number = index + 1;
    return {
      row: number,
      cabin: number <= 3 ? 'business' : number <= 8 ? 'economy_plus' : 'economy',
      seats: columns.map((column) => ({
        seat: `${number}${column}`,
        available: Math.random() > occupancy,
        extraLegroom: number === 1 || number === 9,
        priceCents: number <= 8 ? 2_400 : 900,
      })),
    };
  });

  return reply.send({ provider, flightId, rows });
});

// ---------------------------------------------------------------- hotels --

interface HotelAvailabilityBody {
  provider?: string;
  city: string;
  checkIn: string;
  checkOut: string;
  guests?: number;
  rooms?: number;
}

app.post('/gds/v2/hotels/availability', async (request, reply) => {
  const started = Date.now();
  const provider = resolveProvider(request);
  const behaviour = await applyProviderBehaviour(provider, reply);
  if (behaviour.handled) return reply;

  const body = request.body as HotelAvailabilityBody;
  if (!body?.city || !body?.checkIn || !body?.checkOut) {
    return reply.code(422).send({
      error: 'invalid_request',
      message: 'city, checkIn and checkOut are required.',
    });
  }

  const nights = Math.max(
    1,
    Math.round(
      (Date.parse(body.checkOut) - Date.parse(body.checkIn)) / 86_400_000,
    ),
  );
  const rows = await findProperties({
    city: body.city,
    checkIn: body.checkIn,
    checkOut: body.checkOut,
    guests: body.guests ?? 2,
    limit: MAX_PROPERTY_ROWS,
  });

  // Collapse the rate-plan rows into one entry per property.
  const byHotel = new Map<string, any>();
  for (const row of rows) {
    let property = byHotel.get(row.hotel_id);
    if (!property) {
      property = {
        propertyId: row.hotel_id,
        name: row.hotel_name,
        starRating: row.star_rating,
        reviewScore: row.review_score === null ? null : Number(row.review_score),
        reviewCount: row.review_count,
        neighborhood: row.neighborhood,
        address: row.address,
        latitude: row.latitude === null ? null : Number(row.latitude),
        longitude: row.longitude === null ? null : Number(row.longitude),
        amenities: row.amenities,
        imageSeed: row.image_seed,
        rates: [],
      };
      byHotel.set(row.hotel_id, property);
    }
    property.rates.push({
      ratePlanId: row.rate_plan_id,
      roomTypeId: row.room_type_id,
      roomName: row.room_name,
      maxOccupancy: row.max_occupancy,
      bedConfig: row.bed_config,
      rateName: row.rate_name,
      breakfastIncluded: row.breakfast_included,
      refundable: row.refundable,
      cancellationHours: row.cancellation_hours,
      nightlyPriceCents: row.nightly_price_cents,
      totalPriceCents: row.nightly_price_cents * nights * (body.rooms ?? 1),
      currency: row.currency,
      roomsAvailable: row.rooms_available,
    });
  }

  const requestId = randomUUID();
  const properties = [...byHotel.values()];
  logger.info(
    { provider, requestId, property_count: properties.length },
    'GDS hotel availability served',
  );

  return reply.send({
    provider,
    requestId,
    schemaVersion: 'v2',
    nights,
    searchLatencyMs: Date.now() - started,
    properties,
  });
});

// ------------------------------------------------------------------ boot --

async function start(): Promise<void> {
  chaos.initChaos(config.redisUrl);
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    {
      port: config.port,
      providers: PROVIDERS,
      rate_limit_per_minute: config.rateLimitPerMinute,
      baseline_error_rate: config.baselineErrorRate,
      postgres_host: config.postgres.host,
      postgres_user: config.postgres.user,
    },
    'Service started',
  );
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await chaos.closeChaos();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

start().catch((error) => {
  logger.error(
    { error: { kind: error?.constructor?.name, message: error?.message } },
    'Service failed to start',
  );
  process.exit(1);
});
