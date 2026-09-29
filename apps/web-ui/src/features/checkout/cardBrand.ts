/**
 * Card schemes in Voyager are invented, like every other brand in the product.
 * The IINs below are the ones `mock-payments` recognises (05-FUNCTIONALITY.md
 * § 5.2); the names attached to them are ours.
 */
const BRANDS: { name: string; test: RegExp; cvcLength: number }[] = [
  { name: 'Solaris', test: /^4/, cvcLength: 3 },
  { name: 'Pinnacle', test: /^5[1-5]/, cvcLength: 3 },
  { name: 'Beacon', test: /^3[47]/, cvcLength: 4 },
  { name: 'Trellis', test: /^6/, cvcLength: 3 },
];

export interface CardBrand {
  name: string;
  cvcLength: number;
}

export const UNKNOWN_BRAND: CardBrand = { name: 'Card', cvcLength: 3 };

export function detectBrand(number: string): CardBrand {
  const digits = number.replace(/\D/g, '');
  const match = BRANDS.find((brand) => brand.test.test(digits));
  return match ? { name: match.name, cvcLength: match.cvcLength } : UNKNOWN_BRAND;
}

/** 4-4-4-4, or 4-6-5 for the 15-digit scheme. */
export function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 19);
  const groups = /^3[47]/.test(digits) ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let cursor = 0;
  for (const size of groups) {
    if (cursor >= digits.length) break;
    parts.push(digits.slice(cursor, cursor + size));
    cursor += size;
  }
  return parts.join(' ');
}

export function maskedNumber(last4: string, brand: string): string {
  return `${brand} ···· ${last4}`;
}
