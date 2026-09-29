"""Idempotency records (05-FUNCTIONALITY.md §§ 3.2, 15).

The rule has two halves, and both matter:

  same key + same body  -> return the original response, do not charge again
  same key + other body -> 409, because the caller has a bug and charging
                           them would be the wrong way to find out

The request hash is what tells the two apart. It is a hash and not the body
because the body contains a card number.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from ddtrace import tracer
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import DuplicateIdempotencyKeyError


def fingerprint(body: dict[str, Any]) -> str:
    """A stable hash of the request, with the card number reduced to its
    last four digits before hashing so a replay can be recognised without the
    number ever being retained."""
    safe = dict(body)
    card = safe.get("card")
    if isinstance(card, dict):
        number = str(card.get("number", ""))
        safe["card"] = {
            "last4": number[-4:],
            "expiryMonth": card.get("expiryMonth"),
            "expiryYear": card.get("expiryYear"),
        }
    encoded = json.dumps(safe, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


async def find(
    db: AsyncSession, *, key: str, endpoint: str, request_hash: str
) -> dict | None:
    """Return the stored response for a replay, or raise on a key collision."""
    with tracer.trace("payment.idempotency_check"):
        row = (
            await db.execute(
                text(
                    """
                    SELECT endpoint, request_hash, response_status, response_body,
                           expires_at
                    FROM idempotency_records WHERE key = :key
                    """
                ),
                {"key": key},
            )
        ).one_or_none()
        if row is None:
            return None

        if row.expires_at is not None and row.expires_at < datetime.now(timezone.utc):
            await db.execute(
                text("DELETE FROM idempotency_records WHERE key = :key"), {"key": key}
            )
            return None

    # Refused outside the span. A caller reusing a key with a different body is
    # a 409, and § 13.3 keeps that off the error rate -- a span that exits on an
    # exception is marked errored whatever the exception meant.
    if row.endpoint != endpoint or row.request_hash != request_hash:
        raise DuplicateIdempotencyKeyError(
            details={"key": key, "endpoint": row.endpoint},
        )

    body = row.response_body
    return {
        "status": row.response_status,
        "body": json.loads(body) if isinstance(body, str) else body,
    }


async def record(
    db: AsyncSession,
    *,
    key: str,
    endpoint: str,
    request_hash: str,
    status: int,
    body: dict,
    ttl_hours: int,
) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    await db.execute(
        text(
            """
            INSERT INTO idempotency_records (
                key, endpoint, request_hash, response_status, response_body,
                created_at, expires_at
            ) VALUES (
                :key, :endpoint, :request_hash, :status,
                CAST(:body AS JSONB), now(), :expires_at
            )
            ON CONFLICT (key) DO NOTHING
            """
        ),
        {
            "key": key,
            "endpoint": endpoint,
            "request_hash": request_hash,
            "status": status,
            "body": json.dumps(body),
            "expires_at": expires_at,
        },
    )
