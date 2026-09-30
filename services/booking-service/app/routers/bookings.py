"""The booking lifecycle, per 05-FUNCTIONALITY.md §§ 2.5, 4.1 and 8."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

import structlog
from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, EmailStr, Field

from app import clients, db, metrics, tracing
from app.domain import validation
from app.domain.states import BookingState, Trigger
from app.errors import HoldExpiredError, ValidationError
from app.kafka import envelope
from app.middleware import current_request_id
from app.repo import bookings as booking_repo
from app.repo import holds as hold_repo
from app.state import runtime

router = APIRouter(prefix="/v1/bookings", tags=["bookings"])
log = structlog.get_logger()

ANCILLARY_TYPES = ("seat", "baggage", "upgrade", "insurance")

# Seat selection is free from economy_plus up; below that it is a paid
# ancillary (§ 15).
FREE_SEAT_CABINS = frozenset({"economy_plus", "business", "first"})


# ------------------------------------------------------------- the shapes --


class CreateBooking(BaseModel):
    searchId: str
    resultId: str
    userId: str | None = None
    contactEmail: EmailStr
    contactPhone: str | None = None
    passengerCounts: dict[str, int] = Field(
        default_factory=lambda: {"adult": 1, "child": 0, "infant": 0}
    )


class Passenger(BaseModel):
    passengerType: Literal["adult", "child", "infant"]
    title: str | None = None
    firstName: str
    lastName: str
    dateOfBirth: str
    nationality: str
    passportNumber: str | None = None
    seatAssignment: str | None = None
    frequentFlyerNumber: str | None = None


class SetPassengers(BaseModel):
    passengers: list[Passenger]


class Ancillary(BaseModel):
    type: Literal["seat", "baggage", "upgrade", "insurance"]
    description: str
    quantity: int = Field(default=1, ge=1, le=9)
    passengerIndex: int | None = None
    seat: str | None = None


class SetAncillaries(BaseModel):
    ancillaries: list[Ancillary]


class Cancel(BaseModel):
    reason: str | None = None


# ------------------------------------------------------------------ create --


@router.post("", status_code=201)
async def create_booking(body: CreateBooking) -> dict:
    """DRAFT, built from a search result rather than from the client's body.

    The client sends a pointer; the price comes from search-service. That is
    the difference between a booking system and a tip jar.
    """
    offer = await clients.fetch_search_result(body.searchId, body.resultId)
    fare = offer["fare"]

    total_people = sum(body.passengerCounts.get(k, 0) for k in ("adult", "child", "infant"))
    if not 1 <= total_people <= validation.MAX_PASSENGERS:
        raise ValidationError(
            f"A booking carries 1 to {validation.MAX_PASSENGERS} passengers.",
            details={"submitted": total_people},
        )

    base_cents = (fare["baseAmountCents"] + fare["adjustmentsCents"]) * total_people
    taxes_cents = fare["taxesCents"] * total_people

    # Read once, here, and carried on the booking from now on. The `tier` tag on
    # every later booking metric comes off this snapshot, and the confirmation
    # arrives from Kafka where there is nothing left to ask.
    tier = await metrics.lookup_tier(body.userId)

    segment = (offer.get("segments") or [{}])[0]
    items = [
        {
            "item_type": "flight_segment",
            "flight_id": int(segment["flightId"]) if segment.get("flightId") else None,
            "fare_class_code": fare.get("basis"),
            "description": _segment_description(offer, segment),
            "quantity": total_people,
            "unit_price_cents": fare["baseAmountCents"] + fare["adjustmentsCents"],
            "total_price_cents": base_cents,
            "item_metadata": {
                "provider": offer.get("provider"),
                "offerId": offer.get("offerId"),
                "cabin": fare.get("cabin"),
            },
        }
    ]

    async with db.transaction() as session:
        booking = await booking_repo.create_draft(
            session,
            user_id=body.userId,
            product_type="flight",
            currency=fare["currency"],
            subtotal_cents=base_cents,
            taxes_cents=taxes_cents,
            total_cents=base_cents + taxes_cents,
            search_id=body.searchId,
            result_id=body.resultId,
            contact_email=str(body.contactEmail),
            contact_phone=body.contactPhone,
            metadata={
                "passengerCounts": body.passengerCounts,
                "userTier": tier,
                "departDate": segment.get("departureTime", "")[:10],
                "origin": segment.get("origin"),
                "destination": segment.get("destination"),
                "cabin": fare.get("cabin"),
                "fareClassCode": fare.get("basis"),
                "refundable": fare.get("refundable", False),
            },
            items=items,
        )

    await runtime.producer.send(
        envelope.TOPIC_BOOKINGS,
        booking["id"],
        "booking.created",
        envelope.booking_payload(booking),
        correlation_id=current_request_id(),
    )
    tracing.tag_booking(booking)
    metrics.booking_created(product=booking["product_type"], tier=tier)
    log.info(
        "Booking created",
        booking={
            "id": booking["id"],
            "state": booking["state"],
            "product_type": booking["product_type"],
            "total_cents": booking["total_cents"],
        },
    )
    return _public(booking, items=await _items(booking["id"]))


# -------------------------------------------------------------------- hold --


@router.post("/{booking_id}/hold")
async def hold_booking(booking_id: str) -> dict:
    """DRAFT -> HELD, reserving the inventory under an advisory lock."""
    # § 15: fifteen minutes, non-extendable. The TTL is configuration rather
    # than a chaos flag -- it is not in the § 11 catalogue, and shortening it
    # is a test affordance, not an injected fault.
    ttl_minutes = runtime.hold_ttl_minutes
    widen = runtime.chaos.is_enabled("hold_lock_contention")

    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        expires_at = await booking_repo.set_hold_expiry(
            session, booking_id=booking_id, ttl_minutes=ttl_minutes
        )
        booking = await booking_repo.transition(
            session, booking=booking, trigger=Trigger.HOLD
        )

        acquired = []
        for item in await booking_repo.items_for(session, booking_id):
            if item["item_type"] == "flight_segment" and item["flight_id"]:
                acquired.append(
                    await hold_repo.acquire(
                        session,
                        booking_id=booking_id,
                        resource_type="flight_seat",
                        resource_id=item["flight_id"],
                        quantity=item["quantity"],
                        expires_at=expires_at,
                        widen_critical_section=widen,
                    )
                )
            elif item["item_type"] == "room_night" and item["rate_plan_id"]:
                acquired.append(
                    await hold_repo.acquire(
                        session,
                        booking_id=booking_id,
                        resource_type="hotel_room",
                        resource_id=item["rate_plan_id"],
                        quantity=item["quantity"],
                        expires_at=expires_at,
                        widen_critical_section=widen,
                    )
                )
        booking["hold_expires_at"] = expires_at.isoformat()

    await runtime.producer.send(
        envelope.TOPIC_BOOKINGS,
        booking_id,
        "booking.held",
        {**envelope.booking_payload(booking), "holdExpiresAt": booking["hold_expires_at"]},
        correlation_id=current_request_id(),
    )
    log.info(
        "Inventory held",
        booking={"id": booking_id, "state": booking["state"]},
        hold={"expires_at": booking["hold_expires_at"], "resources": len(acquired)},
    )
    return {**_public(booking), "holds": acquired}


# -------------------------------------------------------------- passengers --


@router.put("/{booking_id}/passengers")
async def set_passengers(booking_id: str, body: SetPassengers) -> dict:
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        _require_open_hold(booking)

        metadata = booking.get("metadata") or {}
        travel_date = _travel_date(metadata)
        submitted = [p.model_dump() for p in body.passengers]

        validation.validate_passengers(
            submitted,
            travel_date=travel_date,
            expected_counts=metadata.get("passengerCounts"),
        )
        _reject_free_seat_requests(submitted, cabin=metadata.get("cabin", "economy"))

        await booking_repo.replace_passengers(
            session, booking_id=booking_id, passengers=submitted
        )

    tracing.tag_booking(booking)
    log.info(
        "Passengers recorded",
        booking={"id": booking_id, "state": booking["state"]},
        passenger_count=len(body.passengers),
    )
    return {
        **_public(booking),
        "passengers": await _passengers(booking_id),
    }


# -------------------------------------------------------------- ancillaries --


@router.put("/{booking_id}/ancillaries")
async def set_ancillaries(booking_id: str, body: SetAncillaries) -> dict:
    """Replace the extras and re-price, because extras move the total."""
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        _require_open_hold(booking)

        existing = [
            item
            for item in await booking_repo.items_for(session, booking_id)
            if item["item_type"] not in ANCILLARY_TYPES
        ]

        offers = [
            {
                "id": f"anc-{index}",
                "productType": "ancillary",
                "departDate": booking["metadata"].get("departDate")
                or date.today().isoformat(),
                "fareClass": ancillary.type,
                "cabin": booking["metadata"].get("cabin", "economy"),
                "baseAmountCents": _ancillary_base_cents(ancillary.type),
                "currency": booking["currency"],
            }
            for index, ancillary in enumerate(body.ancillaries)
        ]
        quotes = await clients.price_ancillaries(offers)

        for index, ancillary in enumerate(body.ancillaries):
            quote = quotes.get(f"anc-{index}", {})
            unit = quote.get("totalAmountCents", _ancillary_base_cents(ancillary.type))
            existing.append(
                {
                    "item_type": ancillary.type,
                    "description": ancillary.description,
                    "quantity": ancillary.quantity,
                    "unit_price_cents": unit,
                    "total_price_cents": unit * ancillary.quantity,
                    "item_metadata": {
                        "passengerIndex": ancillary.passengerIndex,
                        "seat": ancillary.seat,
                    },
                }
            )

        await booking_repo.replace_items(session, booking_id=booking_id, items=existing)
        booking = await booking_repo.recalculate_totals(session, booking_id)

        # The rollup and the line items must agree before anyone is charged.
        validation.assert_total_matches_items(
            booking["total_cents"] - booking["taxes_cents"],
            existing,
            booking_id=booking_id,
        )

    tracing.tag_booking(booking)
    log.info(
        "Ancillaries priced",
        booking={"id": booking_id, "total_cents": booking["total_cents"]},
        ancillary_count=len(body.ancillaries),
    )
    return _public(booking, items=await _items(booking_id))


# ------------------------------------------------------------- authorizing --


@router.post("/{booking_id}/authorizing")
async def begin_authorization(booking_id: str) -> dict:
    """HELD -> PENDING_PAYMENT, or FAILED -> PENDING_PAYMENT on a retry.

    payment-service calls this before it touches the card. Booking state is
    owned here, so this is the only place that decides whether a booking may
    enter payment at all -- and a hold that has already run out is refused,
    which is what stops a traveller paying for a seat they no longer have.
    """
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        _require_open_hold(booking)
        trigger = (
            Trigger.RETRY
            if booking["state"] == BookingState.FAILED
            else Trigger.AUTHORIZE
        )
        booking = await booking_repo.transition(
            session, booking=booking, trigger=trigger
        )

    log.info(
        "Booking entered payment",
        booking={"id": booking_id, "state": booking["state"]},
        retry=trigger is Trigger.RETRY,
    )
    return _public(booking)


# ----------------------------------------------------------------- confirm --


@router.post("/{booking_id}/confirm")
async def confirm_booking(booking_id: str) -> dict:
    """Confirm on the strength of an already-authorized payment.

    The normal route to CONFIRMED is the `payment.authorized` consumer; this
    endpoint exists so a stuck booking can be driven forward by hand, and it
    refuses any booking whose payment has not actually landed.
    """
    from app.consumers.payments import confirm

    booking = await confirm(booking_id, correlation_id=current_request_id())
    return _public(booking, items=await _items(booking_id))


# ------------------------------------------------------------------ cancel --


@router.post("/{booking_id}/cancel")
async def cancel_booking(booking_id: str, body: Cancel) -> dict:
    """Cancel, releasing inventory. A non-refundable fare cancels with a zero
    refund rather than an error (§ 15)."""
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        state = BookingState(booking["state"])
        trigger = Trigger.CANCEL if state is BookingState.CONFIRMED else Trigger.ABANDON

        booking = await booking_repo.transition(
            session, booking=booking, trigger=trigger, reason=body.reason
        )
        released = await hold_repo.release(session, booking_id, state="released")

    refundable = bool((booking.get("metadata") or {}).get("refundable"))
    refund_cents = booking["total_cents"] if refundable else 0

    await runtime.producer.send(
        envelope.TOPIC_BOOKINGS,
        booking_id,
        "booking.cancelled",
        {
            **envelope.booking_payload(booking),
            "reason": body.reason,
            "refundCents": refund_cents,
        },
        correlation_id=current_request_id(),
    )
    await runtime.producer.send(
        envelope.TOPIC_NOTIFICATIONS,
        booking_id,
        "notification.requested",
        {
            "template": "booking_cancelled",
            "recipient": booking["contact_email"],
            # Alongside `variables` rather than inside it: variables is the
            # template's data, and a template that never renders a booking id
            # should not be handed one. notification-worker has no database,
            # so these two are the only way its spans can carry booking.id
            # and product.type.
            "bookingId": booking_id,
            "productType": booking["product_type"],
            "variables": {
                "pnr": booking.get("pnr") or "",
                "refundCents": refund_cents,
                "currency": booking["currency"],
            },
        },
        correlation_id=current_request_id(),
    )
    log.info(
        "Booking cancelled",
        booking={"id": booking_id, "state": booking["state"]},
        holds_released=released,
        refund_cents=refund_cents,
    )
    return {
        **_public(booking),
        "refund": {"amountCents": refund_cents, "refundable": refundable},
    }


# ------------------------------------------------------------------- reads --


@router.get("")
async def list_bookings(
    response: Response,
    user_id: str | None = Query(default=None),
    pnr: str | None = Query(default=None),
    lastName: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """Either a traveller's own list, or a guest lookup by PNR and surname."""
    if pnr:
        if not lastName:
            raise ValidationError("A PNR lookup also needs lastName.")
        async with db.session() as session:
            booking = await booking_repo.get_by_pnr(session, pnr, lastName)
        tracing.tag_booking(booking)
        return {
            "bookings": [_public(booking, items=await _items(booking["id"]))],
            "count": 1,
        }

    if not user_id:
        raise ValidationError("Provide either user_id, or pnr with lastName.")

    tracing.tag_root({"usr.id": user_id})
    n_plus_one = runtime.chaos.is_enabled("db_n_plus_one")
    async with db.session() as session:
        found = await booking_repo.list_for_user(
            session, user_id, limit=limit, offset=offset, n_plus_one=n_plus_one
        )

    response.headers["x-query-strategy"] = "loop" if n_plus_one else "join"
    return {
        "bookings": [_public(booking, items=booking.get("items")) for booking in found],
        "count": len(found),
    }


@router.get("/{booking_id}")
async def get_booking(booking_id: str) -> dict:
    async with db.session() as session:
        booking = await booking_repo.get(session, booking_id)
    tracing.tag_booking(booking)
    return _public(
        booking,
        items=await _items(booking_id),
        passengers=await _passengers(booking_id),
    )


# ------------------------------------------------------------------ shared --


def _require_open_hold(booking: dict) -> None:
    """Refuse to edit a booking whose hold has already run out.

    Without this the traveller fills in four passengers against inventory that
    was handed back to someone else two minutes ago.
    """
    if booking["state"] not in (BookingState.HELD, BookingState.FAILED):
        from app.errors import InvalidBookingTransitionError

        raise InvalidBookingTransitionError(
            "Details can only be changed while the reservation is held.",
            details={"from": booking["state"]},
        )
    expires_at = booking.get("hold_expires_at")
    if expires_at and datetime.fromisoformat(expires_at) < datetime.now(
        datetime.fromisoformat(expires_at).tzinfo
    ):
        raise HoldExpiredError(details={"bookingId": booking["id"]})


def _reject_free_seat_requests(passengers: list[dict], *, cabin: str) -> None:
    """§ 15: a seat is only free from economy_plus up.

    Below that a seat has to arrive as a paid ancillary, so a seat number
    smuggled in with the passenger details is refused rather than honoured.
    """
    if cabin in FREE_SEAT_CABINS:
        return
    for index, passenger in enumerate(passengers):
        if passenger.get("seatAssignment"):
            raise ValidationError(
                "Seat selection on this fare is a paid extra. Add it as an "
                "ancillary instead.",
                details={"index": index, "cabin": cabin},
            )


def _ancillary_base_cents(kind: str) -> int:
    # Published list prices; pricing-service applies the rules on top.
    return {"seat": 1200, "baggage": 3500, "upgrade": 9500, "insurance": 2400}[kind]


def _travel_date(metadata: dict) -> date:
    raw = metadata.get("departDate")
    try:
        return date.fromisoformat(raw) if raw else date.today()
    except ValueError:
        return date.today()


def _segment_description(offer: dict, segment: dict) -> str:
    airline = (offer.get("airline") or {}).get("name", "")
    number = segment.get("flightNumber", "")
    return f"{airline} {number} {segment.get('origin','')}-{segment.get('destination','')}".strip()


async def _items(booking_id: str) -> list[dict]:
    async with db.session() as session:
        return [
            {
                "type": item["item_type"],
                "description": item["description"],
                "quantity": item["quantity"],
                "unitPriceCents": item["unit_price_cents"],
                "totalPriceCents": item["total_price_cents"],
            }
            for item in await booking_repo.items_for(session, booking_id)
        ]


async def _passengers(booking_id: str) -> list[dict]:
    async with db.session() as session:
        return await booking_repo.passengers_for(session, booking_id)


def _public(
    booking: dict, *, items: list[dict] | None = None, passengers: list[dict] | None = None
) -> dict:
    body = {
        "id": booking["id"],
        "pnr": booking.get("pnr"),
        "userId": booking.get("user_id"),
        "state": booking["state"],
        "productType": booking["product_type"],
        "currency": booking["currency"],
        "subtotalCents": booking["subtotal_cents"],
        "taxesCents": booking["taxes_cents"],
        "ancillariesCents": booking["ancillaries_cents"],
        "totalCents": booking["total_cents"],
        "searchId": booking.get("search_id"),
        "resultId": booking.get("result_id"),
        "contactEmail": booking["contact_email"],
        "holdExpiresAt": booking.get("hold_expires_at"),
        "confirmedAt": booking.get("confirmed_at"),
        "cancelledAt": booking.get("cancelled_at"),
        "createdAt": booking.get("created_at"),
        "metadata": booking.get("metadata") or {},
    }
    if items is not None:
        body["items"] = items
    if passengers is not None:
        body["passengers"] = passengers
    return body
