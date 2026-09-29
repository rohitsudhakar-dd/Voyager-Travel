import type { Location } from 'react-router-dom';

/**
 * `POST /bff/checkout/init` returns the re-price outcome and the points preview,
 * neither of which `GET /bff/booking/{id}` repeats. Rather than add a second
 * call, the selecting screen hands them to the review step through router state;
 * a reload simply loses the banner, which is the correct behaviour anyway.
 */
export interface CheckoutHandoff {
  priceChanged: boolean;
  previousTotalCents: number | null;
  pointsPreview: number;
}

export function readHandoff(location: Location): CheckoutHandoff | null {
  const state = location.state as { checkout?: CheckoutHandoff } | null;
  return state?.checkout ?? null;
}
