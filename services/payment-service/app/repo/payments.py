"""The payments table and its append-only event ledger.

`payment_events` is never updated or deleted. The row history is the answer to
"what did we tell the provider, and what did it tell us", and a mutable audit
trail answers nothing.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.states import PaymentState, Trigger, next_state
from app.errors import PaymentNotFoundError

_COLUMNS = """
    id, booking_id, provider, provider_reference, idempotency_key,
    amount_cents, currency, state, card_last4, card_brand,
    decline_code, failure_message, requires_3ds,
    authorized_at, captured_at, refunded_at, refunded_amount_cents,
    created_at, updated_at
"""


def _row(row: Any) -> dict:
    payment = dict(row._mapping)
    for key in ("id", "booking_id"):
        if payment.get(key) is not None:
            payment[key] = str(payment[key])
    for key in (
        "authorized_at",
        "captured_at",
        "refunded_at",
        "created_at",
        "updated_at",
    ):
        value = payment.get(key)
        if isinstance(value, datetime):
            payment[key] = value.astimezone(timezone.utc).isoformat()
    return payment


async def create(
    db: AsyncSession,
    *,
    booking_id: str,
    idempotency_key: str,
    amount_cents: int,
    currency: str,
    card_last4: str,
    card_brand: str,
) -> dict:
    """Insert a CREATED payment.

    Only the last four digits and the brand are stored. The full number is
    never written anywhere -- not to a column, not to a log, not to the
    provider payload we keep.
    """
    row = (
        await db.execute(
            text(
                f"""
                INSERT INTO payments (
                    id, booking_id, provider, idempotency_key, amount_cents,
                    currency, state, card_last4, card_brand, created_at, updated_at
                ) VALUES (
                    :id, :booking_id, 'mockpay', :idempotency_key, :amount_cents,
                    :currency, 'CREATED', :card_last4, :card_brand, now(), now()
                )
                RETURNING {_COLUMNS}
                """
            ),
            {
                "id": uuid4(),
                "booking_id": UUID(booking_id),
                "idempotency_key": idempotency_key,
                "amount_cents": amount_cents,
                "currency": currency,
                "card_last4": card_last4,
                "card_brand": card_brand,
            },
        )
    ).one()
    return _row(row)


async def get(db: AsyncSession, payment_id: str, *, for_update: bool = False) -> dict:
    try:
        key = UUID(payment_id)
    except ValueError:
        raise PaymentNotFoundError(details={"paymentId": payment_id}) from None

    row = (
        await db.execute(
            text(
                f"SELECT {_COLUMNS} FROM payments WHERE id = :id"
                + (" FOR UPDATE" if for_update else "")
            ),
            {"id": key},
        )
    ).one_or_none()
    if row is None:
        raise PaymentNotFoundError(details={"paymentId": payment_id})
    return _row(row)


async def get_by_idempotency_key(db: AsyncSession, key: str) -> dict | None:
    row = (
        await db.execute(
            text(f"SELECT {_COLUMNS} FROM payments WHERE idempotency_key = :key"),
            {"key": key},
        )
    ).one_or_none()
    return _row(row) if row else None


async def get_by_provider_reference(db: AsyncSession, reference: str) -> dict | None:
    row = (
        await db.execute(
            text(f"SELECT {_COLUMNS} FROM payments WHERE provider_reference = :ref"),
            {"ref": reference},
        )
    ).one_or_none()
    return _row(row) if row else None


async def transition(
    db: AsyncSession,
    *,
    payment: dict,
    trigger: Trigger,
    provider_reference: str | None = None,
    decline_code: str | None = None,
    failure_message: str | None = None,
    refunded_amount_cents: int | None = None,
    provider_payload: dict | None = None,
    trace_id: str = "",
) -> dict:
    """Move the payment and append a ledger row, in one transaction.

    The two are inseparable: a state change with no ledger entry is a state
    change nobody can explain afterwards.
    """
    current = PaymentState(payment["state"])
    target = next_state(current, trigger)

    assignments = ["state = :state", "updated_at = now()"]
    params: dict[str, Any] = {"id": UUID(payment["id"]), "state": str(target)}

    if provider_reference is not None:
        assignments.append("provider_reference = :provider_reference")
        params["provider_reference"] = provider_reference
    if decline_code is not None:
        assignments.append("decline_code = :decline_code")
        params["decline_code"] = decline_code
    if failure_message is not None:
        assignments.append("failure_message = :failure_message")
        params["failure_message"] = failure_message
    if refunded_amount_cents is not None:
        assignments.append("refunded_amount_cents = :refunded_amount_cents")
        params["refunded_amount_cents"] = refunded_amount_cents

    if target is PaymentState.AUTHORIZED:
        assignments.append("authorized_at = now()")
    if target is PaymentState.REQUIRES_3DS:
        assignments.append("requires_3ds = true")
    if target is PaymentState.CAPTURED:
        assignments.append("captured_at = now()")
    if target in (PaymentState.REFUNDED, PaymentState.PARTIALLY_REFUNDED):
        assignments.append("refunded_at = now()")

    row = (
        await db.execute(
            text(
                f"UPDATE payments SET {', '.join(assignments)} "
                f"WHERE id = :id RETURNING {_COLUMNS}"
            ),
            params,
        )
    ).one()

    await append_event(
        db,
        payment_id=payment["id"],
        event_type=str(trigger),
        from_state=str(current),
        to_state=str(target),
        provider_payload=provider_payload,
        trace_id=trace_id,
    )
    return _row(row)


async def append_event(
    db: AsyncSession,
    *,
    payment_id: str,
    event_type: str,
    from_state: str,
    to_state: str,
    provider_payload: dict | None = None,
    trace_id: str = "",
) -> None:
    await db.execute(
        text(
            """
            INSERT INTO payment_events (
                payment_id, event_type, from_state, to_state,
                provider_payload, trace_id, created_at
            ) VALUES (
                :payment_id, :event_type, :from_state, :to_state,
                CAST(:provider_payload AS JSONB), :trace_id, now()
            )
            """
        ),
        {
            "payment_id": UUID(payment_id),
            "event_type": event_type,
            "from_state": from_state,
            "to_state": to_state,
            "provider_payload": json.dumps(provider_payload or {}),
            "trace_id": trace_id,
        },
    )


async def events_for(db: AsyncSession, payment_id: str) -> list[dict]:
    rows = (
        await db.execute(
            text(
                """
                SELECT event_type, from_state, to_state, created_at
                FROM payment_events WHERE payment_id = :id ORDER BY created_at, id
                """
            ),
            {"id": UUID(payment_id)},
        )
    ).all()
    return [
        {
            "eventType": row.event_type,
            "from": row.from_state,
            "to": row.to_state,
            "at": row.created_at.astimezone(timezone.utc).isoformat(),
        }
        for row in rows
    ]
