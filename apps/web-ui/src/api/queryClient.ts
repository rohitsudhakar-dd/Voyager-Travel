import { QueryClient } from '@tanstack/react-query';
import { VoyagerApiError } from './errors';

/**
 * react-query policy from 05-FUNCTIONALITY.md § 2.4.
 *
 * Mutations retry zero times. Retrying a booking creation is how you get
 * duplicate bookings, and the idempotency key only protects the payment call.
 */

export const STALE = {
  /** Search results are cached in Redis for 120 s; 30 s client-side is safe. */
  search: 30_000,
  reference: 5 * 60_000,
  /** Booking state is never stale-served: the async confirmation depends on it. */
  bookingState: 0,
} as const;

/** A 4xx is the server's considered answer -- retrying it just adds load. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof VoyagerApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
        staleTime: STALE.bookingState,
        refetchOnWindowFocus: false,
        gcTime: 5 * 60_000,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export const queryKeys = {
  home: ['bff', 'home'] as const,
  account: ['bff', 'account'] as const,
  me: ['auth', 'me'] as const,
  loyalty: ['loyalty', 'me'] as const,

  airports: (q: string) => ['ref', 'airports', q] as const,
  cities: (q: string) => ['ref', 'cities', q] as const,
  airlines: ['ref', 'airlines'] as const,

  flightSearch: (request: unknown) => ['search', 'flights', request] as const,
  hotelSearch: (request: unknown) => ['search', 'hotels', request] as const,
  searchPage: (searchId: string, page: number, sort: string) =>
    ['search', searchId, 'results', page, sort] as const,
  resultDetail: (searchId: string, resultId: string) =>
    ['search', searchId, 'result', resultId] as const,

  booking: (idOrPnr: string) => ['bff', 'booking', idOrPnr] as const,
  myBookings: (page: number) => ['bookings', 'mine', page] as const,
  payment: (id: string) => ['payments', id] as const,

  conversation: (id: string) => ['support', 'conversation', id] as const,

  chaos: ['admin', 'chaos'] as const,
  scenarios: ['admin', 'scenarios'] as const,
  adminStatus: ['admin', 'status'] as const,
  /** Read by the storefront, not the console: the frontend_* flag subset. */
  frontendChaos: ['admin', 'chaos', 'frontend'] as const,
};
