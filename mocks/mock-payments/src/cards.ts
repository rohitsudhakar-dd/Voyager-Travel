/**
 * Test cards and decline codes (05-FUNCTIONALITY.md § 5.2).
 *
 * The test-card table is what makes a demo repeatable: you type a number on
 * stage and you know exactly what the audience is about to see. Everything
 * else falls back to the probabilistic path.
 */

/** Exactly these five codes may ever appear. No others. */
export const DECLINE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'do_not_honor',
  'fraud_suspected',
] as const;

export type DeclineCode = (typeof DECLINE_CODES)[number];

export const DECLINE_MESSAGES: Record<DeclineCode, string> = {
  card_declined: 'Your card was declined. Please try another payment method.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
  do_not_honor: 'Your card issuer declined the transaction.',
  fraud_suspected: 'This transaction was flagged by our fraud checks.',
};

/** Weights for the `mixed` decline mix; they sum to 1. */
const MIXED_WEIGHTS: Array<[DeclineCode, number]> = [
  ['card_declined', 0.34],
  ['insufficient_funds', 0.28],
  ['expired_card', 0.16],
  ['do_not_honor', 0.14],
  ['fraud_suspected', 0.08],
];

export function pickDeclineCode(mix: string): DeclineCode {
  if ((DECLINE_CODES as readonly string[]).includes(mix)) {
    return mix as DeclineCode;
  }
  let roll = Math.random();
  for (const [code, weight] of MIXED_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return code;
  }
  return 'card_declined';
}

export type CardOutcome =
  | { kind: 'approve' }
  | { kind: 'decline'; code: DeclineCode }
  | { kind: 'requires_3ds' }
  | { kind: 'error' }
  | { kind: 'unknown' };

/**
 * Deterministic outcomes, keyed on the digits only so that formatting with
 * spaces or dashes in the UI makes no difference.
 */
const TEST_CARDS: Record<string, CardOutcome> = {
  '4242424242424242': { kind: 'approve' },
  '4000000000000002': { kind: 'decline', code: 'card_declined' },
  '4000000000009995': { kind: 'decline', code: 'insufficient_funds' },
  '4000000000000069': { kind: 'decline', code: 'expired_card' },
  '4000000000000127': { kind: 'decline', code: 'do_not_honor' },
  '4100000000000019': { kind: 'decline', code: 'fraud_suspected' },
  '4000000000003220': { kind: 'requires_3ds' },
  '4000000000000119': { kind: 'error' },
};

export function normalizeCardNumber(input: string): string {
  return (input ?? '').replace(/\D/g, '');
}

export function testCardOutcome(digits: string): CardOutcome {
  return TEST_CARDS[digits] ?? { kind: 'unknown' };
}

/**
 * Invented card brands -- real scheme names are brands like any other, and
 * this project does not reproduce them. Matches the seeder's IIN map.
 */
const BRAND_BY_IIN: Record<string, string> = {
  '4': 'meridian',
  '5': 'cobalt',
  '3': 'summit',
  '6': 'orbit',
};

export function brandFor(digits: string): string {
  return BRAND_BY_IIN[digits.slice(0, 1)] ?? 'meridian';
}

export function lastFour(digits: string): string {
  return digits.slice(-4);
}

/** The Luhn check, so an obviously invalid number gets a 422 rather than a decline. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
