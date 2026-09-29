"""Users and loyalty accounts.

The 20 power users come first and are the reason scenario S3 has a subject:
each carries 300-800 bookings, so their /account page is genuinely expensive
to load once idx_bookings_user_id_created_at is dropped.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import timedelta
from typing import Iterator

import bcrypt

from . import catalog
from .config import DEMO_PASSWORD, POWER_USER_EMAIL_TEMPLATE, SeedConfig
from .identity import NS_USER, uuid_for

# bcrypt's radix-64 alphabet. Salts are drawn from the seeded RNG rather than
# os.urandom so that a re-seed produces identical password_hash values.
_BCRYPT_ALPHABET = (
    "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
)
BCRYPT_COST = 12
DISTINCT_HASHES = 16


def _bcrypt_salt(rng: random.Random) -> bytes:
    """Encode 16 deterministic bytes as a bcrypt salt.

    A bcrypt salt is 128 bits written as 22 radix-64 characters, which is 132
    bits of space. The final character therefore carries only two significant
    bits, and picking all 22 characters at random produces a salt bcrypt
    rejects. Encoding the bytes properly is the only way to get this right.
    """
    value = int.from_bytes(rng.randbytes(16), "big") << 4
    body = "".join(
        _BCRYPT_ALPHABET[(value >> shift) & 0x3F] for shift in range(126, -1, -6)
    )
    return f"$2b${BCRYPT_COST}${body}".encode()


@dataclass(frozen=True)
class User:
    index: int
    id: str
    email: str
    first_name: str
    last_name: str
    tier: str
    is_power_user: bool


def _password_hashes(rng: random.Random) -> list[str]:
    """Pre-compute a handful of hashes of the shared demo password.

    Hashing 10,000 accounts individually at cost 12 would take roughly an
    hour. Every seeded account uses the same password anyway, so a small pool
    of distinct hashes keeps the column from looking uniform while staying
    inside the seeding budget.
    """
    return [
        bcrypt.hashpw(DEMO_PASSWORD.encode(), _bcrypt_salt(rng)).decode()
        for _ in range(DISTINCT_HASHES)
    ]


def build_users(config: SeedConfig, rng: random.Random) -> list[User]:
    volumes = config.volumes
    users: list[User] = []

    # Power users are heavy travellers, so they sit at the top tiers.
    power_tiers = ["platinum"] * 10 + ["gold"] * 7 + ["silver"] * 3
    for n in range(volumes.power_users):
        index = n
        users.append(
            User(
                index=index,
                id=str(uuid_for(NS_USER, index)),
                email=POWER_USER_EMAIL_TEMPLATE.format(n=n + 1),
                first_name=catalog.FIRST_NAMES[n % len(catalog.FIRST_NAMES)],
                last_name=catalog.LAST_NAMES[n % len(catalog.LAST_NAMES)],
                tier=power_tiers[n],
                is_power_user=True,
            )
        )

    for n in range(volumes.users):
        index = volumes.power_users + n
        first = rng.choice(catalog.FIRST_NAMES)
        last = rng.choice(catalog.LAST_NAMES)
        users.append(
            User(
                index=index,
                id=str(uuid_for(NS_USER, index)),
                email=f"{first}.{last}{n}@voyager.demo".lower(),
                first_name=first,
                last_name=last,
                tier=rng.choices(catalog.TIERS, weights=catalog.TIER_WEIGHTS)[0],
                is_power_user=False,
            )
        )

    return users


def user_rows(
    config: SeedConfig, rng: random.Random, users: list[User]
) -> Iterator[tuple]:
    hashes = _password_hashes(rng)
    anchor = config.anchor_datetime

    for user in users:
        created = anchor - timedelta(
            days=rng.randrange(30, 1400), minutes=rng.randrange(0, 1440)
        )
        yield (
            user.id,
            user.email,
            hashes[user.index % len(hashes)],
            user.first_name,
            user.last_name,
            f"+44 7{rng.randrange(100000000, 999999999)}",
            user.tier,
            rng.choice(catalog.SIGNUP_COHORTS),
            rng.choice(catalog.LOCALES),
            created,
            created,
        )


USER_COLUMNS = (
    "id", "email", "password_hash", "first_name", "last_name", "phone",
    "tier", "signup_cohort", "locale", "created_at", "updated_at",
)


TIER_LIFETIME_FLOOR = {
    "standard": 0,
    "silver": 25_000,
    "gold": 75_000,
    "platinum": 200_000,
}


def loyalty_account_rows(
    config: SeedConfig, rng: random.Random, users: list[User]
) -> Iterator[tuple]:
    anchor = config.anchor_datetime
    for user in users:
        floor = TIER_LIFETIME_FLOOR[user.tier]
        lifetime = floor + rng.randrange(0, max(1, floor // 2 + 20_000))
        # Members spend some of what they earn.
        balance = int(lifetime * rng.uniform(0.15, 0.85))
        qualified = (
            None
            if user.tier == "standard"
            else anchor - timedelta(days=rng.randrange(1, 900))
        )
        updated = anchor - timedelta(minutes=rng.randrange(0, 60 * 24 * 30))
        yield (user.id, balance, lifetime, user.tier, qualified, updated, updated)


LOYALTY_ACCOUNT_COLUMNS = (
    "user_id", "points_balance", "lifetime_points", "tier",
    "tier_qualified_at", "created_at", "updated_at",
)
