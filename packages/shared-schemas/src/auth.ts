import { z } from 'zod';
import { tierSchema } from './common';

/** Auth -- 05-FUNCTIONALITY.md § 2.1. */

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  tier: tierSchema,
  loyaltyPoints: z.number().int(),
  signupCohort: z.string().nullable().optional(),
});
export type User = z.infer<typeof userSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const signupRequestSchema = loginRequestSchema.extend({
  firstName: z.string().min(1, 'Required').max(60),
  lastName: z.string().min(1, 'Required').max(60),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const authResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const refreshResponseSchema = z.object({ accessToken: z.string() });
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
