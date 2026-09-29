import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriceTag } from './PriceTag';

describe('PriceTag', () => {
  it('renders whole pounds without decimals and keeps them legible in replay', () => {
    render(<PriceTag cents={48_900} currency="GBP" />);
    const price = screen.getByTestId('price-tag');

    expect(price).toHaveTextContent('£489');
    expect(price).toHaveAttribute('data-dd-privacy', 'allow');
  });

  it('keeps pence when the amount is not whole', () => {
    render(<PriceTag cents={48_950} currency="GBP" />);
    expect(screen.getByTestId('price-tag')).toHaveTextContent('£489.50');
  });

  it('marks a from-price so the row is not read as an exact quote', () => {
    render(<PriceTag cents={32_900} currency="GBP" from />);
    expect(screen.getByTestId('price-tag')).toHaveTextContent(/from/i);
  });
});
