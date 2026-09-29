import { z } from 'zod';
import {
  bookingItemTypeSchema,
  bookingStateSchema,
  currencySchema,
  passengerTypeSchema,
  productTypeSchema,
} from './common';
import { searchResultSchema } from './search';

/** Booking lifecycle payloads -- 05-FUNCTIONALITY.md § 2.5 and § 8. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Age at travel drives which passenger type is legal (§ 15). */
export const AGE_BOUNDS: Record<z.infer<typeof passengerTypeSchema>, [number, number]> = {
  adult: [12, 120],
  child: [2, 11],
  infant: [0, 1],
};

export const passengerInputSchema = z.object({
  passengerType: passengerTypeSchema,
  title: z.string().min(1, 'Required'),
  firstName: z.string().min(1, 'Required').max(60),
  lastName: z.string().min(1, 'Required').max(60),
  dateOfBirth: isoDate,
  nationality: z.string().length(2, 'Two-letter country code'),
  passportNumber: z.string().max(20).optional().or(z.literal('')),
  frequentFlyerNumber: z.string().max(20).optional().or(z.literal('')),
});
export type PassengerInput = z.infer<typeof passengerInputSchema>;

export const passengersRequestSchema = z.object({
  passengers: z.array(passengerInputSchema).min(1).max(9),
  contactEmail: z.string().email('Enter a valid email'),
  contactPhone: z.string().min(6, 'Enter a contact number').max(24),
});
export type PassengersRequest = z.infer<typeof passengersRequestSchema>;

export const passengerSchema = passengerInputSchema.extend({
  id: z.number().int(),
  seatAssignment: z.string().nullable(),
});
export type Passenger = z.infer<typeof passengerSchema>;

export const bookingItemSchema = z.object({
  id: z.number().int(),
  itemType: bookingItemTypeSchema,
  description: z.string(),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  totalPriceCents: z.number().int(),
});
export type BookingItem = z.infer<typeof bookingItemSchema>;

export const bookingSchema = z.object({
  id: z.string().uuid(),
  pnr: z.string().length(6).nullable(),
  productType: productTypeSchema,
  state: bookingStateSchema,
  currency: currencySchema,
  subtotalCents: z.number().int(),
  taxesCents: z.number().int(),
  ancillariesCents: z.number().int(),
  totalCents: z.number().int(),
  searchId: z.string().nullable(),
  resultId: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  holdExpiresAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  items: z.array(bookingItemSchema),
  passengers: z.array(passengerSchema),
  createdAt: z.string(),
});
export type Booking = z.infer<typeof bookingSchema>;

export const checkoutInitRequestSchema = z.object({
  searchId: z.string(),
  resultId: z.string(),
  productType: productTypeSchema,
});
export type CheckoutInitRequest = z.infer<typeof checkoutInitRequestSchema>;

/**
 * The response shape for `POST /bff/checkout/init` is not specified; this is
 * what the checkout screens need in one round trip. `priceChanged` exists
 * because the re-price step in § 8 can legitimately move the price.
 */
export const checkoutInitResponseSchema = z.object({
  booking: bookingSchema,
  offer: searchResultSchema,
  holdExpiresAt: z.string(),
  pointsPreview: z.number().int(),
  priceChanged: z.boolean(),
  previousTotalCents: z.number().int().nullable(),
  requestId: z.string(),
});
export type CheckoutInitResponse = z.infer<typeof checkoutInitResponseSchema>;

export const seatSelectionSchema = z.object({
  passengerIndex: z.number().int().min(0),
  seat: z.string().min(2).max(4),
  priceCents: z.number().int().min(0),
});

export const baggageSelectionSchema = z.object({
  passengerIndex: z.number().int().min(0),
  extraBags: z.number().int().min(0).max(3),
  priceCents: z.number().int().min(0),
});

export const ancillariesRequestSchema = z.object({
  seats: z.array(seatSelectionSchema).default([]),
  baggage: z.array(baggageSelectionSchema).default([]),
  roomUpgrade: z.string().nullable().default(null),
  insurance: z.boolean().default(false),
  breakfast: z.boolean().default(false),
});
export type AncillariesRequest = z.infer<typeof ancillariesRequestSchema>;

export const cancelRequestSchema = z.object({
  reason: z.string().min(1).max(200),
});
export type CancelRequest = z.infer<typeof cancelRequestSchema>;

/** `GET /bookings?pnr=&lastName=` -- guest lookup, no auth. */
export const bookingLookupSchema = z.object({
  pnr: z
    .string()
    .trim()
    .length(6, 'A PNR is six characters')
    // The PNR alphabet deliberately excludes 0, 1, I and O.
    .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/i, 'That is not a valid PNR'),
  lastName: z.string().trim().min(1, 'Enter the surname on the booking'),
});
export type BookingLookup = z.infer<typeof bookingLookupSchema>;
