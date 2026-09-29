"""The event envelope every topic carries (05-FUNCTIONALITY.md § 6.1).

`traceId` in the body is for human debugging and log correlation only. The
real trace context travels in Kafka headers, written by the tracer once Data
Streams Monitoring is enabled in Phase 8 -- do not reconstruct traces from
this field.
"""

from __future__ import annotations

import os
import secrets
import time
from datetime import datetime, timezone
from typing import Any

TOPIC_BOOKINGS = "voyager.bookings.events"
TOPIC_PAYMENTS = "voyager.payments.events"
TOPIC_NOTIFICATIONS = "voyager.notifications.outbound"
TOPIC_NOTIFICATIONS_DLQ = "voyager.notifications.dlq"
TOPIC_LOYALTY = "voyager.loyalty.accruals"
TOPIC_SEARCH_ANALYTICS = "voyager.search.analytics"

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def event_id() -> str:
    """A ULID, so event ids sort by creation time without a counter."""
    milliseconds = int(time.time() * 1000)
    timestamp = "".join(
        _CROCKFORD[(milliseconds >> shift) & 0x1F] for shift in range(45, -1, -5)
    )
    randomness = "".join(secrets.choice(_CROCKFORD) for _ in range(16))
    return f"evt_{timestamp}{randomness}"


def build(
    event_type: str,
    payload: dict[str, Any],
    *,
    correlation_id: str = "",
    trace_id: str = "",
    version: int = 1,
) -> dict[str, Any]:
    return {
        "eventId": event_id(),
        "eventType": event_type,
        "eventVersion": version,
        "occurredAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "producer": os.getenv("DD_SERVICE", "voyager-booking"),
        "traceId": trace_id,
        "correlationId": correlation_id,
        "payload": payload,
    }
