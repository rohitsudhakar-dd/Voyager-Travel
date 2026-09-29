"""Seeder configuration and target volumes.

Volumes come from 01-PRD.md § 9. They are expressed as constants rather than
knobs because the demos depend on them: scenario S3 is only convincing because
`bookings` really does hold 400k rows.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, datetime, timezone


@dataclass(frozen=True)
class Volumes:
    airports: int = 500
    cities: int = 300
    airlines: int = 40
    hotels: int = 5_000
    room_types_per_hotel: int = 3
    rate_plans_per_room_type: int = 3
    fare_rules: int = 2_000
    users: int = 10_000
    bookings: int = 400_000

    # The S3 demo needs a signed-in user whose /account page is genuinely
    # expensive to load. Without deliberate skew the average user has ~40
    # bookings and the demo has no subject.
    power_users: int = 20
    power_user_bookings_min: int = 300
    power_user_bookings_max: int = 800

    support_conversations: int = 2_000

    # Flight schedules must cover the full search window allowed by
    # 05-FUNCTIONALITY.md § 15 (today + 360 days), or long-dated searches
    # return nothing.
    schedule_days_forward: int = 365


@dataclass(frozen=True)
class SeedConfig:
    dsn: str
    random_seed: int
    anchor_date: date
    volumes: Volumes

    @property
    def anchor_datetime(self) -> datetime:
        return datetime.combine(
            self.anchor_date, datetime.min.time(), tzinfo=timezone.utc
        )


# All seeded accounts share this password. It is documented in 01-PRD.md § 9
# for the power users, and there is no real personal data anywhere in the seed.
DEMO_PASSWORD = "demo1234"
POWER_USER_EMAIL_TEMPLATE = "power{n}@voyager.demo"


def load_config() -> SeedConfig:
    user = os.environ.get("POSTGRES_USER", "voyager")
    password = os.environ.get("POSTGRES_PASSWORD", "")
    host = os.environ.get("POSTGRES_HOST", "postgres")
    port = os.environ.get("POSTGRES_PORT", "5432")
    database = os.environ.get("POSTGRES_DB", "voyager")

    # The anchor is today by default so the 365-day search window always has
    # inventory. Pin SEED_ANCHOR_DATE to make a run reproducible across days.
    anchor_raw = os.environ.get("SEED_ANCHOR_DATE", "").strip()
    anchor = (
        date.fromisoformat(anchor_raw)
        if anchor_raw
        else datetime.now(timezone.utc).date()
    )

    return SeedConfig(
        dsn=f"postgresql://{user}:{password}@{host}:{port}/{database}",
        random_seed=int(os.environ.get("SEED_RANDOM_SEED", "20260101")),
        anchor_date=anchor,
        volumes=Volumes(),
    )
