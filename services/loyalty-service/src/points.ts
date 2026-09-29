/**
 * Accrual and tier arithmetic. Pure functions, so the rules are unit-testable
 * without a database.
 *
 * The multipliers and thresholds below are not specified anywhere in the
 * docs, so they are defined here once and nowhere else. Two rules are worth
 * stating because they are business decisions rather than arithmetic:
 *  - taxes never earn points, so only the fare and the ancillaries count;
 *  - tier is derived from `lifetime_points`, which never decreases, so a tier
 *    is never silently lost when points are spent.
 */

export const TIERS = ['standard', 'silver', 'gold', 'platinum'] as const;
export type Tier = (typeof TIERS)[number];

/** Earn rate on the eligible spend, by the tier held at the time of travel. */
export const TIER_EARN_MULTIPLIER: Record<Tier, number> = {
  standard: 1.0,
  silver: 1.25,
  gold: 1.5,
  platinum: 2.0,
};

/** Lifetime points needed to hold each tier, highest first. */
export const TIER_THRESHOLDS: Array<{ tier: Tier; lifetimePoints: number }> = [
  { tier: 'platinum', lifetimePoints: 200_000 },
  { tier: 'gold', lifetimePoints: 75_000 },
  { tier: 'silver', lifetimePoints: 25_000 },
  { tier: 'standard', lifetimePoints: 0 },
];

/** One point per whole currency unit of eligible spend, before multipliers. */
const POINTS_PER_CURRENCY_UNIT = 1;

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

export interface AccrualInput {
  /** Fare plus ancillaries, in cents. Taxes are excluded by the caller. */
  eligibleCents: number;
  /** `fare_classes.points_multiplier`; 1.0 when the fare class is unknown. */
  fareMultiplier: number;
  tier: Tier;
}

export function computePoints(input: AccrualInput): number {
  if (input.eligibleCents <= 0) return 0;
  const units = Math.floor(input.eligibleCents / 100) * POINTS_PER_CURRENCY_UNIT;
  const multiplier = input.fareMultiplier * TIER_EARN_MULTIPLIER[input.tier];
  return Math.round(units * multiplier);
}

export function tierFor(lifetimePoints: number): Tier {
  for (const threshold of TIER_THRESHOLDS) {
    if (lifetimePoints >= threshold.lifetimePoints) return threshold.tier;
  }
  return 'standard';
}

export interface TierProgress {
  tier: Tier;
  pointsRequired: number;
  pointsRemaining: number;
}

/** Null at platinum: there is nothing left to progress towards. */
export function nextTier(lifetimePoints: number): TierProgress | null {
  const ascending = [...TIER_THRESHOLDS].reverse();
  for (const threshold of ascending) {
    if (threshold.lifetimePoints > lifetimePoints) {
      return {
        tier: threshold.tier,
        pointsRequired: threshold.lifetimePoints,
        pointsRemaining: threshold.lifetimePoints - lifetimePoints,
      };
    }
  }
  return null;
}
