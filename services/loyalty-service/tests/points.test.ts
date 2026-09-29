import { describe, expect, it } from 'vitest';

import {
  computePoints,
  nextTier,
  TIER_EARN_MULTIPLIER,
  tierFor,
} from '../src/points';

describe('computePoints', () => {
  it('awards one point per whole currency unit at the base rate', () => {
    expect(
      computePoints({ eligibleCents: 41_200, fareMultiplier: 1, tier: 'standard' }),
    ).toBe(412);
  });

  it('applies the fare class and tier multipliers together', () => {
    // 412 units x 1.5 (fare class) x 2.0 (platinum)
    expect(
      computePoints({ eligibleCents: 41_200, fareMultiplier: 1.5, tier: 'platinum' }),
    ).toBe(1_236);
  });

  it('ignores the fractional currency unit', () => {
    expect(
      computePoints({ eligibleCents: 199, fareMultiplier: 1, tier: 'standard' }),
    ).toBe(1);
  });

  it('never awards negative points', () => {
    expect(
      computePoints({ eligibleCents: -500, fareMultiplier: 1, tier: 'gold' }),
    ).toBe(0);
  });

  it('has a multiplier for every tier', () => {
    expect(Object.values(TIER_EARN_MULTIPLIER).every((m) => m >= 1)).toBe(true);
  });
});

describe('tierFor', () => {
  it.each([
    [0, 'standard'],
    [24_999, 'standard'],
    [25_000, 'silver'],
    [74_999, 'silver'],
    [75_000, 'gold'],
    [199_999, 'gold'],
    [200_000, 'platinum'],
    [10_000_000, 'platinum'],
  ])('maps %i lifetime points to %s', (points, tier) => {
    expect(tierFor(points)).toBe(tier);
  });
});

describe('nextTier', () => {
  it('reports what is left to reach the next tier', () => {
    expect(nextTier(30_000)).toEqual({
      tier: 'gold',
      pointsRequired: 75_000,
      pointsRemaining: 45_000,
    });
  });

  it('is null at the top tier', () => {
    expect(nextTier(250_000)).toBeNull();
  });
});
