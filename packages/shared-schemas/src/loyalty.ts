import { z } from 'zod';
import { tierSchema } from './common';

/** `GET /loyalty/me` -- 05-FUNCTIONALITY.md § 2.7. */

export const loyaltyTransactionSchema = z.object({
  id: z.number().int(),
  transactionType: z.enum(['accrual', 'redemption', 'adjustment', 'expiry']),
  points: z.number().int(),
  balanceAfter: z.number().int(),
  description: z.string(),
  bookingId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type LoyaltyTransaction = z.infer<typeof loyaltyTransactionSchema>;

export const loyaltyAccountSchema = z.object({
  pointsBalance: z.number().int(),
  lifetimePoints: z.number().int(),
  tier: tierSchema,
  nextTier: tierSchema.nullable(),
  pointsToNextTier: z.number().int().nullable(),
  transactions: z.array(loyaltyTransactionSchema),
});
export type LoyaltyAccount = z.infer<typeof loyaltyAccountSchema>;
