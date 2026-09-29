"""Passenger and total validation (05-FUNCTIONALITY.md § 15).

Server-side and authoritative. The UI mirrors these rules so the traveller
gets told early, but nothing here trusts that it did.
"""

from __future__ import annotations

from datetime import date

from app.errors import BookingTotalMismatchError, ValidationError

# § 15: children are 2-11 and infants under 2, measured at the travel date
# rather than today -- a child who turns 12 mid-trip is booked as a child.
AGE_BOUNDS: dict[str, tuple[int, int]] = {
    "adult": (12, 130),
    "child": (2, 11),
    "infant": (0, 1),
}

MAX_PASSENGERS = 9


def age_at(born: date, on: date) -> int:
    years = on.year - born.year
    if (on.month, on.day) < (born.month, born.day):
        years -= 1
    return years


def validate_passengers(
    passengers: list[dict],
    *,
    travel_date: date,
    expected_counts: dict[str, int] | None = None,
) -> None:
    if not passengers:
        raise ValidationError("A booking needs at least one passenger.")
    if len(passengers) > MAX_PASSENGERS:
        raise ValidationError(
            f"A single booking can carry at most {MAX_PASSENGERS} passengers.",
            details={"submitted": len(passengers)},
        )

    counts = {"adult": 0, "child": 0, "infant": 0}

    for index, passenger in enumerate(passengers):
        where = {"index": index}

        passenger_type = passenger.get("passengerType")
        if passenger_type not in AGE_BOUNDS:
            raise ValidationError(
                "passengerType must be adult, child, or infant.", details=where
            )
        counts[passenger_type] += 1

        for field in ("firstName", "lastName", "dateOfBirth", "nationality"):
            if not passenger.get(field):
                raise ValidationError(
                    f"{field} is required for every passenger.", details=where
                )

        if len(passenger["nationality"]) != 2:
            raise ValidationError(
                "nationality must be a two-letter country code.", details=where
            )

        try:
            born = date.fromisoformat(passenger["dateOfBirth"])
        except ValueError:
            raise ValidationError(
                "dateOfBirth must be YYYY-MM-DD.", details=where
            ) from None

        if born > travel_date:
            raise ValidationError(
                "dateOfBirth cannot be after the travel date.", details=where
            )

        low, high = AGE_BOUNDS[passenger_type]
        age = age_at(born, travel_date)
        if not low <= age <= high:
            raise ValidationError(
                f"A {passenger_type} must be {low} to {high} years old on the "
                "travel date.",
                details={**where, "ageAtTravel": age},
            )

    # An infant travels on an adult's lap, so an unaccompanied one is not a
    # booking an airline will accept.
    if counts["infant"] > counts["adult"]:
        raise ValidationError(
            "Every infant needs an accompanying adult.",
            details={"adults": counts["adult"], "infants": counts["infant"]},
        )
    if counts["adult"] == 0:
        raise ValidationError("A booking needs at least one adult.")

    if expected_counts:
        mismatched = {
            kind: {"searched": expected_counts.get(kind, 0), "submitted": counts[kind]}
            for kind in counts
            if expected_counts.get(kind, 0) != counts[kind]
        }
        if mismatched:
            raise ValidationError(
                "The passengers do not match the search this booking came from.",
                details=mismatched,
            )


def assert_total_matches_items(
    total_cents: int, items: list[dict], *, booking_id: str
) -> None:
    """§ 15: a total that disagrees with its line items is a money bug.

    Raising a 500 with a distinct type is deliberate. A silently wrong number
    reaches the traveller's card statement; a loud one reaches a monitor.
    """
    summed = sum(item["total_price_cents"] for item in items)
    if summed != total_cents:
        raise BookingTotalMismatchError(
            "The booking total does not match its items.",
            details={
                "bookingId": booking_id,
                "total_cents": total_cents,
                "items_cents": summed,
            },
        )
