import { useQuery } from '@tanstack/react-query';
import type { Airline, Airport, City } from '@voyager/shared-schemas';
import { request } from '../client';
import { endpoints } from '../endpoints';
import { STALE, queryKeys } from '../queryClient';

/**
 * Autocomplete sources. The 250 ms debounce lives in the Combobox
 * (04-STYLING.md § 4.1); this layer only decides caching.
 */

const MIN_QUERY_LENGTH = 2;

export function useAirportSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.airports(query),
    queryFn: ({ signal }) =>
      request<{ airports: Airport[] }>(endpoints.ref.airports, {
        query: { q: query, limit: 8 },
        signal,
      }).then((response) => response.airports),
    enabled: query.trim().length >= MIN_QUERY_LENGTH,
    staleTime: STALE.reference,
    placeholderData: (previous) => previous,
  });
}

export function useCitySearch(query: string) {
  return useQuery({
    queryKey: queryKeys.cities(query),
    queryFn: ({ signal }) =>
      request<{ cities: City[] }>(endpoints.ref.cities, {
        query: { q: query, limit: 8 },
        signal,
      }).then((response) => response.cities),
    enabled: query.trim().length >= MIN_QUERY_LENGTH,
    staleTime: STALE.reference,
    placeholderData: (previous) => previous,
  });
}

export function useAirlines() {
  return useQuery({
    queryKey: queryKeys.airlines,
    queryFn: ({ signal }) =>
      request<{ airlines: Airline[] }>(endpoints.ref.airlines, { signal }).then(
        (response) => response.airlines,
      ),
    staleTime: 24 * 60 * 60_000,
  });
}
