import { useQuery } from '@tanstack/react-query';
import type { AccountResponse, HomeResponse, LoyaltyAccount } from '@voyager/shared-schemas';
import { request } from '../client';
import { endpoints } from '../endpoints';
import { queryKeys } from '../queryClient';

/** BFF-backed screens -- 05-FUNCTIONALITY.md § 2.4. */

export function useHome() {
  return useQuery({
    queryKey: queryKeys.home,
    queryFn: ({ signal }) => request<HomeResponse>(endpoints.bff.home, { signal }),
    staleTime: 60_000,
  });
}

export function useAccount(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.account,
    queryFn: ({ signal }) => request<AccountResponse>(endpoints.bff.account, { signal }),
    enabled,
  });
}

export function useLoyalty(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.loyalty,
    queryFn: ({ signal }) => request<LoyaltyAccount>(endpoints.loyalty.me, { signal }),
    enabled,
  });
}
