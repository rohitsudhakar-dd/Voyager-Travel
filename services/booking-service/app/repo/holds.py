"""Inventory holds (05-FUNCTIONALITY.md § 4.3).

Holds are taken under a Postgres advisory lock keyed on the resource, so two
travellers reaching for the last seat serialise rather than both getting it.
`hold_lock_contention` widens that critical section.
"""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import InventoryUnavailableError

# How long the widened critical section holds the lock. Long enough to queue
# visibly behind, short enough that a demo does not stall.
CONTENTION_HOLD_SECONDS = 0.75

SWEEP_BATCH_SIZE = 500


async def _acquire_advisory_lock(
    db: AsyncSession, resource_type: str, resource_id: int
) -> None:
    """Serialise on one resource for the rest of this transaction.

    `pg_advisory_xact_lock` releases at commit or rollback, so no code path
    can leak the lock by forgetting to release it.
    """
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
        {"key": f"{resource_type}{resource_id}"},
    )


async def acquire(
    db: AsyncSession,
    *,
    booking_id: str,
    resource_type: str,
    resource_id: int,
    quantity: int,
    expires_at,
    widen_critical_section: bool = False,
) -> dict:
    await _acquire_advisory_lock(db, resource_type, resource_id)

    if widen_critical_section:
        # The lock is already held, so every other hold on this seat waits
        # here. That is the contention `hold_lock_contention` exists to show.
        await asyncio.sleep(CONTENTION_HOLD_SECONDS)

    table, column = _resource_table(resource_type)
    available = (
        await db.execute(
            text(f"SELECT {column} FROM {table} WHERE id = :id"),
            {"id": resource_id},
        )
    ).scalar_one_or_none()

    if available is None:
        raise InventoryUnavailableError(
            "That flight or room no longer exists.",
            details={"resourceType": resource_type, "resourceId": resource_id},
        )
    if available < quantity:
        raise InventoryUnavailableError(
            details={
                "resourceType": resource_type,
                "resourceId": resource_id,
                "requested": quantity,
                "available": available,
            }
        )

    # Inventory moves at hold time, not at confirmation. Anything else sells
    # the same seat twice while the traveller is entering their card details.
    await db.execute(
        text(f"UPDATE {table} SET {column} = {column} - :quantity WHERE id = :id"),
        {"id": resource_id, "quantity": quantity},
    )

    hold_id = uuid4()
    await db.execute(
        text(
            """
            INSERT INTO inventory_holds (
                id, booking_id, resource_type, resource_id, quantity,
                state, expires_at, created_at
            ) VALUES (
                :id, :booking_id, :resource_type, :resource_id, :quantity,
                'active', :expires_at, now()
            )
            """
        ),
        {
            "id": hold_id,
            "booking_id": UUID(booking_id),
            "resource_type": resource_type,
            "resource_id": resource_id,
            "quantity": quantity,
            "expires_at": expires_at,
        },
    )
    return {
        "id": str(hold_id),
        "resourceType": resource_type,
        "resourceId": resource_id,
        "quantity": quantity,
    }


async def consume(db: AsyncSession, booking_id: str) -> int:
    """Mark a booking's holds as consumed on confirmation.

    The seats were already decremented at hold time, so this only closes the
    hold records out.
    """
    result = await db.execute(
        text(
            """
            UPDATE inventory_holds SET state = 'consumed', released_at = now()
            WHERE booking_id = :booking_id AND state = 'active'
            """
        ),
        {"booking_id": UUID(booking_id)},
    )
    return result.rowcount or 0


async def release(db: AsyncSession, booking_id: str, *, state: str) -> int:
    """Return inventory for one booking. `state` is 'released' or 'expired'."""
    rows = (
        await db.execute(
            text(
                """
                UPDATE inventory_holds SET state = :state, released_at = now()
                WHERE booking_id = :booking_id AND state = 'active'
                RETURNING resource_type, resource_id, quantity
                """
            ),
            {"booking_id": UUID(booking_id), "state": state},
        )
    ).all()

    for row in rows:
        table, column = _resource_table(row.resource_type)
        await db.execute(
            text(f"UPDATE {table} SET {column} = {column} + :quantity WHERE id = :id"),
            {"id": row.resource_id, "quantity": row.quantity},
        )
    return len(rows)


async def expired_booking_ids(db: AsyncSession) -> list[str]:
    """Bookings whose hold has run out, oldest first.

    `FOR UPDATE SKIP LOCKED` means a second sweeper instance picks up
    different rows instead of blocking on the first one's.
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT id FROM bookings
                WHERE state IN ('HELD','PENDING_PAYMENT')
                  AND hold_expires_at IS NOT NULL
                  AND hold_expires_at < now()
                ORDER BY hold_expires_at
                LIMIT :limit
                FOR UPDATE SKIP LOCKED
                """
            ),
            {"limit": SWEEP_BATCH_SIZE},
        )
    ).all()
    return [str(row.id) for row in rows]


def _resource_table(resource_type: str) -> tuple[str, str]:
    if resource_type == "flight_seat":
        return "flights", "seats_available"
    if resource_type == "hotel_room":
        return "rate_plans", "rooms_available"
    raise InventoryUnavailableError(
        "Unknown resource type.", details={"resourceType": resource_type}
    )
