"""PNR generation (05-FUNCTIONALITY.md § 4.1).

Six characters from an alphabet with no ambiguous glyphs, because a PNR is
something a human reads off a screen and types into a phone.
"""

from __future__ import annotations

import secrets

# No I, O, 0, or 1. Those are the pairs people misread and mistype.
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
LENGTH = 6


def generate() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))
