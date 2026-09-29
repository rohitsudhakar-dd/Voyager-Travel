/**
 * Offer construction, including TRVP's alternate schema.
 *
 * TRVP returns roughly 8% of its responses in a legacy shape: different field
 * names, prices in major units rather than cents, Y/N flags instead of
 * booleans. That gives the normalisation layer in search-service real work to
 * do -- and a realistic place for a bug to live.
 */

import type { FareClassRow, FlightRow } from './db';
import type { Provider } from './providers';

export const TRVP_LEGACY_SCHEMA_RATE = 0.08;

/** Kept in step with the seeder's catalog; a GDS prices off the same rules. */
const CABIN_MULTIPLIER: Record<string, number> = {
  economy: 1.0,
  economy_plus: 1.6,
  business: 3.4,
  first: 6.2,
};

const FARE_CLASS_MULTIPLIER: Record<string, number> = {
  ECOLITE: 0.82, ECOSAVER: 0.92, ECOSTD: 1.0, ECOFLEX: 1.18,
  PLUSSTD: 1.0, PLUSFLEX: 1.22,
  BIZSAVER: 0.9, BIZSTD: 1.0, BIZFLEX: 1.2,
  FIRSTSTD: 1.0, FIRSTFLEX: 1.18, FIRSTRES: 1.45,
};

const TAX_RATE = 0.11;

export interface GdsSegment {
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  aircraft: string | null;
  durationMinutes: number;
}

export interface GdsOffer {
  offerId: string;
  marketingCarrier: { code: string; name: string };
  segments: GdsSegment[];
  fare: {
    basis: string;
    cabin: string;
    baseAmountCents: number;
    taxAmountCents: number;
    totalAmountCents: number;
    currency: string;
    refundable: boolean;
    changeable: boolean;
    baggageAllowance: number;
  };
  seatsRemaining: number;
}

/** TRVP's legacy shape. Deliberately inconsistent with the above. */
export interface TrvpLegacyOffer {
  id: string;
  carrier: string;
  legs: Array<{
    flt: string;
    from: string;
    to: string;
    dep: string;
    arr: string;
    mins: number;
    eqp: string | null;
  }>;
  price: { amt: number; cur: string };
  cabinClass: string;
  fareCode: string;
  refund: 'Y' | 'N';
  chg: 'Y' | 'N';
  bags: number;
  seats: number;
}

export function encodeOfferId(
  provider: Provider,
  flightId: string,
  fareClass: string,
): string {
  return `${provider}-${flightId}-${fareClass}`;
}

export function decodeOfferId(
  offerId: string,
): { provider: string; flightId: string; fareClass: string } | null {
  const parts = offerId.split('-');
  if (parts.length !== 3) return null;
  return { provider: parts[0], flightId: parts[1], fareClass: parts[2] };
}

function priceFor(flight: FlightRow, fareClass: FareClassRow) {
  const base = Math.round(
    flight.base_price_cents *
      (CABIN_MULTIPLIER[fareClass.cabin] ?? 1) *
      (FARE_CLASS_MULTIPLIER[fareClass.code] ?? 1),
  );
  const tax = Math.round(base * TAX_RATE);
  return { base, tax, total: base + tax };
}

export function buildOffers(
  provider: Provider,
  flights: FlightRow[],
  fareClasses: FareClassRow[],
  maxPerFlight: number,
): GdsOffer[] {
  const offers: GdsOffer[] = [];

  for (const flight of flights) {
    for (const fareClass of fareClasses.slice(0, maxPerFlight)) {
      const { base, tax, total } = priceFor(flight, fareClass);
      offers.push({
        offerId: encodeOfferId(provider, flight.id, fareClass.code),
        marketingCarrier: { code: flight.airline_code, name: flight.airline_name },
        segments: [
          {
            flightId: flight.id,
            flightNumber: flight.flight_number,
            origin: flight.origin,
            destination: flight.destination,
            departureTime: flight.depart_at.toISOString(),
            arrivalTime: flight.arrive_at.toISOString(),
            aircraft: flight.aircraft_type,
            durationMinutes: flight.duration_minutes,
          },
        ],
        fare: {
          basis: fareClass.code,
          cabin: fareClass.cabin,
          baseAmountCents: base,
          taxAmountCents: tax,
          totalAmountCents: total,
          currency: flight.currency,
          refundable: fareClass.refundable,
          changeable: fareClass.changeable,
          baggageAllowance: fareClass.baggage_included,
        },
        seatsRemaining: flight.seats_available,
      });
    }
  }

  return offers;
}

/** Re-shape canonical offers into TRVP's legacy format. */
export function toTrvpLegacy(offers: GdsOffer[]): TrvpLegacyOffer[] {
  return offers.map((offer) => ({
    id: offer.offerId,
    carrier: offer.marketingCarrier.code,
    legs: offer.segments.map((segment) => ({
      flt: segment.flightNumber,
      from: segment.origin,
      to: segment.destination,
      dep: segment.departureTime,
      arr: segment.arrivalTime,
      mins: segment.durationMinutes,
      eqp: segment.aircraft,
    })),
    // Major units, not cents. This is the field that breaks naive mappers.
    price: {
      amt: Number((offer.fare.totalAmountCents / 100).toFixed(2)),
      cur: offer.fare.currency,
    },
    cabinClass: offer.fare.cabin,
    fareCode: offer.fare.basis,
    refund: offer.fare.refundable ? 'Y' : 'N',
    chg: offer.fare.changeable ? 'Y' : 'N',
    bags: offer.fare.baggageAllowance,
    seats: offer.seatsRemaining,
  }));
}
