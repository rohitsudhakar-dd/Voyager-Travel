"""Reference data: cities, airports, airlines, fare classes and fare rules.

Airports come from the `airportsdata` package, so IATA codes, city names,
countries, coordinates and timezones are real (01-PRD.md § 9). Selection is
deterministic: the trunk airports the demo flies come first, then the rest in
IATA order, so two runs pick the same 500.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Iterator

import airportsdata
from psycopg.types.json import Jsonb

from . import catalog
from .config import SeedConfig

# Coarse regions, used for the region-to-region fare rule patterns that
# pricing-service evaluates. Anything unmapped falls back to "INTL".
COUNTRY_REGION = {
    "GB": "UK", "IE": "EU", "FR": "EU", "DE": "EU", "ES": "EU", "IT": "EU",
    "NL": "EU", "BE": "EU", "LU": "EU", "PT": "EU", "AT": "EU", "CH": "EU",
    "SE": "EU", "NO": "EU", "DK": "EU", "FI": "EU", "IS": "EU", "PL": "EU",
    "CZ": "EU", "SK": "EU", "HU": "EU", "RO": "EU", "BG": "EU", "GR": "EU",
    "HR": "EU", "SI": "EU", "EE": "EU", "LV": "EU", "LT": "EU", "MT": "EU",
    "CY": "EU", "RS": "EU", "UA": "EU",
    "US": "NA", "CA": "NA", "MX": "NA",
    "BR": "LATAM", "AR": "LATAM", "CL": "LATAM", "CO": "LATAM", "PE": "LATAM",
    "UY": "LATAM", "EC": "LATAM", "PA": "LATAM", "CR": "LATAM", "DO": "LATAM",
    "CU": "LATAM", "JM": "LATAM",
    "AE": "MEA", "QA": "MEA", "SA": "MEA", "KW": "MEA", "BH": "MEA",
    "OM": "MEA", "IL": "MEA", "JO": "MEA", "LB": "MEA", "TR": "MEA",
    "EG": "MEA", "MA": "AFR", "TN": "AFR", "DZ": "AFR", "ZA": "AFR",
    "KE": "AFR", "NG": "AFR", "GH": "AFR", "ET": "AFR", "TZ": "AFR",
    "SN": "AFR", "MU": "AFR", "RW": "AFR",
    "IN": "APAC", "SG": "APAC", "MY": "APAC", "TH": "APAC", "VN": "APAC",
    "ID": "APAC", "PH": "APAC", "CN": "APAC", "HK": "APAC", "TW": "APAC",
    "JP": "APAC", "KR": "APAC", "LK": "APAC", "NP": "APAC", "BD": "APAC",
    "KH": "APAC", "MV": "APAC",
    "AU": "OCE", "NZ": "OCE", "FJ": "OCE",
}

# Airports outside these countries are excluded from the fill, which keeps the
# 500 concentrated in places the demo actually generates routes and hotels for.
SERVED_COUNTRIES = tuple(COUNTRY_REGION.keys())


def region_for(country_code: str) -> str:
    return COUNTRY_REGION.get(country_code, "INTL")


def select_airports(config: SeedConfig) -> list[dict]:
    """Pick the airports to seed: trunk routes first, then IATA order."""
    everything = airportsdata.load("IATA")

    def usable(record: dict) -> bool:
        return bool(
            record.get("iata")
            and record.get("city")
            and record.get("country") in SERVED_COUNTRIES
            and record.get("lat") is not None
            and record.get("lon") is not None
        )

    selected: list[dict] = []
    seen: set[str] = set()

    for code in catalog.TRUNK_AIRPORTS:
        record = everything.get(code)
        if record and usable(record):
            selected.append(record)
            seen.add(code)

    remaining = sorted(
        (r for code, r in everything.items() if code not in seen and usable(r)),
        key=lambda r: r["iata"],
    )
    target = config.volumes.airports
    selected.extend(remaining[: max(0, target - len(selected))])
    return selected


def build_cities(config: SeedConfig, airports: list[dict]) -> list[dict]:
    """Derive the city table from the selected airports.

    Trunk cities come first so their popularity_rank is low, which is what the
    home page's "popular destinations" panel sorts on.
    """
    order: list[tuple[str, str]] = []
    primary: dict[tuple[str, str], dict] = {}

    for record in airports:
        key = (record["city"], record["country"])
        if key not in primary:
            primary[key] = record
            order.append(key)

    cities = []
    for rank, key in enumerate(order[: config.volumes.cities], start=1):
        record = primary[key]
        cities.append(
            {
                "id": rank,
                "name": record["city"],
                "country_code": record["country"],
                "region": region_for(record["country"]),
                "latitude": round(float(record["lat"]), 6),
                "longitude": round(float(record["lon"]), 6),
                "popularity_rank": rank,
            }
        )
    return cities


def city_rows(cities: list[dict]) -> Iterator[tuple]:
    for city in cities:
        yield (
            city["id"],
            city["name"],
            city["country_code"],
            city["region"],
            city["latitude"],
            city["longitude"],
            city["popularity_rank"],
        )


CITY_COLUMNS = (
    "id", "name", "country_code", "region", "latitude", "longitude",
    "popularity_rank",
)


def airport_rows(airports: list[dict], cities: list[dict]) -> Iterator[tuple]:
    city_ids = {(c["name"], c["country_code"]): c["id"] for c in cities}
    for record in airports:
        yield (
            record["iata"],
            record["icao"] or None,
            record["name"],
            city_ids.get((record["city"], record["country"])),
            record["country"],
            round(float(record["lat"]), 6),
            round(float(record["lon"]), 6),
            record["tz"] or None,
        )


AIRPORT_COLUMNS = (
    "iata_code", "icao_code", "name", "city_id", "country_code",
    "latitude", "longitude", "timezone",
)


def airline_rows(rng: random.Random) -> Iterator[tuple]:
    for code, name, alliance in catalog.AIRLINES:
        yield (code, name, alliance, rng.randrange(1, 1_000_000))


AIRLINE_COLUMNS = ("iata_code", "name", "alliance", "logo_seed")


def fare_class_rows() -> Iterator[tuple]:
    yield from catalog.FARE_CLASSES


FARE_CLASS_COLUMNS = (
    "code", "cabin", "name", "refundable", "changeable",
    "baggage_included", "points_multiplier",
)


def fare_rule_rows(
    config: SeedConfig, rng: random.Random, airport_codes: list[str]
) -> Iterator[tuple]:
    """Generate the ~2,000 fare rules pricing-service loops over.

    Route patterns are deliberately a mix of exact pairs, one-sided wildcards
    and region-to-region, because that variety is what makes the hot path's
    per-offer regex compilation expensive rather than trivially cacheable.
    """
    fare_class_codes = [code for code, *_ in catalog.FARE_CLASSES]
    regions = sorted(set(COUNTRY_REGION.values()))
    anchor = config.anchor_date

    for index in range(config.volumes.fare_rules):
        template = catalog.ROUTE_PATTERN_TEMPLATES[
            index % len(catalog.ROUTE_PATTERN_TEMPLATES)
        ]
        pattern = template.format(
            origin=rng.choice(airport_codes),
            destination=rng.choice(airport_codes),
            origin_region=rng.choice(regions),
            destination_region=rng.choice(regions),
        )

        applies_from = anchor - timedelta(days=rng.randrange(0, 180))
        applies_to = applies_from + timedelta(days=rng.randrange(120, 720))

        adjustment_type = "percent" if rng.random() < 0.72 else "fixed"
        if adjustment_type == "percent":
            adjustment_value = round(rng.uniform(-18.0, 34.0), 2)
        else:
            adjustment_value = round(rng.uniform(-4000, 12000) / 100.0, 2)

        conditions = {
            key: rng.random() < 0.3
            for key in rng.sample(
                catalog.FARE_RULE_CONDITION_KEYS,
                k=rng.randrange(0, len(catalog.FARE_RULE_CONDITION_KEYS) + 1),
            )
        }

        yield (
            index + 1,
            rng.choice(fare_class_codes),
            pattern,
            applies_from,
            applies_to,
            rng.randrange(1, 128),
            rng.choice((0, 0, 3, 7, 14, 21, 30)),
            rng.choice((None, 1, 2, 3, 7)),
            rng.choice((None, 30, 60, 90, 365)),
            adjustment_type,
            adjustment_value,
            rng.randrange(0, 100),
            Jsonb(conditions),
        )


FARE_RULE_COLUMNS = (
    "id", "fare_class_code", "route_pattern", "applies_from", "applies_to",
    "day_of_week_mask", "advance_purchase_days", "min_stay_days",
    "max_stay_days", "adjustment_type", "adjustment_value", "priority",
    "conditions",
)
