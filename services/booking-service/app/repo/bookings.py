"""Booking reads and writes.

Every query is written out in SQL rather than through the ORM's relationship
loading, so that what the database actually runs is visible here -- which
matters a great deal once Database Monitoring is turned on in Phase 12.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import pnr as pnr_gen
from app.domain.states import BookingState, Trigger, next_state
from app.errors import BookingNotFoundError

HOLD_TTL_MINUTES_DEFAULT = 15

_BOOKING_COLUMNS = """
    id, pnr, user_id, product_type, state, currency,
    subtotal_cents, taxes_cents, ancillaries_cents, total_cents,
    search_id, result_id, contact_email, contact_phone,
    hold_expires_at, confirmed_at, cancelled_at, cancellation_reason,
    metadata, created_at, updated_at
"""


def _row_to_booking(row: Any) -> dict:
    booking = dict(row._mapping)
    for key in ("id", "user_id"):
        if booking.get(key) is not None:
            booking[key] = str(booking[key])
    for key in (
        "hold_expires_at",
        "confirmed_at",
        "cancelled_at",
        "created_at",
        "updated_at",
    ):
        value = booking.get(key)
        if isinstance(value, datetime):
            booking[key] = value.astimezone(timezone.utc).isoformat()
    if isinstance(booking.get("metadata"), str):
        booking["metadata"] = json.loads(booking["metadata"])
    return booking


async def create_draft(
    db: AsyncSession,
    *,
    user_id: str | None,
    product_type: str,
    currency: str,
    subtotal_cents: int,
    taxes_cents: int,
    total_cents: int,
    search_id: str,
    result_id: str,
    contact_email: str,
    contact_phone: str | None,
    metadata: dict,
    items: list[dict],
) -> dict:
    booking_id = uuid4()
    row = (
        await db.execute(
            text(
                f"""
                INSERT INTO bookings (
                    id, user_id, product_type, state, currency,
                    subtotal_cents, taxes_cents, ancillaries_cents, total_cents,
                    search_id, result_id, contact_email, contact_phone,
                    metadata, created_at, updated_at
                ) VALUES (
                    :id, :user_id, :product_type, 'DRAFT', :currency,
                    :subtotal_cents, :taxes_cents, 0, :total_cents,
                    :search_id, :result_id, :contact_email, :contact_phone,
                    CAST(:metadata AS JSONB), now(), now()
                )
                RETURNING {_BOOKING_COLUMNS}
                """
            ),
            {
                "id": booking_id,
                "user_id": UUID(user_id) if user_id else None,
                "product_type": product_type,
                "currency": currency,
                "subtotal_cents": subtotal_cents,
                "taxes_cents": taxes_cents,
                "total_cents": total_cents,
                "search_id": search_id,
                "result_id": result_id,
                "contact_email": contact_email,
                "contact_phone": contact_phone,
                "metadata": json.dumps(metadata),
            },
        )
    ).one()

    await replace_items(db, booking_id=str(booking_id), items=items)
    return _row_to_booking(row)


async def replace_items(db: AsyncSession, *, booking_id: str, items: list[dict]) -> None:
    await db.execute(
        text("DELETE FROM booking_items WHERE booking_id = :booking_id"),
        {"booking_id": UUID(booking_id)},
    )
    if not items:
        return
    await db.execute(
        text(
            """
            INSERT INTO booking_items (
                booking_id, item_type, flight_id, rate_plan_id, fare_class_code,
                description, quantity, unit_price_cents, total_price_cents,
                item_metadata
            ) VALUES (
                :booking_id, :item_type, :flight_id, :rate_plan_id, :fare_class_code,
                :description, :quantity, :unit_price_cents, :total_price_cents,
                CAST(:item_metadata AS JSONB)
            )
            """
        ),
        [
            {
                "booking_id": UUID(booking_id),
                "item_type": item["item_type"],
                "flight_id": item.get("flight_id"),
                "rate_plan_id": item.get("rate_plan_id"),
                "fare_class_code": item.get("fare_class_code"),
                "description": item["description"],
                "quantity": item.get("quantity", 1),
                "unit_price_cents": item["unit_price_cents"],
                "total_price_cents": item["total_price_cents"],
                "item_metadata": json.dumps(item.get("item_metadata") or {}),
            }
            for item in items
        ],
    )


async def get(db: AsyncSession, booking_id: str, *, for_update: bool = False) -> dict:
    """Read one booking, optionally locking the row.

    Every state transition takes the lock. Two payment webhooks arriving at
    once would otherwise both read PENDING_PAYMENT and both try to confirm.
    """
    try:
        key = UUID(booking_id)
    except ValueError:
        raise BookingNotFoundError(details={"bookingId": booking_id}) from None

    row = (
        await db.execute(
            text(
                f"SELECT {_BOOKING_COLUMNS} FROM bookings WHERE id = :id"
                + (" FOR UPDATE" if for_update else "")
            ),
            {"id": key},
        )
    ).one_or_none()
    if row is None:
        raise BookingNotFoundError(details={"bookingId": booking_id})
    return _row_to_booking(row)


async def get_by_pnr(db: AsyncSession, pnr: str, last_name: str) -> dict:
    """Guest lookup, and the AI agent's `lookup_booking` tool.

    The surname is matched case-insensitively against the passenger list, so a
    PNR on its own is not enough to read someone's itinerary.
    """
    row = (
        await db.execute(
            text(
                f"""
                SELECT {", ".join("b." + c.strip() for c in _BOOKING_COLUMNS.split(","))}
                FROM bookings b
                WHERE b.pnr = :pnr
                  AND EXISTS (
                      SELECT 1 FROM passengers p
                      WHERE p.booking_id = b.id
                        AND lower(p.last_name) = lower(:last_name)
                  )
                """
            ),
            {"pnr": pnr.upper(), "last_name": last_name},
        )
    ).one_or_none()
    if row is None:
        raise BookingNotFoundError(
            "No booking matches that reference and surname.",
            details={"pnr": pnr.upper()},
        )
    return _row_to_booking(row)


async def list_for_user(
    db: AsyncSession, user_id: str, *, limit: int, offset: int, n_plus_one: bool
) -> list[dict]:
    """List a traveller's bookings, with their items.

    `db_n_plus_one` swaps the join for a loop. This is the shape of a genuine
    ORM mistake -- one query for the list, then one per row -- and against
    400k bookings with `idx_bookings_user_id_created_at` dropped it is what
    makes scenario S3 land.
    """
    key = UUID(user_id)
    rows = (
        await db.execute(
            text(
                f"""
                SELECT {_BOOKING_COLUMNS} FROM bookings
                WHERE user_id = :user_id
                ORDER BY created_at DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {"user_id": key, "limit": limit, "offset": offset},
        )
    ).all()
    bookings = [_row_to_booking(row) for row in rows]
    if not bookings:
        return []

    ids = [UUID(booking["id"]) for booking in bookings]
    items_by_booking: dict[str, list[dict]] = {booking["id"]: [] for booking in bookings}

    if n_plus_one:
        for booking_id in ids:
            for item in (
                await db.execute(
                    text(
                        """
                        SELECT booking_id, item_type, description, quantity,
                               unit_price_cents, total_price_cents
                        FROM booking_items WHERE booking_id = :booking_id
                        """
                    ),
                    {"booking_id": booking_id},
                )
            ).all():
                items_by_booking[str(booking_id)].append(dict(item._mapping))
    else:
        for item in (
            await db.execute(
                text(
                    """
                    SELECT booking_id, item_type, description, quantity,
                           unit_price_cents, total_price_cents
                    FROM booking_items WHERE booking_id = ANY(:ids)
                    """
                ),
                {"ids": ids},
            )
        ).all():
            record = dict(item._mapping)
            items_by_booking[str(record["booking_id"])].append(record)

    for booking in bookings:
        items = items_by_booking[booking["id"]]
        for item in items:
            item.pop("booking_id", None)
        booking["items"] = items
    return bookings


async def items_for(db: AsyncSession, booking_id: str) -> list[dict]:
    rows = (
        await db.execute(
            text(
                """
                SELECT id, item_type, flight_id, rate_plan_id, fare_class_code,
                       description, quantity, unit_price_cents, total_price_cents,
                       item_metadata
                FROM booking_items WHERE booking_id = :booking_id ORDER BY id
                """
            ),
            {"booking_id": UUID(booking_id)},
        )
    ).all()
    return [dict(row._mapping) for row in rows]


async def transition(
    db: AsyncSession,
    *,
    booking: dict,
    trigger: Trigger,
    reason: str | None = None,
) -> dict:
    """Move a booking to its next state, or refuse.

    The state is resolved before the write, so an illegal transition never
    reaches the database at all.
    """
    current = BookingState(booking["state"])
    target = next_state(current, trigger)

    assignments = ["state = :state", "updated_at = now()"]
    params: dict[str, Any] = {"id": UUID(booking["id"]), "state": str(target)}

    if target is BookingState.CONFIRMED:
        assignments.append("confirmed_at = now()")
    if target is BookingState.CANCELLED:
        assignments.append("cancelled_at = now()")
        assignments.append("cancellation_reason = :reason")
        params["reason"] = reason
    if target in (BookingState.EXPIRED, BookingState.CANCELLED):
        assignments.append("hold_expires_at = NULL")

    row = (
        await db.execute(
            text(
                f"UPDATE bookings SET {', '.join(assignments)} "
                f"WHERE id = :id RETURNING {_BOOKING_COLUMNS}"
            ),
            params,
        )
    ).one()
    return _row_to_booking(row)


async def set_hold_expiry(
    db: AsyncSession, *, booking_id: str, ttl_minutes: int
) -> datetime:
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)
    await db.execute(
        text(
            "UPDATE bookings SET hold_expires_at = :expires_at, updated_at = now() "
            "WHERE id = :id"
        ),
        {"id": UUID(booking_id), "expires_at": expires_at},
    )
    return expires_at


async def issue_pnr(db: AsyncSession, booking_id: str, *, attempts: int = 5) -> str:
    """Assign a PNR, retrying on collision.

    With 32^6 codes a collision is rare but not impossible, and the unique
    index is the thing that decides -- not a pre-check, which would race.
    """
    for _ in range(attempts):
        candidate = pnr_gen.generate()
        try:
            async with db.begin_nested():
                await db.execute(
                    text(
                        "UPDATE bookings SET pnr = :pnr, updated_at = now() "
                        "WHERE id = :id"
                    ),
                    {"id": UUID(booking_id), "pnr": candidate},
                )
            return candidate
        except IntegrityError:
            continue
    raise RuntimeError("could not allocate a unique PNR")


async def replace_passengers(
    db: AsyncSession, *, booking_id: str, passengers: list[dict]
) -> None:
    await db.execute(
        text("DELETE FROM passengers WHERE booking_id = :booking_id"),
        {"booking_id": UUID(booking_id)},
    )
    await db.execute(
        text(
            """
            INSERT INTO passengers (
                booking_id, passenger_type, title, first_name, last_name,
                date_of_birth, nationality, passport_number, seat_assignment,
                frequent_flyer_number
            ) VALUES (
                :booking_id, :passenger_type, :title, :first_name, :last_name,
                :date_of_birth, :nationality, :passport_number,
                :seat_assignment, :frequent_flyer_number
            )
            """
        ),
        [
            {
                "booking_id": UUID(booking_id),
                "passenger_type": passenger["passengerType"],
                "title": passenger.get("title"),
                "first_name": passenger["firstName"],
                "last_name": passenger["lastName"],
                # asyncpg binds against the column's type, so it wants a real
                # date object here; the ISO string it arrived as is rejected
                # before the statement ever reaches Postgres.
                "date_of_birth": date.fromisoformat(passenger["dateOfBirth"]),
                "nationality": passenger["nationality"].upper(),
                "passport_number": passenger.get("passportNumber"),
                "seat_assignment": passenger.get("seatAssignment"),
                "frequent_flyer_number": passenger.get("frequentFlyerNumber"),
            }
            for passenger in passengers
        ],
    )


async def passengers_for(db: AsyncSession, booking_id: str) -> list[dict]:
    rows = (
        await db.execute(
            text(
                """
                SELECT passenger_type, title, first_name, last_name,
                       date_of_birth, nationality, seat_assignment,
                       frequent_flyer_number
                FROM passengers WHERE booking_id = :booking_id ORDER BY id
                """
            ),
            {"booking_id": UUID(booking_id)},
        )
    ).all()
    # passport_number is deliberately not selected. Nothing downstream needs
    # it, and the surest way not to leak a field is not to read it.
    return [
        {
            "passengerType": row.passenger_type,
            "title": row.title,
            "firstName": row.first_name,
            "lastName": row.last_name,
            "dateOfBirth": row.date_of_birth.isoformat(),
            "nationality": row.nationality,
            "seatAssignment": row.seat_assignment,
            "frequentFlyerNumber": row.frequent_flyer_number,
        }
        for row in rows
    ]


async def recalculate_totals(db: AsyncSession, booking_id: str) -> dict:
    """Re-derive the money columns from the line items.

    The items are the source of truth; the columns on `bookings` are a cached
    rollup, and this is the only thing allowed to write them.
    """
    # Every CTE column carries a `sum_` prefix and every returned column is
    # qualified with `b.`. Without both, `ancillaries_cents` names two things
    # in the same statement and Postgres refuses it as ambiguous.
    returning = ", ".join(
        "b." + column.strip() for column in _BOOKING_COLUMNS.split(",")
    )
    row = (
        await db.execute(
            text(
                f"""
                WITH sums AS (
                    SELECT
                        COALESCE(SUM(total_price_cents) FILTER (
                            WHERE item_type IN ('flight_segment','room_night')), 0)
                            AS sum_base_cents,
                        COALESCE(SUM(total_price_cents) FILTER (
                            WHERE item_type IN ('seat','baggage','upgrade','insurance')), 0)
                            AS sum_ancillaries_cents,
                        COALESCE(SUM(total_price_cents), 0) AS sum_total_cents
                    FROM booking_items WHERE booking_id = :id
                )
                UPDATE bookings b SET
                    subtotal_cents = sums.sum_base_cents,
                    ancillaries_cents = sums.sum_ancillaries_cents,
                    total_cents = sums.sum_total_cents + b.taxes_cents,
                    updated_at = now()
                FROM sums
                WHERE b.id = :id
                RETURNING {returning}
                """
            ),
            {"id": UUID(booking_id)},
        )
    ).one()
    return _row_to_booking(row)
