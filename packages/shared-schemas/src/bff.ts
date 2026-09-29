import { z } from 'zod';
import { currencySchema, productTypeSchema, tierSchema } from './common';
import { bookingSchema } from './booking';
import { loyaltyAccountSchema } from './loyalty';
import { paymentSchema } from './payment';
import { airportSchema } from './ref';

/**
 * BFF aggregation responses -- 05-FUNCTIONALITY.md § 2.4.
 *
 * The document names each endpoint's fan-out but not its response body. These
 * shapes are what the screens in 06-USER-FLOWS.md need in a single round trip;
 * the gateway is the authority if it diverges.
 */

export const dealSchema = z.object({
  id: z.string(),
  productType: productTypeSchema,
  origin: z.string().length(3).nullable(),
  destination: z.string().length(3).nullable(),
  cityName: z.string(),
  headline: z.string(),
  fromPriceCents: z.number().int(),
  currency: currencySchema,
  imageSeed: z.number().int(),
});
export type Deal = z.infer<typeof dealSchema>;

export const upcomingTripSchema = z.object({
  bookingId: z.string().uuid(),
  pnr: z.string().length(6),
  productType: productTypeSchema,
  headline: z.string(),
  departAt: z.string(),
  origin: z.string().length(3).nullable(),
  destination: z.string().length(3).nullable(),
});
export type UpcomingTrip = z.infer<typeof upcomingTripSchema>;

export const homeResponseSchema = z.object({
  popularAirports: z.array(airportSchema),
  deals: z.array(dealSchema),
  upcomingTrips: z.array(upcomingTripSchema),
  loyalty: z
    .object({ tier: tierSchema, pointsBalance: z.number().int() })
    .nullable(),
  requestId: z.string(),
});
export type HomeResponse = z.infer<typeof homeResponseSchema>;

/** `GET /bff/booking/{idOrPnr}` -- booking + payment status + accrual. */
export const bookingDetailResponseSchema = z.object({
  booking: bookingSchema,
  payment: paymentSchema.nullable(),
  loyalty: z
    .object({ pointsEarned: z.number().int(), accrued: z.boolean() })
    .nullable(),
  /** False until notification-worker has sent the itinerary -- scenario S5. */
  emailSent: z.boolean(),
  cancellationPolicy: z.object({
    refundable: z.boolean(),
    penaltyCents: z.number().int(),
    refundCents: z.number().int(),
    summary: z.string(),
  }),
  requestId: z.string(),
});
export type BookingDetailResponse = z.infer<typeof bookingDetailResponseSchema>;

export const savedPaymentMethodSchema = z.object({
  id: z.string(),
  cardBrand: z.string(),
  cardLast4: z.string().length(4),
  expiryMonth: z.number().int(),
  expiryYear: z.number().int(),
});
export type SavedPaymentMethod = z.infer<typeof savedPaymentMethodSchema>;

export const bookingSummarySchema = z.object({
  id: z.string().uuid(),
  pnr: z.string().length(6).nullable(),
  productType: productTypeSchema,
  state: bookingSchema.shape.state,
  headline: z.string(),
  travelDate: z.string().nullable(),
  totalCents: z.number().int(),
  currency: currencySchema,
  createdAt: z.string(),
});
export type BookingSummary = z.infer<typeof bookingSummarySchema>;

export const accountResponseSchema = z.object({
  bookings: z.array(bookingSummarySchema),
  bookingsTotal: z.number().int(),
  loyalty: loyaltyAccountSchema,
  savedPaymentMethods: z.array(savedPaymentMethodSchema),
  requestId: z.string(),
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;

/** `GET /bookings/mine?page=&size=` -- the query scenario S3 wrecks. */
export const myBookingsResponseSchema = z.object({
  bookings: z.array(bookingSummarySchema),
  page: z.number().int(),
  size: z.number().int(),
  total: z.number().int(),
  requestId: z.string(),
});
export type MyBookingsResponse = z.infer<typeof myBookingsResponseSchema>;
