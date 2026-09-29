import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  defaultFlightSearch,
  flightSearchFromParams,
  flightSearchToParams,
  hotelSearchFromParams,
  hotelSearchToParams,
  nightsBetween,
} from './searchParams';

describe('search criteria in the URL', () => {
  it('round-trips a flight search, so a shared link reproduces the query', () => {
    const criteria = {
      ...defaultFlightSearch(),
      origin: 'LHR',
      destination: 'JFK',
      cabin: 'business' as const,
      passengers: { adults: 2, children: 1, infants: 0 },
      filters: { maxStops: 0, airlines: ['VG', 'NW'] },
    };

    const restored = flightSearchFromParams(flightSearchToParams(criteria));

    expect(restored.origin).toBe('LHR');
    expect(restored.destination).toBe('JFK');
    expect(restored.cabin).toBe('business');
    expect(restored.passengers).toEqual({ adults: 2, children: 1, infants: 0 });
    expect(restored.filters?.maxStops).toBe(0);
    expect(restored.filters?.airlines).toEqual(['VG', 'NW']);
  });

  it('treats absent parameters as unset rather than zero', () => {
    const restored = flightSearchFromParams(new URLSearchParams('origin=LHR&destination=JFK'));

    expect(restored.passengers).toEqual({ adults: 1, children: 0, infants: 0 });
    expect(restored.filters?.maxStops).toBeUndefined();
    expect(activeFilterCount(restored.filters)).toBe(0);
  });

  it('round-trips a hotel search', () => {
    const criteria = {
      city: 'Lisbon',
      checkIn: '2026-10-02',
      checkOut: '2026-10-05',
      guests: 3,
      rooms: 2,
      sort: 'rating_desc' as const,
      filters: { starRating: [4, 5] },
    };

    const restored = hotelSearchFromParams(hotelSearchToParams(criteria));

    expect(restored).toMatchObject({
      city: 'Lisbon',
      checkIn: '2026-10-02',
      checkOut: '2026-10-05',
      guests: 3,
      rooms: 2,
      sort: 'rating_desc',
    });
    expect(restored.filters?.starRating).toEqual([4, 5]);
  });

  it('counts only the filters a traveller actually set', () => {
    expect(activeFilterCount(undefined)).toBe(0);
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ maxStops: 1, airlines: [] })).toBe(1);
    expect(activeFilterCount({ maxStops: 1, airlines: ['VG'], minReviewScore: 8 })).toBe(3);
  });

  it('counts nights, not days', () => {
    expect(nightsBetween('2026-10-02', '2026-10-05')).toBe(3);
    expect(nightsBetween('2026-10-02', '2026-10-02')).toBe(1);
  });
});
