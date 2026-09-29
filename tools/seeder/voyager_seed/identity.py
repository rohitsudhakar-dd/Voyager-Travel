"""Deterministic identifiers.

Nothing in the seed uses a random UUID or a collision-retry loop. Every id is a
pure function of (namespace, index), which is what makes a re-seed produce
byte-identical rows and lets later passes re-derive an id without holding
400,000 of them in memory.
"""

from __future__ import annotations

import hashlib
import uuid

# Namespaces keep the id spaces of different entities from ever coinciding.
NS_USER = "user"
NS_BOOKING = "booking"
NS_HOLD = "hold"
NS_PAYMENT = "payment"
NS_CONVERSATION = "conversation"

# 6 characters from a 32-symbol alphabet is exactly 2^30 values.
PNR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PNR_SPACE = len(PNR_ALPHABET) ** 6

# Odd multiplier, so (index * MULTIPLIER + OFFSET) mod 2^30 is a bijection over
# the whole PNR space. Distinct bookings can therefore never collide, and no
# retry-on-duplicate loop is needed while bulk loading.
_PNR_MULTIPLIER = 2_654_435_761
_PNR_OFFSET = 987_654_321


def uuid_for(namespace: str, index: int) -> uuid.UUID:
    digest = hashlib.blake2b(
        f"{namespace}:{index}".encode(), digest_size=16
    ).digest()
    return uuid.UUID(bytes=digest, version=4)


def pnr_for(index: int) -> str:
    value = (index * _PNR_MULTIPLIER + _PNR_OFFSET) % PNR_SPACE
    characters = []
    for _ in range(6):
        value, remainder = divmod(value, len(PNR_ALPHABET))
        characters.append(PNR_ALPHABET[remainder])
    return "".join(reversed(characters))
