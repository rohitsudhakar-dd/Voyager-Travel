"""DogStatsD business metrics for booking-service (05-FUNCTIONALITY.md § 14).

One file, like the tracer and the logger, so the whole DogStatsD integration is
readable in one sitting. Every metric name and every tag key in the service is
spelled once, here: a name spelled two ways is two metrics in Datadog and
neither of them is complete.

Two rules from § 14 shape everything below.

*Cardinality.* A booking id, a user id, a PNR or a price in a metric tag is a
cost incident -- each distinct value is a billable time series, forever. They go
on spans and in logs, where they belong. Nothing here takes an identifier.

*Global tags.* `env`, `service` and `version` are appended by the client from
DD_ENV, DD_SERVICE and DD_VERSION, so no call site passes them; doing so would
send each one twice.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from datadog.dogstatsd import DogStatsd
from sqlalchemy import text

from app.config import get_settings

BOOKING_CREATED = "voyager.booking.created"
BOOKING_CONFIRMED = "voyager.booking.confirmed"
BOOKING_FAILED = "voyager.booking.failed"
BOOKING_REVENUE_CENTS = "voyager.booking.revenue_cents"
BOOKING_TIME_TO_CONFIRM_MS = "voyager.booking.time_to_confirm_ms"
HOLD_CREATED = "voyager.hold.created"
HOLD_EXPIRED = "voyager.hold.expired"
HOLD_LOCK_WAIT_MS = "voyager.hold.lock_wait_ms"

# § 14 does not enumerate the values of `tier`, and the schema's own list --
# standard, silver, gold, platinum -- has no entry for a traveller who is not
# signed in. Guests are a large and genuinely different population, so they get
# their own value rather than being folded into `standard`, which would make the
# member conversion rate look worse than it is.
GUEST_TIER = "guest"

# A booking created before this metric existed has no tier recorded against it.
# Named rather than left blank so "we do not know" and "standard" stay apart.
UNKNOWN_TIER = "unknown"

_settings = get_settings()
_statsd = DogStatsd(
    host=_settings.dd_dogstatsd_host,
    port=_settings.dd_dogstatsd_port,
    # Buffering trades a syscall per metric for a delay before the Agent sees
    # anything. Off, because a demo toggles a flag and expects the graph to move
    # within seconds, and a handful of extra UDP sends is not this service's
    # bottleneck.
    disable_buffering=True,
)


# ------------------------------------------------------------------ bookings --


def booking_created(*, product: str, tier: str) -> None:
    _statsd.increment(BOOKING_CREATED, tags=[f"product:{product}", f"tier:{tier}"])


def booking_confirmed(booking: dict) -> None:
    """The three metrics a confirmation produces, from one booking row.

    Emitted together because they are one event seen three ways, and separating
    them is how a revenue figure ends up counting a different population from
    the conversion count next to it on the dashboard.
    """
    product = booking.get("product_type") or "unknown"
    currency = booking.get("currency") or "unknown"
    tier = tier_of(booking)

    _statsd.increment(
        BOOKING_CONFIRMED,
        tags=[f"product:{product}", f"tier:{tier}", f"currency:{currency}"],
    )
    # The amount is the metric's value, never a tag: § 14 names a raw price as
    # one of the four things that must never be tagged.
    _statsd.distribution(
        BOOKING_REVENUE_CENTS,
        booking.get("total_cents") or 0,
        tags=[f"product:{product}", f"currency:{currency}", f"tier:{tier}"],
    )

    elapsed = _time_to_confirm_ms(booking)
    if elapsed is not None:
        _statsd.distribution(
            BOOKING_TIME_TO_CONFIRM_MS, elapsed, tags=[f"product:{product}"]
        )


def booking_failed(*, product: str, failure_reason: str) -> None:
    _statsd.increment(
        BOOKING_FAILED,
        tags=[f"product:{product}", f"failure_reason:{failure_reason}"],
    )


# --------------------------------------------------------------------- holds --


def hold_created(resource_type: str) -> None:
    _statsd.increment(HOLD_CREATED, tags=[f"resource_type:{resource_type}"])


def hold_expired(resource_type: str) -> None:
    _statsd.increment(HOLD_EXPIRED, tags=[f"resource_type:{resource_type}"])


def hold_lock_wait_ms(milliseconds: float, resource_type: str) -> None:
    _statsd.distribution(
        HOLD_LOCK_WAIT_MS, milliseconds, tags=[f"resource_type:{resource_type}"]
    )


# ---------------------------------------------------------------------- tier --


async def lookup_tier(user_id: str | None) -> str:
    """Read a traveller's tier for the `tier` tag on the booking metrics.

    This is the one query in the service that touches `users`, and it exists
    only for this tag. It is here rather than in `app/repo/` for that reason:
    the booking repository is the service's domain, and a table it does not own
    has no business appearing in it.

    Called once, when the draft is created, and the answer is stored on the
    booking so the confirmation path costs nothing. Tier changes are rare and a
    booking's tier is properly the tier it was bought at, so the snapshot is the
    more correct value as well as the cheaper one.
    """
    if not user_id:
        return GUEST_TIER

    from app import db

    try:
        async with db.session() as session:
            tier = (
                await session.execute(
                    text("SELECT tier FROM users WHERE id = :id"),
                    {"id": UUID(user_id)},
                )
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001 - a tag is never worth failing a booking
        return UNKNOWN_TIER

    return tier or UNKNOWN_TIER


def tier_of(booking: dict) -> str:
    """The tier recorded on a booking when its draft was created."""
    metadata = booking.get("metadata") or {}
    tier = metadata.get("userTier")
    if tier:
        return str(tier)
    return GUEST_TIER if not booking.get("user_id") else UNKNOWN_TIER


def _time_to_confirm_ms(booking: dict) -> float | None:
    """Draft creation to confirmation, in milliseconds.

    Measured from the row rather than from a timer because the two ends happen
    in different processes: the draft is created on an HTTP request and the
    confirmation arrives from Kafka, so nothing in between holds a stopwatch.
    """
    created_at = booking.get("created_at")
    if not created_at:
        return None
    try:
        started = datetime.fromisoformat(str(created_at))
    except ValueError:
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - started).total_seconds() * 1000
