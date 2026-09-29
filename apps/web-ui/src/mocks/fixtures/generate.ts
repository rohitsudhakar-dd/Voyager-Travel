import type {
  FlightResult,
  FlightSearchRequest,
  HotelResult,
  HotelSearchRequest,
  ResultDetail,
  SearchResult,
  SortKey,
} from '@voyager/shared-schemas';
import {
  AIRCRAFT,
  AIRLINES,
  AMENITIES,
  DEFAULT_NEIGHBOURHOODS,
  HOTEL_BRANDS,
  HOTEL_SUFFIXES,
  NEIGHBOURHOODS,
  PROVIDERS,
  airportByCode,
} from './reference';
import { rngFrom } from './rng';

const CABIN_MULTIPLIER = {
  economy: 1,
  economy_plus: 1.7,
  business: 3.4,
  first: 5.6,
} as const;

/** Rough great-circle-ish distance, good enough to price and time a leg. */
function legMinutes(origin: string, destination: string): number {
  const from = airportByCode(origin);
  const to = airportByCode(destination);
  if (!from || !to) return 150;
  const sameCountry = from.countryCode === to.countryCode;
  const transatlantic =
    (from.countryCode === 'GB' || from.countryCode === 'IE' || from.countryCode === 'FR') &&
    (to.countryCode === 'US' || to.countryCode === 'CA');
  if (sameCountry) return 75;
  if (transatlantic) return 435;
  if (to.countryCode === 'AU' || to.countryCode === 'JP' || to.countryCode === 'SG') return 760;
  return 165;
}

function iso(date: string, minutesFromMidnight: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + minutesFromMidnight * 60_000).toISOString();
}

export function generateFlights(request: FlightSearchRequest, searchId: string): FlightResult[] {
  const rng = rngFrom(`${searchId}:${request.origin}${request.destination}${request.departDate}`);
  const base = legMinutes(request.origin, request.destination);
  const travellers =
    request.passengers.adults + request.passengers.children + request.passengers.infants;

  const results: FlightResult[] = [];

  for (let index = 0; index < 34; index += 1) {
    const airline = AIRLINES[rng.int(0, AIRLINES.length - 1)];
    const stops = base > 400 ? rng.int(0, 1) : rng.chance(0.55) ? 0 : rng.int(1, 2);
    const departMinutes = rng.int(5 * 60, 22 * 60);
    const legs = stops + 1;
    const layover = stops === 0 ? 0 : rng.int(55, 190) * stops;
    const flightMinutes = Math.round(base * (1 + stops * 0.22) + rng.int(-25, 40));
    const durationMinutes = flightMinutes + layover;

    const segments = Array.from({ length: legs }, (_, leg) => {
      const segmentMinutes = Math.round(flightMinutes / legs);
      const offset = departMinutes + leg * (segmentMinutes + (leg === 0 ? 0 : layover / stops));
      const waypoint = leg === 0 ? request.origin : `${airline.iataCode}X`.slice(0, 3);
      return {
        flightNumber: String(rng.int(100, 998)),
        airlineCode: airline.iataCode,
        origin: leg === 0 ? request.origin : waypoint,
        destination: leg === legs - 1 ? request.destination : waypoint,
        departAt: iso(request.departDate, offset),
        arriveAt: iso(request.departDate, offset + segmentMinutes),
        aircraftType: AIRCRAFT[rng.int(0, AIRCRAFT.length - 1)],
        durationMinutes: segmentMinutes,
      };
    });

    const multiplier = CABIN_MULTIPLIER[request.cabin];
    const baseCents = Math.round(
      (4_200 + base * 38 + rng.int(-1_800, 6_500)) * multiplier * travellers,
    );
    const taxesCents = Math.round(baseCents * 0.19);
    const refundable = request.cabin !== 'economy' ? rng.chance(0.8) : rng.chance(0.25);

    results.push({
      id: `fr_${searchId.slice(-6)}_${index}`,
      productType: 'flight',
      segments,
      airline,
      stops,
      durationMinutes,
      provider: PROVIDERS[rng.int(0, PROVIDERS.length - 1)],
      fare: {
        fareClassCode: refundable ? 'YFLEX' : rng.pick(['QSAVER', 'MLITE', 'KBASIC']),
        cabin: request.cabin,
        refundable,
        changeable: refundable || rng.chance(0.5),
        baggageIncluded: request.cabin === 'economy' ? (rng.chance(0.5) ? 0 : 1) : 2,
        baseCents,
        taxesCents,
        totalCents: baseCents + taxesCents,
        currency: 'GBP',
        seatsRemaining: rng.int(1, 9),
      },
    });
  }

  return applyFlightFilters(results, request);
}

function applyFlightFilters(results: FlightResult[], request: FlightSearchRequest): FlightResult[] {
  const filters = request.filters ?? {};
  return results.filter((result) => {
    if (filters.maxStops !== undefined && result.stops > filters.maxStops) return false;
    if (filters.airlines?.length && !filters.airlines.includes(result.airline.iataCode))
      return false;
    if (filters.minPriceCents !== undefined && result.fare.totalCents < filters.minPriceCents)
      return false;
    if (filters.maxPriceCents !== undefined && result.fare.totalCents > filters.maxPriceCents)
      return false;
    if (
      filters.maxDurationMinutes !== undefined &&
      result.durationMinutes > filters.maxDurationMinutes
    ) {
      return false;
    }
    if (filters.departWindow) {
      const hour = new Date(result.segments[0].departAt).getUTCHours();
      const [from, to] = filters.departWindow.map((value) => Number(value.slice(0, 2)));
      if (hour < from || hour >= to) return false;
    }
    return true;
  });
}

export function generateHotels(request: HotelSearchRequest, searchId: string): HotelResult[] {
  const rng = rngFrom(`${searchId}:${request.city}${request.checkIn}`);
  const nights = Math.max(
    1,
    Math.round((Date.parse(request.checkOut) - Date.parse(request.checkIn)) / 86_400_000),
  );
  const neighbourhoods = NEIGHBOURHOODS[request.city] ?? DEFAULT_NEIGHBOURHOODS;

  const results: HotelResult[] = [];

  for (let index = 0; index < 38; index += 1) {
    const starRating = rng.int(2, 5);
    const nightlyPriceCents = Math.round(
      (6_500 + starRating * 4_200 + rng.int(-1_500, 9_000)) * request.rooms,
    );
    const taxesCents = Math.round(nightlyPriceCents * nights * 0.12);
    const breakfastIncluded = rng.chance(0.45);

    results.push({
      id: `hr_${searchId.slice(-6)}_${index}`,
      productType: 'hotel',
      name: `${rng.pick(HOTEL_BRANDS)} ${rng.pick(HOTEL_SUFFIXES)}`,
      cityName: request.city,
      neighborhood: rng.pick(neighbourhoods),
      starRating,
      reviewScore: Number((6.4 + starRating * 0.55 + rng.next() * 0.9).toFixed(1)),
      reviewCount: rng.int(48, 4_800),
      amenities: rng.some(AMENITIES, rng.int(3, 6)),
      imageSeed: rng.int(0, 15),
      roomName: rng.pick(['Double room', 'Twin room', 'Deluxe double', 'Studio', 'Junior suite']),
      ratePlanName: breakfastIncluded ? 'Bed and breakfast' : 'Room only',
      breakfastIncluded,
      refundable: rng.chance(0.6),
      nights,
      nightlyPriceCents,
      taxesCents,
      totalCents: nightlyPriceCents * nights + taxesCents,
      currency: 'GBP',
      roomsAvailable: rng.int(1, 12),
      provider: PROVIDERS[rng.int(0, PROVIDERS.length - 1)],
    });
  }

  return applyHotelFilters(results, request);
}

function applyHotelFilters(results: HotelResult[], request: HotelSearchRequest): HotelResult[] {
  const filters = request.filters ?? {};
  return results.filter((result) => {
    if (filters.starRating?.length && !filters.starRating.includes(result.starRating)) return false;
    if (filters.minReviewScore !== undefined && result.reviewScore < filters.minReviewScore)
      return false;
    if (filters.minPriceCents !== undefined && result.nightlyPriceCents < filters.minPriceCents)
      return false;
    if (filters.maxPriceCents !== undefined && result.nightlyPriceCents > filters.maxPriceCents)
      return false;
    if (
      filters.neighborhoods?.length &&
      !filters.neighborhoods.includes(result.neighborhood ?? '')
    ) {
      return false;
    }
    if (filters.amenities?.length) {
      const has = filters.amenities.every((amenity) => result.amenities.includes(amenity));
      if (!has) return false;
    }
    return true;
  });
}

export function sortResults(results: SearchResult[], sort: SortKey = 'price_asc'): SearchResult[] {
  const total = (result: SearchResult) =>
    result.productType === 'flight' ? result.fare.totalCents : result.totalCents;

  const sorted = [...results];
  switch (sort) {
    case 'price_asc':
      return sorted.sort((a, b) => total(a) - total(b));
    case 'price_desc':
      return sorted.sort((a, b) => total(b) - total(a));
    case 'duration_asc':
      return sorted.sort(
        (a, b) =>
          (a.productType === 'flight' ? a.durationMinutes : 0) -
          (b.productType === 'flight' ? b.durationMinutes : 0),
      );
    case 'depart_asc':
      return sorted.sort((a, b) =>
        a.productType === 'flight' && b.productType === 'flight'
          ? Date.parse(a.segments[0].departAt) - Date.parse(b.segments[0].departAt)
          : 0,
      );
    case 'rating_desc':
      return sorted.sort(
        (a, b) =>
          (b.productType === 'hotel' ? b.reviewScore : 0) -
          (a.productType === 'hotel' ? a.reviewScore : 0),
      );
    default:
      return sorted;
  }
}

export function detailFor(searchId: string, result: SearchResult): ResultDetail {
  const refundable = result.productType === 'flight' ? result.fare.refundable : result.refundable;
  const total = result.productType === 'flight' ? result.fare.totalCents : result.totalCents;
  const penaltyCents = refundable ? 0 : Math.round(total * 0.35);

  return {
    searchId,
    result,
    fareRules:
      result.productType === 'flight'
        ? [
            { label: 'Fare class', value: result.fare.fareClassCode },
            {
              label: 'Changes',
              value: result.fare.changeable ? 'Allowed, fee may apply' : 'Not allowed',
            },
            { label: 'Refunds', value: refundable ? 'Fully refundable' : 'Non-refundable' },
            { label: 'Seat selection', value: 'From £8 per passenger' },
            { label: 'Name changes', value: 'Not permitted' },
            { label: 'Points earned', value: `${Math.round(total / 100)} Voyager points` },
          ]
        : [
            { label: 'Rate plan', value: result.ratePlanName },
            { label: 'Breakfast', value: result.breakfastIncluded ? 'Included' : 'Not included' },
            {
              label: 'Cancellation',
              value: refundable ? 'Free until 48 h before' : 'Non-refundable',
            },
            { label: 'Check-in', value: 'From 15:00' },
            { label: 'Check-out', value: 'By 11:00' },
            { label: 'Points earned', value: `${Math.round(total / 100)} Voyager points` },
          ],
    baggageAllowance: {
      cabinBags: 1,
      checkedBags: result.productType === 'flight' ? result.fare.baggageIncluded : 0,
      checkedWeightKg: 23,
    },
    cancellationPolicy: {
      refundable,
      penaltyCents,
      freeCancellationUntil: refundable ? new Date(Date.now() + 172_800_000).toISOString() : null,
      summary: refundable
        ? 'Free cancellation up to 48 hours before departure.'
        : 'This fare is non-refundable, but you can still cancel to release the seats.',
    },
    seatMapAvailable: result.productType === 'flight',
    requestId: `req_${searchId.slice(-8)}`,
  };
}
