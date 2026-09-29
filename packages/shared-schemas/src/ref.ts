import { z } from 'zod';

/** Reference data behind the autocompletes -- 05-FUNCTIONALITY.md § 2.2. */

export const airportSchema = z.object({
  iataCode: z.string().length(3),
  icaoCode: z.string().length(4).nullable().optional(),
  name: z.string(),
  cityName: z.string(),
  countryCode: z.string().length(2),
  timezone: z.string().optional(),
});
export type Airport = z.infer<typeof airportSchema>;

export const citySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  countryCode: z.string().length(2),
  region: z.string().nullable().optional(),
  popularityRank: z.number().int().nullable().optional(),
});
export type City = z.infer<typeof citySchema>;

export const airlineSchema = z.object({
  iataCode: z.string().length(2),
  name: z.string(),
  alliance: z.string().nullable().optional(),
  logoSeed: z.number().int(),
});
export type Airline = z.infer<typeof airlineSchema>;
