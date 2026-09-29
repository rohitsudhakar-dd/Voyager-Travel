import { z } from 'zod';
import { cabinSchema, currencySchema, sortKeySchema } from './common';
import { airlineSchema } from './ref';

/**
 * Search request/response -- 05-FUNCTIONALITY.md § 2.3, with the business
 * rules from § 15 enforced client-side for usability. The server validates
 * independently; the client is never trusted.
 *
 * Fields beyond `maxStops`, `airlines` and `departWindow` on the filter
 * objects are not named in the specification but are required by the filter
 * sidebar in 04-STYLING.md § 4.4.
 */

const MAX_DAYS_AHEAD = 360;
const MAX_TRIP_DAYS = 90;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const today = () => new Date().toISOString().slice(0, 10);

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export const passengerCountsSchema = z
  .object({
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(8),
    infants: z.number().int().min(0).max(9),
  })
  .refine((p) => p.adults + p.children + p.infants <= 9, {
    message: 'Up to 9 travellers per booking',
    path: ['adults'],
  })
  .refine((p) => p.infants <= p.adults, {
    message: 'Each infant must travel with an adult',
    path: ['infants'],
  });
export type PassengerCounts = z.infer<typeof passengerCountsSchema>;

export const flightFiltersSchema = z.object({
  maxStops: z.number().int().min(0).max(3).optional(),
  airlines: z.array(z.string().length(2)).optional(),
  departWindow: z.tuple([z.string(), z.string()]).optional(),
  maxPriceCents: z.number().int().positive().optional(),
  minPriceCents: z.number().int().min(0).optional(),
  maxDurationMinutes: z.number().int().positive().optional(),
});
export type FlightFilters = z.infer<typeof flightFiltersSchema>;

export const flightSearchRequestSchema = z
  .object({
    origin: z.string().length(3).toUpperCase(),
    destination: z.string().length(3).toUpperCase(),
    departDate: isoDate,
    returnDate: isoDate.optional(),
    passengers: passengerCountsSchema,
    cabin: cabinSchema,
    sort: sortKeySchema.optional(),
    filters: flightFiltersSchema.optional(),
  })
  .refine((r) => r.origin !== r.destination, {
    message: 'Origin and destination must differ',
    path: ['destination'],
  })
  .refine((r) => daysBetween(today(), r.departDate) >= 0, {
    message: 'Departure cannot be in the past',
    path: ['departDate'],
  })
  .refine((r) => daysBetween(today(), r.departDate) <= MAX_DAYS_AHEAD, {
    message: `We sell up to ${MAX_DAYS_AHEAD} days ahead`,
    path: ['departDate'],
  })
  .refine((r) => !r.returnDate || daysBetween(r.departDate, r.returnDate) > 0, {
    message: 'Return must be after departure',
    path: ['returnDate'],
  })
  .refine((r) => !r.returnDate || daysBetween(r.departDate, r.returnDate) <= MAX_TRIP_DAYS, {
    message: `Trips can be at most ${MAX_TRIP_DAYS} days`,
    path: ['returnDate'],
  });
export type FlightSearchRequest = z.infer<typeof flightSearchRequestSchema>;

export const hotelFiltersSchema = z.object({
  starRating: z.array(z.number().int().min(1).max(5)).optional(),
  minReviewScore: z.number().min(0).max(10).optional(),
  amenities: z.array(z.string()).optional(),
  maxPriceCents: z.number().int().positive().optional(),
  minPriceCents: z.number().int().min(0).optional(),
  neighborhoods: z.array(z.string()).optional(),
});
export type HotelFilters = z.infer<typeof hotelFiltersSchema>;

export const hotelSearchRequestSchema = z
  .object({
    city: z.string().min(1),
    checkIn: isoDate,
    checkOut: isoDate,
    guests: z.number().int().min(1).max(9),
    rooms: z.number().int().min(1).max(5),
    sort: sortKeySchema.optional(),
    filters: hotelFiltersSchema.optional(),
  })
  .refine((r) => daysBetween(today(), r.checkIn) >= 0, {
    message: 'Check-in cannot be in the past',
    path: ['checkIn'],
  })
  .refine((r) => daysBetween(r.checkIn, r.checkOut) >= 1, {
    message: 'Stays are at least one night',
    path: ['checkOut'],
  })
  .refine((r) => daysBetween(r.checkIn, r.checkOut) <= 30, {
    message: 'Stays are at most 30 nights',
    path: ['checkOut'],
  });
export type HotelSearchRequest = z.infer<typeof hotelSearchRequestSchema>;

export const segmentSchema = z.object({
  flightNumber: z.string(),
  airlineCode: z.string().length(2),
  origin: z.string().length(3),
  destination: z.string().length(3),
  departAt: z.string(),
  arriveAt: z.string(),
  aircraftType: z.string().nullable(),
  durationMinutes: z.number().int(),
});
export type Segment = z.infer<typeof segmentSchema>;

export const fareSchema = z.object({
  fareClassCode: z.string(),
  cabin: cabinSchema,
  refundable: z.boolean(),
  changeable: z.boolean(),
  baggageIncluded: z.number().int(),
  baseCents: z.number().int(),
  taxesCents: z.number().int(),
  totalCents: z.number().int(),
  currency: currencySchema,
  seatsRemaining: z.number().int(),
});
export type Fare = z.infer<typeof fareSchema>;

export const flightResultSchema = z.object({
  id: z.string(),
  productType: z.literal('flight'),
  segments: z.array(segmentSchema).min(1),
  fare: fareSchema,
  airline: airlineSchema,
  durationMinutes: z.number().int(),
  stops: z.number().int().min(0),
  provider: z.string(),
});
export type FlightResult = z.infer<typeof flightResultSchema>;

export const hotelResultSchema = z.object({
  id: z.string(),
  productType: z.literal('hotel'),
  name: z.string(),
  cityName: z.string(),
  neighborhood: z.string().nullable(),
  starRating: z.number().int().min(1).max(5),
  reviewScore: z.number(),
  reviewCount: z.number().int(),
  amenities: z.array(z.string()),
  imageSeed: z.number().int(),
  roomName: z.string(),
  ratePlanName: z.string(),
  breakfastIncluded: z.boolean(),
  refundable: z.boolean(),
  nights: z.number().int().min(1),
  nightlyPriceCents: z.number().int(),
  taxesCents: z.number().int(),
  totalCents: z.number().int(),
  currency: currencySchema,
  roomsAvailable: z.number().int(),
  provider: z.string(),
});
export type HotelResult = z.infer<typeof hotelResultSchema>;

export const searchResultSchema = z.union([flightResultSchema, hotelResultSchema]);
export type SearchResult = z.infer<typeof searchResultSchema>;

const searchEnvelope = {
  searchId: z.string(),
  cacheHit: z.boolean(),
  providersQueried: z.number().int(),
  providersResponded: z.number().int(),
  resultCount: z.number().int(),
  requestId: z.string(),
};

export const flightSearchResponseSchema = z.object({
  ...searchEnvelope,
  results: z.array(flightResultSchema),
});
export type FlightSearchResponse = z.infer<typeof flightSearchResponseSchema>;

export const hotelSearchResponseSchema = z.object({
  ...searchEnvelope,
  results: z.array(hotelResultSchema),
});
export type HotelSearchResponse = z.infer<typeof hotelSearchResponseSchema>;

/** `GET /search/{searchId}/results/{resultId}` -- fare rules, baggage, seat map. */
export const resultDetailSchema = z.object({
  searchId: z.string(),
  result: searchResultSchema,
  fareRules: z.array(z.object({ label: z.string(), value: z.string() })),
  baggageAllowance: z.object({
    cabinBags: z.number().int(),
    checkedBags: z.number().int(),
    checkedWeightKg: z.number().int(),
  }),
  cancellationPolicy: z.object({
    refundable: z.boolean(),
    penaltyCents: z.number().int(),
    freeCancellationUntil: z.string().nullable(),
    summary: z.string(),
  }),
  seatMapAvailable: z.boolean(),
  requestId: z.string(),
});
export type ResultDetail = z.infer<typeof resultDetailSchema>;
