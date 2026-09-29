"""Bookable inventory: flight schedules, hotels, room types and rate plans.

The flight schedule covers the whole 365-day search window. Route depth is
tiered so that the trunk routes a demo actually searches return a full page of
results, while the long tail still exists to make the data look real.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterator

from . import catalog
from .config import SeedConfig

CRUISE_KMH = 820.0
TURNAROUND_MINUTES = 35

NARROWBODY_SEATS = 180
WIDEBODY_SEATS = 296
LONG_HAUL_MINUTES = 380


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(a))


@dataclass
class Route:
    origin: str
    destination: str
    distance_km: float
    duration_minutes: int
    flights_per_day: float
    airlines: tuple[str, ...]
    base_price_cents: int


def build_routes(config: SeedConfig, rng: random.Random, airports: list[dict]) -> list[Route]:
    """Three tiers of route density, sized to land near 150,000 flights."""
    by_code = {a["iata"]: a for a in airports}
    trunk = [code for code in catalog.TRUNK_AIRPORTS if code in by_code]
    others = [a["iata"] for a in airports if a["iata"] not in set(trunk)]

    trunk_pairs = [
        (trunk[i], trunk[j])
        for i in range(len(trunk))
        for j in range(i + 1, len(trunk))
    ]
    rng.shuffle(trunk_pairs)

    airline_codes = [code for code, *_ in catalog.AIRLINES]
    routes: list[Route] = []

    def add_pair(origin: str, destination: str, per_day: float) -> None:
        a, b = by_code[origin], by_code[destination]
        distance = haversine_km(
            float(a["lat"]), float(a["lon"]), float(b["lat"]), float(b["lon"])
        )
        if distance < 150:
            return
        duration = int(distance / CRUISE_KMH * 60) + TURNAROUND_MINUTES
        # Long-haul fares do not scale linearly with distance; the square-root
        # term keeps a 6,000 km hop from costing ten times a 600 km one.
        price = int(4200 + 62 * math.sqrt(distance) + 1.9 * distance)
        carriers = tuple(rng.sample(airline_codes, k=rng.randrange(2, 5)))
        for o, d in ((origin, destination), (destination, origin)):
            routes.append(
                Route(
                    origin=o,
                    destination=d,
                    distance_km=distance,
                    duration_minutes=duration,
                    flights_per_day=per_day,
                    airlines=carriers,
                    base_price_cents=price,
                )
            )

    for origin, destination in trunk_pairs[:20]:
        add_pair(origin, destination, 6.0)
    for origin, destination in trunk_pairs[20:60]:
        add_pair(origin, destination, 2.0)

    if others:
        for _ in range(50):
            add_pair(rng.choice(trunk), rng.choice(others), 0.2)

    return routes


@dataclass
class FlightGenerator:
    """Streams flight rows and remembers a sample of future departures.

    Historical bookings carry their itinerary in item_metadata rather than a
    flight_id, but "upcoming trips" on the home page need to point at real
    rows, so a slice of the forward schedule is kept.
    """

    config: SeedConfig
    rng: random.Random
    routes: list[Route]
    upcoming_flight_ids: list[int] = field(default_factory=list)
    total: int = 0

    def rows(self) -> Iterator[tuple]:
        anchor = self.config.anchor_datetime
        days = self.config.volumes.schedule_days_forward
        flight_id = 0

        for day_offset in range(days):
            day = anchor + timedelta(days=day_offset)
            weekday = day.weekday()
            # Fridays and Sundays are dearer; February is cheap.
            demand = 1.0 + (0.16 if weekday in (4, 6) else 0.0)
            demand += 0.12 * math.sin(day_offset / 58.0)

            for route_index, route in enumerate(self.routes):
                count = self._departures_today(route, route_index, day_offset)
                for slot in range(count):
                    flight_id += 1
                    airline = route.airlines[flight_id % len(route.airlines)]
                    depart = day + timedelta(
                        minutes=self._departure_minute(count, slot)
                    )
                    arrive = depart + timedelta(minutes=route.duration_minutes)
                    widebody = route.duration_minutes >= LONG_HAUL_MINUTES
                    seats_total = WIDEBODY_SEATS if widebody else NARROWBODY_SEATS
                    aircraft = self.rng.choice(
                        catalog.WIDEBODY_AIRCRAFT
                        if widebody
                        else catalog.NARROWBODY_AIRCRAFT
                    )
                    price = int(
                        route.base_price_cents
                        * demand
                        * self.rng.uniform(0.86, 1.22)
                    )

                    if 1 <= day_offset <= 90 and flight_id % 37 == 0:
                        self.upcoming_flight_ids.append(flight_id)

                    yield (
                        flight_id,
                        f"{airline}{1000 + (flight_id % 8999)}",
                        airline,
                        route.origin,
                        route.destination,
                        depart,
                        arrive,
                        aircraft,
                        route.duration_minutes,
                        price,
                        "GBP",
                        seats_total,
                        self.rng.randrange(int(seats_total * 0.05), seats_total),
                    )

        self.total = flight_id

    def _departures_today(self, route: Route, route_index: int, day_offset: int) -> int:
        if route.flights_per_day >= 1:
            return int(route.flights_per_day)
        # Sub-daily routes fly on a fixed cycle rather than randomly, so the
        # schedule is stable across runs.
        period = int(round(1 / route.flights_per_day))
        return 1 if (day_offset + route_index) % period == 0 else 0

    def _departure_minute(self, count: int, slot: int) -> int:
        """Spread departures across the operating day, 06:00 to 22:00."""
        if count == 1:
            return 8 * 60 + self.rng.randrange(0, 240)
        window = (22 - 6) * 60
        base = 6 * 60 + int(window * slot / count)
        return base + self.rng.randrange(0, 45)


FLIGHT_COLUMNS = (
    "id", "flight_number", "airline_code", "origin", "destination",
    "depart_at", "arrive_at", "aircraft_type", "duration_minutes",
    "base_price_cents", "currency", "seats_total", "seats_available",
)


# ------------------------------------------------------------------ hotels --


@dataclass
class HotelGenerator:
    config: SeedConfig
    rng: random.Random
    cities: list[dict]
    # Captured while streaming the hotel rows, then reused when pricing the
    # rate plans -- the hotels themselves are never held in memory.
    hotel_city_rank: list[int] = field(default_factory=list)
    hotel_stars: list[int] = field(default_factory=list)
    total_rate_plans: int = 0

    def hotel_rows(self) -> Iterator[tuple]:
        # Popular cities get proportionally more properties, the same way real
        # supply concentrates.
        weights = [1.0 / (0.35 * city["popularity_rank"] + 6) for city in self.cities]

        for hotel_id in range(1, self.config.volumes.hotels + 1):
            city = self.rng.choices(self.cities, weights=weights, k=1)[0]
            self.hotel_city_rank.append(city["popularity_rank"])

            brand = self.rng.choice(catalog.HOTEL_BRANDS)
            suffix = self.rng.choice(catalog.HOTEL_SUFFIXES)
            neighborhood = self.rng.choice(catalog.NEIGHBORHOOD_PREFIXES)
            stars = self.rng.choices((1, 2, 3, 4, 5), weights=(3, 12, 34, 36, 15))[0]
            self.hotel_stars.append(stars)
            # Better hotels review better, with real spread.
            score = min(9.8, max(5.2, self.rng.gauss(5.6 + stars * 0.62, 0.62)))

            yield (
                hotel_id,
                f"{brand} {neighborhood} {suffix}",
                city["id"],
                f"{self.rng.randrange(1, 240)} {neighborhood} Road",
                stars,
                round(score, 1),
                self.rng.randrange(18, 4200),
                round(float(city["latitude"]) + self.rng.uniform(-0.08, 0.08), 6),
                round(float(city["longitude"]) + self.rng.uniform(-0.08, 0.08), 6),
                sorted(
                    self.rng.sample(
                        catalog.HOTEL_AMENITIES,
                        k=self.rng.randrange(3, min(11, len(catalog.HOTEL_AMENITIES))),
                    )
                ),
                self.rng.randrange(1, 1_000_000),
                neighborhood,
            )

    def room_type_rows(self) -> Iterator[tuple]:
        room_type_id = 0
        per_hotel = self.config.volumes.room_types_per_hotel
        for hotel_id in range(1, self.config.volumes.hotels + 1):
            for name, occupancy, beds, size in self.rng.sample(
                catalog.ROOM_TYPES, k=per_hotel
            ):
                room_type_id += 1
                yield (room_type_id, hotel_id, name, occupancy, beds, size)

    def rate_plan_rows(self) -> Iterator[tuple]:
        rate_plan_id = 0
        room_type_id = 0
        per_hotel = self.config.volumes.room_types_per_hotel
        per_room = self.config.volumes.rate_plans_per_room_type
        valid_from = self.config.anchor_date - timedelta(days=30)
        valid_to = self.config.anchor_date + timedelta(days=400)

        for hotel_id in range(1, self.config.volumes.hotels + 1):
            stars = self.hotel_stars[hotel_id - 1]
            city_rank = self.hotel_city_rank[hotel_id - 1]
            # Cheaper in the long tail of cities, dearer in the popular ones.
            city_factor = 1.45 - 0.5 * min(1.0, city_rank / 260)
            nightly_base = int((5200 + stars * 5400) * city_factor)

            for _ in range(per_hotel):
                room_type_id += 1
                templates = self.rng.sample(catalog.RATE_PLAN_TEMPLATES, k=per_room)
                for name, breakfast, refundable, hours, multiplier in templates:
                    rate_plan_id += 1
                    yield (
                        rate_plan_id,
                        room_type_id,
                        name,
                        breakfast,
                        refundable,
                        hours,
                        int(nightly_base * multiplier * self.rng.uniform(0.9, 1.15)),
                        "GBP",
                        self.rng.randrange(0, 24),
                        valid_from,
                        valid_to,
                    )
        self.total_rate_plans = rate_plan_id


HOTEL_COLUMNS = (
    "id", "name", "city_id", "address", "star_rating", "review_score",
    "review_count", "latitude", "longitude", "amenities", "image_seed",
    "neighborhood",
)

ROOM_TYPE_COLUMNS = (
    "id", "hotel_id", "name", "max_occupancy", "bed_config", "size_sqm",
)

RATE_PLAN_COLUMNS = (
    "id", "room_type_id", "name", "breakfast_included", "refundable",
    "cancellation_hours", "nightly_price_cents", "currency",
    "rooms_available", "valid_from", "valid_to",
)
