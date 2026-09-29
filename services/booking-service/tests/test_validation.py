"""Passenger and total validation (05-FUNCTIONALITY.md § 15)."""

from __future__ import annotations

from datetime import date

import pytest

from app.domain import pnr
from app.domain.validation import (
    age_at,
    assert_total_matches_items,
    validate_passengers,
)
from app.errors import BookingTotalMismatchError, ValidationError

TRAVEL = date(2026, 6, 1)


def passenger(**overrides) -> dict:
    base = {
        "passengerType": "adult",
        "firstName": "Ada",
        "lastName": "Okonkwo",
        "dateOfBirth": "1990-04-12",
        "nationality": "GB",
    }
    return {**base, **overrides}


def test_a_straightforward_family_passes():
    validate_passengers(
        [
            passenger(),
            passenger(passengerType="child", dateOfBirth="2018-03-02"),
            passenger(passengerType="infant", dateOfBirth="2025-09-30"),
        ],
        travel_date=TRAVEL,
    )


def test_age_is_measured_at_the_travel_date_not_today():
    """A child who turns 12 after the flight is still a child on it."""
    eleven_on_travel_day = "2014-06-02"
    validate_passengers(
        [passenger(), passenger(passengerType="child", dateOfBirth=eleven_on_travel_day)],
        travel_date=TRAVEL,
    )

    twelve_on_travel_day = "2014-06-01"
    with pytest.raises(ValidationError) as caught:
        validate_passengers(
            [
                passenger(),
                passenger(passengerType="child", dateOfBirth=twelve_on_travel_day),
            ],
            travel_date=TRAVEL,
        )
    assert caught.value.details["ageAtTravel"] == 12


def test_age_at_handles_a_birthday_that_has_not_happened_yet():
    assert age_at(date(2000, 12, 31), date(2026, 1, 1)) == 25
    assert age_at(date(2000, 1, 1), date(2026, 1, 1)) == 26


def test_an_infant_needs_an_adult():
    with pytest.raises(ValidationError) as caught:
        validate_passengers(
            [
                passenger(),
                passenger(passengerType="infant", dateOfBirth="2025-09-30"),
                passenger(passengerType="infant", dateOfBirth="2025-10-30"),
            ],
            travel_date=TRAVEL,
        )
    assert caught.value.details == {"adults": 1, "infants": 2}


def test_a_booking_needs_an_adult():
    with pytest.raises(ValidationError):
        validate_passengers(
            [passenger(passengerType="child", dateOfBirth="2018-03-02")],
            travel_date=TRAVEL,
        )


def test_nine_passengers_is_the_ceiling():
    nine = [passenger() for _ in range(9)]
    validate_passengers(nine, travel_date=TRAVEL)
    with pytest.raises(ValidationError):
        validate_passengers(nine + [passenger()], travel_date=TRAVEL)


def test_passenger_counts_must_match_the_search():
    with pytest.raises(ValidationError) as caught:
        validate_passengers(
            [passenger(), passenger()],
            travel_date=TRAVEL,
            expected_counts={"adult": 1, "child": 0, "infant": 0},
        )
    assert caught.value.details["adult"] == {"searched": 1, "submitted": 2}


@pytest.mark.parametrize("field", ["firstName", "lastName", "dateOfBirth", "nationality"])
def test_every_passenger_field_is_required(field):
    with pytest.raises(ValidationError):
        validate_passengers([passenger(**{field: ""})], travel_date=TRAVEL)


def test_a_malformed_date_of_birth_is_rejected():
    with pytest.raises(ValidationError):
        validate_passengers([passenger(dateOfBirth="12/04/1990")], travel_date=TRAVEL)


def test_totals_must_agree_with_line_items():
    items = [
        {"total_price_cents": 41200},
        {"total_price_cents": 3500},
    ]
    assert_total_matches_items(44700, items, booking_id="b1")

    with pytest.raises(BookingTotalMismatchError) as caught:
        assert_total_matches_items(44699, items, booking_id="b1")
    # A 500, not a 400: nobody sent a bad request, our arithmetic is wrong.
    assert caught.value.status_code == 500
    assert caught.value.details["items_cents"] == 44700


def test_pnr_avoids_ambiguous_glyphs():
    for _ in range(200):
        code = pnr.generate()
        assert len(code) == 6
        assert not set(code) & set("IO01")
