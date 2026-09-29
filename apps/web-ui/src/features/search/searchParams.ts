import { addDays, format } from 'date-fns';
import type {
  Cabin,
  FlightFilters,
  FlightSearchRequest,
  HotelFilters,
  HotelSearchRequest,
  SortKey,
} from '@voyager/shared-schemas';

/**
 * Search criteria live in the URL, which is what makes `/search/flights` and
 * `/results/flights/:searchId` deep-linkable and shareable. Filters are part of
 * the criteria because they are part of the server's normalised search hash --
 * change a filter and you are looking at a different (usually cached) search.
 */

export const MAX_DAYS_AHEAD = 360;

const iso = (date: Date) => format(date, 'yyyy-MM-dd');

export const todayIso = () => iso(new Date());
export const maxDateIso = () => iso(addDays(new Date(), MAX_DAYS_AHEAD));

export function defaultFlightSearch(): FlightSearchRequest {
  return {
    origin: '',
    destination: '',
    departDate: iso(addDays(new Date(), 14)),
    returnDate: undefined,
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin: 'economy',
    sort: 'price_asc',
    filters: {},
  };
}

export function defaultHotelSearch(): HotelSearchRequest {
  return {
    city: '',
    checkIn: iso(addDays(new Date(), 14)),
    checkOut: iso(addDays(new Date(), 17)),
    guests: 2,
    rooms: 1,
    sort: 'price_asc',
    filters: {},
  };
}

const int = (value: string | null) => {
  // Number(null) and Number('') are both 0, which would turn every absent
  // parameter into a real filter value.
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : undefined);

export function flightSearchFromParams(params: URLSearchParams): FlightSearchRequest {
  const base = defaultFlightSearch();
  const filters: FlightFilters = {
    maxStops: int(params.get('maxStops')),
    airlines: list(params.get('airlines')),
    maxPriceCents: int(params.get('maxPriceCents')),
    minPriceCents: int(params.get('minPriceCents')),
    maxDurationMinutes: int(params.get('maxDurationMinutes')),
  };
  const window = list(params.get('departWindow'));

  return {
    origin: (params.get('origin') ?? base.origin).toUpperCase(),
    destination: (params.get('destination') ?? base.destination).toUpperCase(),
    departDate: params.get('departDate') ?? base.departDate,
    returnDate: params.get('returnDate') ?? undefined,
    passengers: {
      adults: int(params.get('adults')) ?? base.passengers.adults,
      children: int(params.get('children')) ?? base.passengers.children,
      infants: int(params.get('infants')) ?? base.passengers.infants,
    },
    cabin: (params.get('cabin') as Cabin | null) ?? base.cabin,
    sort: (params.get('sort') as SortKey | null) ?? base.sort,
    filters: {
      ...filters,
      departWindow:
        window && window.length === 2 ? ([window[0], window[1]] as [string, string]) : undefined,
    },
  };
}

export function flightSearchToParams(request: FlightSearchRequest): URLSearchParams {
  const params = new URLSearchParams({
    origin: request.origin,
    destination: request.destination,
    departDate: request.departDate,
    adults: String(request.passengers.adults),
    children: String(request.passengers.children),
    infants: String(request.passengers.infants),
    cabin: request.cabin,
  });
  if (request.returnDate) params.set('returnDate', request.returnDate);
  if (request.sort) params.set('sort', request.sort);

  const filters = request.filters ?? {};
  if (filters.maxStops !== undefined) params.set('maxStops', String(filters.maxStops));
  if (filters.airlines?.length) params.set('airlines', filters.airlines.join(','));
  if (filters.departWindow) params.set('departWindow', filters.departWindow.join(','));
  if (filters.minPriceCents !== undefined)
    params.set('minPriceCents', String(filters.minPriceCents));
  if (filters.maxPriceCents !== undefined)
    params.set('maxPriceCents', String(filters.maxPriceCents));
  if (filters.maxDurationMinutes !== undefined) {
    params.set('maxDurationMinutes', String(filters.maxDurationMinutes));
  }
  return params;
}

export function hotelSearchFromParams(params: URLSearchParams): HotelSearchRequest {
  const base = defaultHotelSearch();
  const filters: HotelFilters = {
    starRating: list(params.get('starRating'))?.map(Number),
    minReviewScore: int(params.get('minReviewScore')),
    amenities: list(params.get('amenities')),
    minPriceCents: int(params.get('minPriceCents')),
    maxPriceCents: int(params.get('maxPriceCents')),
    neighborhoods: list(params.get('neighborhoods')),
  };

  return {
    city: params.get('city') ?? base.city,
    checkIn: params.get('checkIn') ?? base.checkIn,
    checkOut: params.get('checkOut') ?? base.checkOut,
    guests: int(params.get('guests')) ?? base.guests,
    rooms: int(params.get('rooms')) ?? base.rooms,
    sort: (params.get('sort') as SortKey | null) ?? base.sort,
    filters,
  };
}

export function hotelSearchToParams(request: HotelSearchRequest): URLSearchParams {
  const params = new URLSearchParams({
    city: request.city,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests: String(request.guests),
    rooms: String(request.rooms),
  });
  if (request.sort) params.set('sort', request.sort);

  const filters = request.filters ?? {};
  if (filters.starRating?.length) params.set('starRating', filters.starRating.join(','));
  if (filters.minReviewScore !== undefined) {
    params.set('minReviewScore', String(filters.minReviewScore));
  }
  if (filters.amenities?.length) params.set('amenities', filters.amenities.join(','));
  if (filters.neighborhoods?.length) params.set('neighborhoods', filters.neighborhoods.join(','));
  if (filters.minPriceCents !== undefined)
    params.set('minPriceCents', String(filters.minPriceCents));
  if (filters.maxPriceCents !== undefined)
    params.set('maxPriceCents', String(filters.maxPriceCents));
  return params;
}

export function activeFilterCount(filters: FlightFilters | HotelFilters | undefined): number {
  if (!filters) return 0;
  return Object.values(filters).filter((value) => {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }).length;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000));
}
