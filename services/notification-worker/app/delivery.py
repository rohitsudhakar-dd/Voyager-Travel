"""Attempt, retry, and dead-letter decisions for one message.

Kept separate from Kafka so the rules are testable without a broker. This module
*decides*; the consumer acts on the decision and is the only thing that touches
a topic.

Two failure shapes, and the difference is the whole design:
 - permanent -- the provider rejected the message with a 4xx, or the message
   cannot be turned into an email at all. Retrying cannot help.
 - transient -- the provider is unreachable or returned a 5xx. Worth retrying,
   with backoff, up to `max_attempts` and then the DLQ.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal

from app.chaos import Chaos
from app.config import Settings
from app.email_client import EmailClient
from app.envelope import Envelope, parse
from app.errors import DependencyError
from app.templates import (
    MalformedMessage,
    NoRecipient,
    NotRoutable,
    Notification,
    notification_for,
)

OutcomeKind = Literal["sent", "dropped", "dead_lettered"]


@dataclass(frozen=True)
class Outcome:
    kind: OutcomeKind
    attempts: int
    event_type: str | None = None
    template: str | None = None
    message_id: str | None = None
    failure_reason: str | None = None
    correlation_id: str | None = None


class Deliverer:
    def __init__(self, settings: Settings, email: EmailClient, chaos: Chaos) -> None:
        self._settings = settings
        self._email = email
        self._chaos = chaos

    async def deliver(self, raw: bytes | None) -> Outcome:
        """Try to send one message, returning what happened.

        Parsing is inside the retry loop on purpose: the exit criterion for this
        phase is that a malformed message reaches the DLQ after exactly three
        attempts, and a loop that special-cases parse failures would reach it
        after one.
        """
        attempts = 0
        event_type: str | None = None
        correlation_id: str | None = None
        template: str | None = None
        failure_reason = "unknown"

        while attempts < self._settings.max_attempts:
            attempts += 1
            try:
                envelope: Envelope = parse(raw)
                event_type = envelope.event_type
                correlation_id = envelope.correlation_id

                notification: Notification = notification_for(
                    envelope.event_type, envelope.payload
                )
                template = notification.template

                # `service_error_rate` is the generic per-service knob. For a
                # worker there is no request to fail, so it fails the delivery
                # instead -- transiently, so the retry path is what the audience
                # sees rather than instant loss.
                if self._chaos.maybe_service_fail(self._settings.dd_service):
                    raise DependencyError(
                        "Delivery failed.", injected_by="service_error_rate"
                    )

                result = await self._email.send(notification)
                if result.accepted:
                    return Outcome(
                        kind="sent",
                        attempts=attempts,
                        event_type=event_type,
                        template=template,
                        message_id=result.message_id,
                        correlation_id=correlation_id,
                    )

                # A 4xx is the provider saying this message will never be
                # accepted. mock-email returns 422 under `email_failure_rate`,
                # which is exactly how S5 fills the DLQ on demand.
                return Outcome(
                    kind="dead_lettered",
                    attempts=attempts,
                    event_type=event_type,
                    template=template,
                    failure_reason=f"rejected_by_provider: {result.reason}",
                    correlation_id=correlation_id,
                )

            except NoRecipient as exc:
                return Outcome(
                    kind="dropped",
                    attempts=attempts,
                    event_type=event_type,
                    failure_reason=f"no_recipient: {exc}",
                    correlation_id=correlation_id,
                )
            except NotRoutable:
                return Outcome(
                    kind="dropped",
                    attempts=attempts,
                    event_type=event_type,
                    correlation_id=correlation_id,
                )
            except MalformedMessage as exc:
                failure_reason = f"malformed_message: {exc}"
            except DependencyError as exc:
                failure_reason = f"provider_unavailable: {exc.message}"

            if attempts < self._settings.max_attempts:
                await asyncio.sleep(
                    self._settings.retry_backoff_ms * (2 ** (attempts - 1)) / 1000
                )

        return Outcome(
            kind="dead_lettered",
            attempts=attempts,
            event_type=event_type,
            template=template,
            failure_reason=failure_reason,
            correlation_id=correlation_id,
        )
