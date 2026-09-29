import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  FlightSearchRequest,
  FlightSearchResponse,
  HotelSearchRequest,
  HotelSearchResponse,
  ResultDetail,
  SearchResult,
  SortKey,
} from '@voyager/shared-schemas';
import { request } from '../client';
import { endpoints } from '../endpoints';
import { STALE, queryKeys } from '../queryClient';

/**
 * Search is a POST, so it is a mutation in react-query terms even though it is
 * read-only. Filter and sort changes re-POST: the filters are part of the
 * normalised search hash, so a changed filter is a different (usually cached)
 * search, which is what produces the short cache-hit traces in
 * 06-USER-FLOWS.md § 3 step 3.
 */

export function useFlightSearch() {
  return useMutation({
    mutationKey: queryKeys.flightSearch('mutation'),
    mutationFn: (body: FlightSearchRequest) =>
      request<FlightSearchResponse>(endpoints.search.flights, { method: 'POST', body }),
  });
}

export function useHotelSearch() {
  return useMutation({
    mutationKey: queryKeys.hotelSearch('mutation'),
    mutationFn: (body: HotelSearchRequest) =>
      request<HotelSearchResponse>(endpoints.search.hotels, { method: 'POST', body }),
  });
}

export interface ResultPage {
  searchId: string;
  results: SearchResult[];
  page: number;
  size: number;
  total: number;
  cacheHit: boolean;
  providersQueried: number;
  providersResponded: number;
  requestId: string;
}

/**
 * Paginated retrieval from the cached result set. Returns 410 Gone once the
 * cache entry has expired, which the results screen turns into a "search
 * again" interstitial rather than a retry loop.
 */
export function useSearchResultPage(
  searchId: string | undefined,
  page: number,
  sort: SortKey,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.searchPage(searchId ?? '', page, sort),
    queryFn: ({ signal }) =>
      request<ResultPage>(endpoints.search.results(searchId!), {
        query: { page, size: 20, sort },
        signal,
      }),
    enabled: Boolean(searchId) && enabled,
    staleTime: STALE.search,
  });
}

export function useResultDetail(searchId: string | undefined, resultId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.resultDetail(searchId ?? '', resultId ?? ''),
    queryFn: ({ signal }) =>
      request<ResultDetail>(endpoints.search.result(searchId!, resultId!), { signal }),
    enabled: Boolean(searchId && resultId),
    staleTime: STALE.search,
  });
}
