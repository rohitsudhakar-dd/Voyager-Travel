/**
 * Read-only access to the seeded inventory.
 *
 * mock-gds reads from Postgres so that its results are consistent with the
 * seed data, but it behaves like a remote API in every other respect. It
 * connects as a read-only role and never writes.
 */

import { Pool } from 'pg';

import { config } from './config';

export const pool = new Pool(config.postgres);

export interface FlightRow {
  id: string;
  flight_number: string;
  airline_code: string;
  airline_name: string;
  origin: string;
  destination: string;
  depart_at: Date;
  arrive_at: Date;
  aircraft_type: string | null;
  duration_minutes: number;
  base_price_cents: number;
  currency: string;
  seats_available: number;
}

export async function findFlights(params: {
  origin: string;
  destination: string;
  departDate: string;
  limit: number;
}): Promise<FlightRow[]> {
  const { rows } = await pool.query<FlightRow>(
    `SELECT f.id::text,
            f.flight_number,
            f.airline_code,
            a.name AS airline_name,
            f.origin,
            f.destination,
            f.depart_at,
            f.arrive_at,
            f.aircraft_type,
            f.duration_minutes,
            f.base_price_cents,
            f.currency,
            f.seats_available
       FROM voyager.flights f
       JOIN voyager.airlines a ON a.iata_code = f.airline_code
      WHERE f.origin = $1
        AND f.destination = $2
        AND f.depart_at >= $3::date
        AND f.depart_at < ($3::date + INTERVAL '1 day')
        AND f.seats_available > 0
      ORDER BY f.depart_at
      LIMIT $4`,
    [params.origin, params.destination, params.departDate, params.limit],
  );
  return rows;
}

export async function findFlightById(flightId: string): Promise<FlightRow | null> {
  const { rows } = await pool.query<FlightRow>(
    `SELECT f.id::text, f.flight_number, f.airline_code, a.name AS airline_name,
            f.origin, f.destination, f.depart_at, f.arrive_at, f.aircraft_type,
            f.duration_minutes, f.base_price_cents, f.currency, f.seats_available
       FROM voyager.flights f
       JOIN voyager.airlines a ON a.iata_code = f.airline_code
      WHERE f.id = $1::bigint`,
    [flightId],
  );
  return rows[0] ?? null;
}

export interface FareClassRow {
  code: string;
  cabin: string;
  name: string;
  refundable: boolean;
  changeable: boolean;
  baggage_included: number;
}

export async function findFareClasses(cabin: string): Promise<FareClassRow[]> {
  const { rows } = await pool.query<FareClassRow>(
    `SELECT code, cabin, name, refundable, changeable, baggage_included
       FROM voyager.fare_classes
      WHERE cabin = $1
      ORDER BY code`,
    [cabin],
  );
  return rows;
}

export interface PropertyRow {
  hotel_id: string;
  hotel_name: string;
  star_rating: number;
  review_score: string | null;
  review_count: number;
  neighborhood: string | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  amenities: string[];
  image_seed: number;
  room_type_id: number;
  room_name: string;
  max_occupancy: number;
  bed_config: string | null;
  rate_plan_id: string;
  rate_name: string;
  breakfast_included: boolean;
  refundable: boolean;
  cancellation_hours: number;
  nightly_price_cents: number;
  currency: string;
  rooms_available: number;
}

export async function findProperties(params: {
  city: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  limit: number;
}): Promise<PropertyRow[]> {
  const { rows } = await pool.query<PropertyRow>(
    `SELECT h.id::text   AS hotel_id,
            h.name       AS hotel_name,
            h.star_rating,
            h.review_score,
            h.review_count,
            h.neighborhood,
            h.address,
            h.latitude,
            h.longitude,
            h.amenities,
            h.image_seed,
            rt.id        AS room_type_id,
            rt.name      AS room_name,
            rt.max_occupancy,
            rt.bed_config,
            rp.id::text  AS rate_plan_id,
            rp.name      AS rate_name,
            rp.breakfast_included,
            rp.refundable,
            rp.cancellation_hours,
            rp.nightly_price_cents,
            rp.currency,
            rp.rooms_available
       FROM voyager.hotels h
       JOIN voyager.cities c     ON c.id = h.city_id
       JOIN voyager.room_types rt ON rt.hotel_id = h.id
       JOIN voyager.rate_plans rp ON rp.room_type_id = rt.id
      WHERE lower(c.name) = lower($1)
        AND rt.max_occupancy >= $2
        AND rp.rooms_available > 0
        AND rp.valid_from <= $3::date
        AND rp.valid_to   >= $4::date
      ORDER BY h.review_score DESC NULLS LAST, h.id, rp.nightly_price_cents
      LIMIT $5`,
    [params.city, params.guests, params.checkIn, params.checkOut, params.limit],
  );
  return rows;
}

export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}
