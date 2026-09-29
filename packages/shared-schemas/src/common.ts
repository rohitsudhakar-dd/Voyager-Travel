import { z } from 'zod';

/**
 * Enumerations and the error envelope, shared by every endpoint.
 *
 * Wire format is camelCase; the database is snake_case. The translation
 * happens in the services, never in the browser.
 */

export const cabinSchema = z.enum(['economy', 'economy_plus', 'business', 'first']);
export type Cabin = z.infer<typeof cabinSchema>;

export const productTypeSchema = z.enum(['flight', 'hotel']);
export type ProductType = z.infer<typeof productTypeSchema>;

export const tierSchema = z.enum(['standard', 'silver', 'gold', 'platinum']);
export type Tier = z.infer<typeof tierSchema>;

export const bookingStateSchema = z.enum([
  'DRAFT',
  'HELD',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]);
export type BookingState = z.infer<typeof bookingStateSchema>;

export const paymentStateSchema = z.enum([
  'CREATED',
  'AUTHORIZING',
  'AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DECLINED',
  'REQUIRES_3DS',
  'ERROR',
]);
export type PaymentState = z.infer<typeof paymentStateSchema>;

/** The five codes in 05-FUNCTIONALITY.md § 5.2, and only those five. */
export const declineCodeSchema = z.enum([
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'do_not_honor',
  'fraud_suspected',
]);
export type DeclineCode = z.infer<typeof declineCodeSchema>;

export const bookingItemTypeSchema = z.enum([
  'flight_segment',
  'room_night',
  'seat',
  'baggage',
  'upgrade',
  'insurance',
]);
export type BookingItemType = z.infer<typeof bookingItemTypeSchema>;

export const passengerTypeSchema = z.enum(['adult', 'child', 'infant']);
export type PassengerType = z.infer<typeof passengerTypeSchema>;

/**
 * Sort keys are not enumerated in the specification; this is the set the UI
 * offers. `price_asc` is the only one the docs name explicitly.
 */
export const sortKeySchema = z.enum([
  'price_asc',
  'price_desc',
  'duration_asc',
  'depart_asc',
  'rating_desc',
]);
export type SortKey = z.infer<typeof sortKeySchema>;

export const currencySchema = z.string().length(3);

/** 05-FUNCTIONALITY.md § 13.1 -- stable, low-cardinality type names. */
export const errorTypeSchema = z.enum([
  'VoyagerError',
  'ValidationError',
  'InvalidSearchCriteriaError',
  'InvalidPassengerDataError',
  'AuthenticationError',
  'AuthorizationError',
  'NotFoundError',
  'BookingNotFoundError',
  'SearchResultExpiredError',
  'ConflictError',
  'InvalidBookingTransitionError',
  'DuplicateIdempotencyKeyError',
  'BusinessRuleError',
  'InventoryUnavailableError',
  'HoldExpiredError',
  'PaymentDeclinedError',
  'PriceChangedError',
  'RateLimitError',
  'DependencyError',
  'GdsUnavailableError',
  'GdsTimeoutError',
  'PaymentProviderError',
  'DatabaseError',
  'CacheError',
  'LlmProviderError',
]);
export type VoyagerErrorType = z.infer<typeof errorTypeSchema>;

/** 05-FUNCTIONALITY.md § 13.2. `traceId` is returned on purpose: it is what
 *  lets an operator read an id off the screen and paste it into Datadog. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const pageSchema = z.object({
  page: z.number().int().min(1),
  size: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});
export type Page = z.infer<typeof pageSchema>;
