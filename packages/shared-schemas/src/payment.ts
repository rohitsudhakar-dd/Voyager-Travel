import { z } from 'zod';
import { currencySchema, declineCodeSchema, paymentStateSchema } from './common';

/** Payment payloads -- 05-FUNCTIONALITY.md § 2.6 and § 15. */

/** Luhn, so an obviously-wrong number fails before it reaches the network. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const strippedNumber = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .refine((value) => /^\d{13,19}$/.test(value), 'Enter a 13 to 19 digit card number')
  .refine(passesLuhn, 'That card number is not valid');

export const cardInputSchema = z.object({
  number: strippedNumber,
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(2099),
  cvc: z.string().regex(/^\d{3,4}$/, 'Three or four digits'),
  holderName: z.string().min(2, 'Name as printed on the card').max(60),
  billingCountry: z.string().length(2, 'Two-letter country code'),
});
export type CardInput = z.infer<typeof cardInputSchema>;

export const authorizeRequestSchema = z.object({
  bookingId: z.string().uuid(),
  amount: z.number().int().positive(),
  currency: currencySchema,
  card: cardInputSchema,
  idempotencyKey: z.string().min(8),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;

export const paymentSchema = z.object({
  id: z.string().uuid(),
  bookingId: z.string().uuid(),
  provider: z.string(),
  state: paymentStateSchema,
  amountCents: z.number().int(),
  currency: currencySchema,
  cardLast4: z.string().length(4),
  cardBrand: z.string(),
  declineCode: declineCodeSchema.nullable(),
  failureMessage: z.string().nullable(),
  requires3ds: z.boolean(),
  authorizedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const threeDsCompleteRequestSchema = z.object({
  challengeResponse: z.string().min(1),
});
export type ThreeDsCompleteRequest = z.infer<typeof threeDsCompleteRequestSchema>;
