"""Bookings and everything that hangs off them.

Each booking's attributes are a pure function of its index, derived from a
per-booking RNG. That means every table can be streamed in its own COPY pass
without holding 400,000 booking objects in memory, and two runs produce
identical rows.
"""

from __future__ import annotations

import random
from array import array
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterator, Sequence

from psycopg.types.json import Jsonb

from . import catalog
from .accounts import User
from .config import SeedConfig
from .identity import (
    NS_BOOKING,
    NS_HOLD,
    NS_PAYMENT,
    pnr_for,
    uuid_for,
)
from .inventory import Route

GUEST = -1
HISTORY_DAYS = 730
UPCOMING_SHARE = 0.03
GUEST_SHARE = 0.05
TAX_RATE = 0.11

# 05-FUNCTIONALITY.md § 4.1. EXPIRED and REFUNDED are the terminal states.
BOOKING_STATES = (
    "DRAFT", "HELD", "PENDING_PAYMENT", "CONFIRMED",
    "FAILED", "EXPIRED", "CANCELLED", "REFUNDED",
)
BOOKING_STATE_WEIGHTS = (0.020, 0.008, 0.007, 0.760, 0.035, 0.050, 0.080, 0.040)

# A PNR is issued on CONFIRMED and survives cancellation and refund.
STATES_WITH_PNR = frozenset({"CONFIRMED", "CANCELLED", "REFUNDED"})

PAYMENT_STATE_BY_BOOKING_STATE = {
    "PENDING_PAYMENT": "AUTHORIZING",
    "CONFIRMED": "CAPTURED",
    "FAILED": "DECLINED",
    "CANCELLED": "CAPTURED",
    "REFUNDED": "REFUNDED",
}

FARE_CLASSES_BY_CABIN: dict[str, tuple[str, ...]] = {}
for _code, _cabin, *_rest in catalog.FARE_CLASSES:
    FARE_CLASSES_BY_CABIN.setdefault(_cabin, ())
    FARE_CLASSES_BY_CABIN[_cabin] += (_code,)


@dataclass(frozen=True)
class Item:
    item_type: str
    flight_id: int | None
    rate_plan_id: int | None
    fare_class_code: str | None
    description: str
    quantity: int
    unit_price_cents: int
    total_price_cents: int
    metadata: dict


@dataclass(frozen=True)
class Passenger:
    passenger_type: str
    title: str
    first_name: str
    last_name: str
    date_of_birth: datetime
    nationality: str
    seat_assignment: str | None


@dataclass(frozen=True)
class Facts:
    index: int
    id: str
    user_id: str | None
    user_tier: str
    product_type: str
    state: str
    created_at: datetime
    subtotal_cents: int
    taxes_cents: int
    ancillaries_cents: int
    total_cents: int
    pnr: str | None
    confirmed_at: datetime | None
    cancelled_at: datetime | None
    hold_expires_at: datetime | None
    cancellation_reason: str | None
    contact_email: str
    contact_phone: str
    channel: str
    items: tuple[Item, ...]
    passengers: tuple[Passenger, ...]
    has_payment: bool
    payment_state: str | None
    decline_code: str | None
    card_brand: str
    card_last4: str
    has_hold: bool
    hold_state: str | None


class BookingFactory:
    """Derives the full shape of any booking from its index alone."""

    def __init__(
        self,
        config: SeedConfig,
        users: Sequence[User],
        routes: Sequence[Route],
        upcoming_flight_ids: Sequence[int],
        rate_plan_count: int,
        ownership: array,
    ) -> None:
        self.config = config
        self.users = users
        self.routes = routes
        self.upcoming_flight_ids = upcoming_flight_ids
        self.rate_plan_count = max(1, rate_plan_count)
        self.ownership = ownership
        self._salt = config.random_seed * 1_000_003

    def rng_for(self, index: int) -> random.Random:
        return random.Random(self._salt ^ (index * 2_654_435_761))

    def facts(self, index: int) -> Facts:
        rng = self.rng_for(index)
        anchor = self.config.anchor_datetime

        owner_index = self.ownership[index]
        user = self.users[owner_index] if owner_index != GUEST else None

        is_upcoming = rng.random() < UPCOMING_SHARE
        if is_upcoming:
            created_at = anchor - timedelta(
                days=rng.randrange(0, 60), minutes=rng.randrange(0, 1440)
            )
        else:
            created_at = anchor - timedelta(
                days=rng.randrange(0, HISTORY_DAYS), minutes=rng.randrange(0, 1440)
            )

        state = rng.choices(BOOKING_STATES, weights=BOOKING_STATE_WEIGHTS)[0]
        product_type = "flight" if rng.random() < 0.78 else "hotel"

        passengers = self._passengers(rng, product_type, created_at)
        items = (
            self._flight_items(rng, len(passengers), is_upcoming)
            if product_type == "flight"
            else self._hotel_items(rng, len(passengers))
        )

        ancillary_types = {"seat", "baggage", "upgrade", "insurance"}
        subtotal = sum(
            i.total_price_cents for i in items if i.item_type not in ancillary_types
        )
        ancillaries = sum(
            i.total_price_cents for i in items if i.item_type in ancillary_types
        )
        taxes = round((subtotal + ancillaries) * TAX_RATE)
        total = subtotal + taxes + ancillaries

        confirmed_at = None
        cancelled_at = None
        cancellation_reason = None
        hold_expires_at = None

        if state in STATES_WITH_PNR:
            confirmed_at = created_at + timedelta(seconds=rng.randrange(20, 900))
        if state in ("CANCELLED", "REFUNDED"):
            cancelled_at = confirmed_at + timedelta(
                days=rng.randrange(0, 60), minutes=rng.randrange(0, 1440)
            )
            cancellation_reason = rng.choice(catalog.CANCELLATION_REASONS)
        if state in ("HELD", "PENDING_PAYMENT", "EXPIRED"):
            hold_expires_at = created_at + timedelta(minutes=15)

        has_payment = state in PAYMENT_STATE_BY_BOOKING_STATE or (
            state == "EXPIRED" and rng.random() < 0.5
        )
        payment_state = (
            PAYMENT_STATE_BY_BOOKING_STATE.get(state, "DECLINED")
            if has_payment
            else None
        )
        decline_code = (
            rng.choices(catalog.DECLINE_CODES, weights=catalog.DECLINE_CODE_WEIGHTS)[0]
            if payment_state == "DECLINED"
            else None
        )

        # A hold exists for anything still live, plus recent history -- older
        # holds are assumed to have been swept away.
        has_hold = state in ("HELD", "PENDING_PAYMENT") or (
            (anchor - created_at).days < 45
        )
        hold_state = None
        if has_hold:
            if state in ("HELD", "PENDING_PAYMENT"):
                hold_state = "active"
            elif state in STATES_WITH_PNR:
                hold_state = "consumed"
            elif state == "EXPIRED":
                hold_state = "expired"
            else:
                hold_state = "released"

        first = passengers[0]
        email = (
            user.email
            if user
            else f"{first.first_name}.{first.last_name}{index % 9973}@voyager.demo".lower()
        )

        return Facts(
            index=index,
            id=str(uuid_for(NS_BOOKING, index)),
            user_id=user.id if user else None,
            user_tier=user.tier if user else "standard",
            product_type=product_type,
            state=state,
            created_at=created_at,
            subtotal_cents=subtotal,
            taxes_cents=taxes,
            ancillaries_cents=ancillaries,
            total_cents=total,
            pnr=pnr_for(index) if state in STATES_WITH_PNR else None,
            confirmed_at=confirmed_at,
            cancelled_at=cancelled_at,
            hold_expires_at=hold_expires_at,
            cancellation_reason=cancellation_reason,
            contact_email=email,
            contact_phone=f"+44 7{rng.randrange(100000000, 999999999)}",
            channel=rng.choices(
                ("web", "mobile_web", "api"), weights=(0.68, 0.28, 0.04)
            )[0],
            items=items,
            passengers=passengers,
            has_payment=has_payment,
            payment_state=payment_state,
            decline_code=decline_code,
            card_brand=rng.choice(catalog.CARD_BRANDS),
            card_last4=f"{rng.randrange(0, 10000):04d}",
            has_hold=has_hold,
            hold_state=hold_state,
        )

    # ------------------------------------------------------------- pieces --

    def _passengers(
        self, rng: random.Random, product_type: str, created_at: datetime
    ) -> tuple[Passenger, ...]:
        adults = rng.choices((1, 2, 3, 4), weights=(0.52, 0.34, 0.09, 0.05))[0]
        children = 0 if rng.random() < 0.84 else rng.randrange(1, 3)
        infants = 0 if rng.random() < 0.95 else 1

        people: list[Passenger] = []
        for kind, count in (("adult", adults), ("child", children), ("infant", infants)):
            for _ in range(count):
                if kind == "adult":
                    age_days = rng.randrange(18 * 365, 78 * 365)
                elif kind == "child":
                    age_days = rng.randrange(2 * 365, 12 * 365)
                else:
                    age_days = rng.randrange(30, 2 * 365)
                people.append(
                    Passenger(
                        passenger_type=kind,
                        title=rng.choice(catalog.TITLES),
                        first_name=rng.choice(catalog.FIRST_NAMES),
                        last_name=rng.choice(catalog.LAST_NAMES),
                        date_of_birth=(created_at - timedelta(days=age_days)).date(),
                        nationality=rng.choice(catalog.NATIONALITIES),
                        seat_assignment=(
                            f"{rng.randrange(1, 42)}{rng.choice('ABCDEF')}"
                            if product_type == "flight" and rng.random() < 0.42
                            else None
                        ),
                    )
                )
        return tuple(people)

    def _flight_items(
        self, rng: random.Random, pax: int, is_upcoming: bool
    ) -> tuple[Item, ...]:
        route = rng.choice(self.routes)
        cabin = rng.choices(
            [c for c, _ in catalog.CABIN_WEIGHTS],
            weights=[w for _, w in catalog.CABIN_WEIGHTS],
        )[0]
        fare_class = rng.choice(FARE_CLASSES_BY_CABIN[cabin])
        airline = rng.choice(route.airlines)
        return_trip = rng.random() < 0.62

        unit = int(
            route.base_price_cents
            * catalog.CABIN_PRICE_MULTIPLIER[cabin]
            * catalog.FARE_CLASS_PRICE_MULTIPLIER[fare_class]
            * rng.uniform(0.88, 1.28)
        )

        # Only forward-dated trips point at a live schedule row. Historical
        # itineraries carry their detail in item_metadata instead, which is
        # what a real system does once the flight has operated.
        flight_id = (
            rng.choice(self.upcoming_flight_ids)
            if is_upcoming and self.upcoming_flight_ids
            else None
        )

        items = [
            Item(
                item_type="flight_segment",
                flight_id=flight_id,
                rate_plan_id=None,
                fare_class_code=fare_class,
                description=f"{route.origin} to {route.destination}",
                quantity=pax,
                unit_price_cents=unit,
                total_price_cents=unit * pax,
                metadata={
                    "airline": airline,
                    "flight_number": f"{airline}{rng.randrange(1000, 9999)}",
                    "origin": route.origin,
                    "destination": route.destination,
                    "cabin": cabin,
                    "direction": "outbound",
                },
            )
        ]
        if return_trip:
            items.append(
                Item(
                    item_type="flight_segment",
                    flight_id=None,
                    rate_plan_id=None,
                    fare_class_code=fare_class,
                    description=f"{route.destination} to {route.origin}",
                    quantity=pax,
                    unit_price_cents=unit,
                    total_price_cents=unit * pax,
                    metadata={
                        "airline": airline,
                        "flight_number": f"{airline}{rng.randrange(1000, 9999)}",
                        "origin": route.destination,
                        "destination": route.origin,
                        "cabin": cabin,
                        "direction": "inbound",
                    },
                )
            )

        items.extend(self._ancillaries(rng, pax))
        return tuple(items)

    def _hotel_items(self, rng: random.Random, guests: int) -> tuple[Item, ...]:
        nights = rng.choices(
            (1, 2, 3, 4, 5, 7, 10, 14),
            weights=(0.16, 0.24, 0.21, 0.14, 0.11, 0.09, 0.03, 0.02),
        )[0]
        rooms = 1 if guests <= 2 else 2
        nightly = rng.randrange(6_500, 48_000)
        quantity = nights * rooms
        items = [
            Item(
                item_type="room_night",
                flight_id=None,
                rate_plan_id=rng.randrange(1, self.rate_plan_count + 1),
                fare_class_code=None,
                description=f"{nights} night stay, {rooms} room(s)",
                quantity=quantity,
                unit_price_cents=nightly,
                total_price_cents=nightly * quantity,
                metadata={"nights": nights, "rooms": rooms},
            )
        ]
        if rng.random() < 0.18:
            upgrade = rng.randrange(2_000, 12_000)
            items.append(
                Item(
                    item_type="upgrade",
                    flight_id=None,
                    rate_plan_id=None,
                    fare_class_code=None,
                    description="Room upgrade",
                    quantity=1,
                    unit_price_cents=upgrade,
                    total_price_cents=upgrade,
                    metadata={},
                )
            )
        return tuple(items)

    def _ancillaries(self, rng: random.Random, pax: int) -> list[Item]:
        extras: list[Item] = []
        if rng.random() < 0.30:
            price = rng.randrange(800, 4_500)
            extras.append(
                Item("seat", None, None, None, "Seat selection", pax, price,
                     price * pax, {})
            )
        if rng.random() < 0.22:
            price = rng.randrange(2_500, 8_000)
            extras.append(
                Item("baggage", None, None, None, "Checked baggage", pax, price,
                     price * pax, {})
            )
        if rng.random() < 0.08:
            price = rng.randrange(1_500, 5_500)
            extras.append(
                Item("insurance", None, None, None, "Travel insurance", 1, price,
                     price, {})
            )
        return extras


# --------------------------------------------------------------- ownership --


def build_ownership(
    config: SeedConfig, rng: random.Random, users: Sequence[User]
) -> array:
    """Decide which user owns each booking.

    Power users are allocated first because their counts are a hard
    requirement; guests and the long tail share what is left.
    """
    volumes = config.volumes
    total = volumes.bookings
    owners = array("i")

    for n in range(volumes.power_users):
        count = rng.randrange(
            volumes.power_user_bookings_min, volumes.power_user_bookings_max + 1
        )
        owners.extend([n] * count)

    remaining = total - len(owners)
    if remaining <= 0:
        raise ValueError("power users alone exceed the booking target")

    guests = int(remaining * GUEST_SHARE)
    owners.extend([GUEST] * guests)
    remaining -= guests

    # A Pareto weighting gives a realistic long tail: most accounts book a
    # handful of times, a few book often.
    regular = list(range(volumes.power_users, volumes.power_users + volumes.users))
    weights = [rng.paretovariate(1.4) for _ in regular]
    total_weight = sum(weights)

    allocated = 0
    for position, user_index in enumerate(regular):
        if position == len(regular) - 1:
            count = remaining - allocated
        else:
            count = int(remaining * weights[position] / total_weight)
        count = max(0, count)
        owners.extend([user_index] * count)
        allocated += count

    # Top up or trim to land exactly on the target.
    while len(owners) < total:
        owners.append(regular[len(owners) % len(regular)])
    if len(owners) > total:
        del owners[total:]

    # Interleave, so a user's bookings are not physically contiguous on disk.
    shuffled = owners.tolist()
    rng.shuffle(shuffled)
    return array("i", shuffled)


# ------------------------------------------------------------------- rows --


def booking_rows(factory: BookingFactory) -> Iterator[tuple]:
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        yield (
            f.id, f.pnr, f.user_id, f.product_type, f.state, "GBP",
            f.subtotal_cents, f.taxes_cents, f.ancillaries_cents, f.total_cents,
            None, None, f.contact_email, f.contact_phone, f.hold_expires_at,
            f.confirmed_at, f.cancelled_at, f.cancellation_reason,
            Jsonb({"channel": f.channel, "seeded": True}),
            f.created_at,
            f.cancelled_at or f.confirmed_at or f.created_at,
        )


BOOKING_COLUMNS = (
    "id", "pnr", "user_id", "product_type", "state", "currency",
    "subtotal_cents", "taxes_cents", "ancillaries_cents", "total_cents",
    "search_id", "result_id", "contact_email", "contact_phone",
    "hold_expires_at", "confirmed_at", "cancelled_at", "cancellation_reason",
    "metadata", "created_at", "updated_at",
)


def booking_item_rows(factory: BookingFactory) -> Iterator[tuple]:
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        for item in f.items:
            yield (
                f.id, item.item_type, item.flight_id, item.rate_plan_id,
                item.fare_class_code, item.description, item.quantity,
                item.unit_price_cents, item.total_price_cents,
                Jsonb(item.metadata), f.created_at,
            )


BOOKING_ITEM_COLUMNS = (
    "booking_id", "item_type", "flight_id", "rate_plan_id", "fare_class_code",
    "description", "quantity", "unit_price_cents", "total_price_cents",
    "item_metadata", "created_at",
)


def passenger_rows(factory: BookingFactory) -> Iterator[tuple]:
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        for position, person in enumerate(f.passengers):
            yield (
                f.id, person.passenger_type, person.title, person.first_name,
                person.last_name, person.date_of_birth, person.nationality,
                # Obvious fakes. No real passport number is ever stored.
                f"X{(index * 7 + position) % 10_000_000:07d}",
                person.seat_assignment, None, f.created_at,
            )


PASSENGER_COLUMNS = (
    "booking_id", "passenger_type", "title", "first_name", "last_name",
    "date_of_birth", "nationality", "passport_number", "seat_assignment",
    "frequent_flyer_number", "created_at",
)


def hold_rows(factory: BookingFactory) -> Iterator[tuple]:
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        if not f.has_hold:
            continue
        expires = f.hold_expires_at or (f.created_at + timedelta(minutes=15))
        released = None if f.hold_state == "active" else expires
        yield (
            str(uuid_for(NS_HOLD, index)),
            f.id,
            "flight_seat" if f.product_type == "flight" else "hotel_room",
            (index % 150_000) + 1,
            len(f.passengers),
            f.hold_state,
            expires,
            released,
            f.created_at,
        )


HOLD_COLUMNS = (
    "id", "booking_id", "resource_type", "resource_id", "quantity", "state",
    "expires_at", "released_at", "created_at",
)


def payment_rows(factory: BookingFactory) -> Iterator[tuple]:
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        if not f.has_payment:
            continue
        authorized = (
            f.created_at + timedelta(seconds=12)
            if f.payment_state not in ("DECLINED", "ERROR")
            else None
        )
        captured = f.confirmed_at if f.payment_state in ("CAPTURED", "REFUNDED") else None
        refunded = f.cancelled_at if f.payment_state == "REFUNDED" else None
        yield (
            str(uuid_for(NS_PAYMENT, index)),
            f.id,
            "mockpay",
            f"ch_{uuid_for(NS_PAYMENT, index).hex[:24]}",
            f"seed-{index}",
            f.total_cents,
            "GBP",
            f.payment_state,
            f.card_last4,
            f.card_brand,
            f.decline_code,
            catalog.DECLINE_MESSAGES.get(f.decline_code) if f.decline_code else None,
            False,
            authorized,
            captured,
            refunded,
            f.total_cents if f.payment_state == "REFUNDED" else None,
            f.created_at,
            refunded or captured or authorized or f.created_at,
        )


PAYMENT_COLUMNS = (
    "id", "booking_id", "provider", "provider_reference", "idempotency_key",
    "amount_cents", "currency", "state", "card_last4", "card_brand",
    "decline_code", "failure_message", "requires_3ds", "authorized_at",
    "captured_at", "refunded_at", "refunded_amount_cents",
    "created_at", "updated_at",
)


def payment_event_rows(factory: BookingFactory) -> Iterator[tuple]:
    """The append-only ledger: a creation event plus the resolving event."""
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        if not f.has_payment:
            continue
        payment_id = str(uuid_for(NS_PAYMENT, index))
        yield (
            payment_id, "payment.created", None, "CREATED",
            Jsonb({"seeded": True}), None, f.created_at,
        )
        yield (
            payment_id,
            f"payment.{f.payment_state.lower()}",
            "AUTHORIZING",
            f.payment_state,
            Jsonb(
                {"decline_code": f.decline_code}
                if f.decline_code
                else {"provider": "mockpay"}
            ),
            None,
            f.created_at + timedelta(seconds=13),
        )


PAYMENT_EVENT_COLUMNS = (
    "payment_id", "event_type", "from_state", "to_state", "provider_payload",
    "trace_id", "created_at",
)


POINTS_PER_TIER = {
    "standard": 1.0, "silver": 1.25, "gold": 1.5, "platinum": 2.0,
}


def loyalty_transaction_rows(factory: BookingFactory) -> Iterator[tuple]:
    """One accrual per confirmed booking that belongs to a signed-in member."""
    balances: dict[str, int] = {}
    for index in range(factory.config.volumes.bookings):
        f = factory.facts(index)
        if f.user_id is None or f.state not in STATES_WITH_PNR:
            continue
        points = int(f.total_cents / 100 * POINTS_PER_TIER[f.user_tier])
        balance = balances.get(f.user_id, 0) + points
        balances[f.user_id] = balance
        yield (
            f.user_id, f.id, "accrual", points, balance,
            f"Points for booking {f.pnr}", f.confirmed_at or f.created_at,
        )


LOYALTY_TRANSACTION_COLUMNS = (
    "user_id", "booking_id", "transaction_type", "points", "balance_after",
    "description", "created_at",
)
