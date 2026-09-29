import { describe, expect, it } from 'vitest';
import { detectBrand, formatCardNumber } from './cardBrand';
import { passesLuhn } from '@voyager/shared-schemas';

describe('card entry', () => {
  it('detects a scheme from the IIN', () => {
    expect(detectBrand('4242424242424242').name).toBe('Solaris');
    expect(detectBrand('5500000000000004').name).toBe('Pinnacle');
    expect(detectBrand('340000000000009').cvcLength).toBe(4);
    expect(detectBrand('').name).toBe('Card');
  });

  it('groups digits as the user types', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('34000000000000')).toBe('3400 000000 0000');
    expect(formatCardNumber('42')).toBe('42');
  });

  it('accepts the documented test cards and rejects a transposed digit', () => {
    expect(passesLuhn('4242424242424242')).toBe(true);
    expect(passesLuhn('4000000000009995')).toBe(true);
    expect(passesLuhn('4242424242424243')).toBe(false);
  });
});
