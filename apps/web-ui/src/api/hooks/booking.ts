import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AncillariesRequest,
  AuthorizeRequest,
  Booking,
  BookingDetailResponse,
  CheckoutInitRequest,
  CheckoutInitResponse,
  MyBookingsResponse,
  PassengersRequest,
  Payment,
} from '@voyager/shared-schemas';
import { request } from '../client';
import { endpoints } from '../endpoints';
import { STALE, queryKeys } from '../queryClient';

/** Checkout, confirmation and manage-booking calls -- 05-FUNCTIONALITY.md § 8. */

/** The async confirmation poll: every second, giving up after 30 s (§ 8.7). */
const CONFIRMATION_POLL_MS = 1_000;
const CONFIRMATION_POLL_LIMIT = 30;

const SETTLED_STATES = new Set(['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']);

export function useCheckoutInit() {
  return useMutation({
    mutationFn: (body: CheckoutInitRequest) =>
      request<CheckoutInitResponse>(endpoints.bff.checkoutInit, { method: 'POST', body }),
  });
}

export function useBookingDetail(
  idOrPnr: string | undefined,
  options: { pollForConfirmation?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.booking(idOrPnr ?? ''),
    queryFn: ({ signal }) =>
      request<BookingDetailResponse>(endpoints.bff.booking(idOrPnr!), { signal }),
    enabled: Boolean(idOrPnr),
    staleTime: STALE.bookingState,
    refetchInterval: (query) => {
      if (!options.pollForConfirmation) return false;
      if (query.state.dataUpdateCount >= CONFIRMATION_POLL_LIMIT) return false;
      const state = query.state.data?.booking.state;
      if (state && SETTLED_STATES.has(state)) return false;
      return CONFIRMATION_POLL_MS;
    },
  });
}

export function useSavePassengers(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PassengersRequest) =>
      request<{ booking: Booking }>(endpoints.bookings.passengers(bookingId), {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.booking(bookingId) });
    },
  });
}

export function useSaveAncillaries(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AncillariesRequest) =>
      request<{ booking: Booking }>(endpoints.bookings.ancillaries(bookingId), {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.booking(bookingId) });
    },
  });
}

export interface AuthorizeResult {
  payment: Payment;
  booking: Booking;
  /** Present only on the step-up path; the UI opens the 3DS modal with it. */
  threeDsChallenge: { challengeId: string; prompt: string } | null;
}

/**
 * The idempotency key travels in the header *and* the body, and the two must
 * match (05-FUNCTIONALITY.md § 2.6). It is minted once per attempt by the
 * caller so that a network-level retry replays instead of double-charging.
 */
export function useAuthorizePayment() {
  return useMutation({
    mutationFn: (body: AuthorizeRequest) =>
      request<AuthorizeResult>(endpoints.payments.authorize, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': body.idempotencyKey },
      }),
  });
}

export function useComplete3ds(paymentId: string) {
  return useMutation({
    mutationFn: (challengeResponse: string) =>
      request<AuthorizeResult>(endpoints.payments.threeDsComplete(paymentId), {
        method: 'POST',
        body: { challengeResponse },
      }),
  });
}

export function useCancelBooking(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      request<{ booking: Booking; refundCents: number }>(endpoints.bookings.cancel(bookingId), {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.booking(bookingId) });
      if (result.booking.pnr) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.booking(result.booking.pnr) });
      }
    },
  });
}

/** Guest lookup by PNR and surname -- no auth (05-FUNCTIONALITY.md § 2.5). */
export function useBookingLookup() {
  return useMutation({
    mutationFn: (params: { pnr: string; lastName: string }) =>
      request<{ booking: Booking }>(endpoints.bookings.lookup, {
        query: { pnr: params.pnr.toUpperCase(), lastName: params.lastName },
      }),
  });
}

/** The query scenario S3 wrecks. Page 1 arrives with `GET /bff/account`. */
export function useMyBookings(page: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.myBookings(page),
    queryFn: ({ signal }) =>
      request<MyBookingsResponse>(endpoints.bookings.mine, {
        query: { page, size: 20 },
        signal,
      }),
    enabled,
    staleTime: STALE.bookingState,
  });
}
