"""Idempotency fingerprinting (05-FUNCTIONALITY.md §§ 3.2, 15)."""

from __future__ import annotations

from app.repo.idempotency import fingerprint


def body(**overrides) -> dict:
    base = {
        "bookingId": "9f3c1a2e-0000-4000-8000-000000000001",
        "amountCents": 41200,
        "currency": "GBP",
        "card": {
            "number": "4242424242424242",
            "expiryMonth": 12,
            "expiryYear": 2029,
            "cvc": "123",
            "holderName": "A OKONKWO",
        },
    }
    return {**base, **overrides}


def test_the_same_request_hashes_the_same_way():
    assert fingerprint(body()) == fingerprint(body())


def test_key_order_does_not_change_the_hash():
    reordered = dict(reversed(list(body().items())))
    assert fingerprint(reordered) == fingerprint(body())


def test_a_different_amount_is_a_different_request():
    assert fingerprint(body(amountCents=41201)) != fingerprint(body())


def test_a_different_card_is_a_different_request():
    other = body()
    other["card"] = {**other["card"], "number": "4000000000000002"}
    assert fingerprint(other) != fingerprint(body())


def test_the_cvc_is_not_part_of_the_fingerprint():
    """The CVC is never retained, so it cannot be hashed either.

    A caller retrying the identical charge should get their original response
    back, not a 409, and they may well not have kept the CVC around.
    """
    other = body()
    other["card"] = {**other["card"], "cvc": "999"}
    assert fingerprint(other) == fingerprint(body())


def test_the_card_number_never_reaches_the_hash_input():
    """Two cards sharing their last four digits and expiry hash alike.

    That is the proof the full number is discarded before hashing: if it were
    included, these would differ.
    """
    first = body()
    first["card"] = {**first["card"], "number": "4242111122224242"}
    second = body()
    second["card"] = {**second["card"], "number": "4000999988884242"}
    assert fingerprint(first) == fingerprint(second)
