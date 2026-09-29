"""The hold-expiry sweeper (05-FUNCTIONALITY.md § 4.3).

Runs every 30 seconds, 500 rows at a time, and hands the inventory back. A
hold that expires silently without returning its seat is how an airline ends
up unable to sell a half-empty flight.
"""

from __future__ import annotations

import asyncio

import structlog

from app import db
from app.domain.states import Trigger
from app.kafka import envelope
from app.repo import bookings as booking_repo
from app.repo import holds as hold_repo
from app.state import runtime

SWEEP_INTERVAL_SECONDS = 30

log = structlog.get_logger()


async def run(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            swept = await sweep_once()
            if swept:
                log.info("Holds swept", expired_count=swept)
        except Exception as exc:  # noqa: BLE001 - a bad sweep must not end the loop
            log.error(
                "Sweep failed",
                error={"kind": type(exc).__name__, "message": str(exc)},
            )

        try:
            await asyncio.wait_for(stop.wait(), timeout=SWEEP_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            continue


async def sweep_once() -> int:
    """Expire every booking whose hold has run out, and release its inventory.

    Each booking is its own transaction: one booking that cannot be expired
    should not hold up the other 499.
    """
    async with db.session() as session:
        async with session.begin():
            booking_ids = await hold_repo.expired_booking_ids(session)

    expired = 0
    for booking_id in booking_ids:
        try:
            async with db.transaction() as session:
                booking = await booking_repo.get(session, booking_id, for_update=True)
                booking = await booking_repo.transition(
                    session, booking=booking, trigger=Trigger.SWEEP
                )
                await hold_repo.release(session, booking_id, state="expired")

            await runtime.producer.send(
                envelope.TOPIC_BOOKINGS,
                booking_id,
                "booking.expired",
                {
                    "bookingId": booking_id,
                    "userId": booking.get("user_id"),
                    "state": booking["state"],
                    "totalCents": booking["total_cents"],
                    "currency": booking["currency"],
                    "contactEmail": booking["contact_email"],
                },
            )
            expired += 1
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Hold not expired",
                booking={"id": booking_id},
                error={"kind": type(exc).__name__, "message": str(exc)},
            )
    return expired
