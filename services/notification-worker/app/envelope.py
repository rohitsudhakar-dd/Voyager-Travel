"""The shared Kafka envelope (05-FUNCTIONALITY.md § 6.1).

Datadog trace context travels in the message *headers*, injected by the tracer
once Data Streams Monitoring is on in Phase 8. The `traceId` field here is for
human debugging and log correlation only -- do not use it to reconstruct traces.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.templates import MalformedMessage


@dataclass(frozen=True)
class Envelope:
    event_id: str
    event_type: str
    event_version: int
    occurred_at: str
    producer: str
    trace_id: str | None
    correlation_id: str | None
    payload: dict[str, Any]


def parse(raw: bytes | str | None) -> Envelope:
    if raw is None:
        raise MalformedMessage("Message has no value.")

    try:
        decoded = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise MalformedMessage("Message is not valid JSON.") from exc

    if not isinstance(decoded, dict):
        raise MalformedMessage("Message is not an object.")

    event_type = decoded.get("eventType")
    if not isinstance(event_type, str) or not event_type:
        raise MalformedMessage("Message has no eventType.")

    payload = decoded.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise MalformedMessage("Message payload is not an object.")

    return Envelope(
        event_id=str(decoded.get("eventId") or ""),
        event_type=event_type,
        event_version=int(decoded.get("eventVersion") or 1),
        occurred_at=str(
            decoded.get("occurredAt")
            or datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        ),
        producer=str(decoded.get("producer") or "unknown"),
        trace_id=_optional_str(decoded.get("traceId")),
        correlation_id=_optional_str(decoded.get("correlationId")),
        payload=payload,
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
