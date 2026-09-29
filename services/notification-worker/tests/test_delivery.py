from __future__ import annotations

import json

import pytest

from app.config import Settings
from app.delivery import Deliverer
from app.email_client import DeliveryResult
from app.errors import DependencyError
from app.templates import Notification

SETTINGS = Settings(max_attempts=3, retry_backoff_ms=0)

# The shape booking-service actually puts on `voyager.notifications.outbound`
# once a payment is captured.
CONFIRMED = {
    "eventId": "evt_01J8",
    "eventType": "notification.requested",
    "eventVersion": 1,
    "occurredAt": "2026-09-29T10:14:22.481Z",
    "producer": "voyager-booking",
    "correlationId": "req_01J8",
    "payload": {
        "template": "booking_confirmed",
        "recipient": "traveller@voyager.demo",
        "variables": {"pnr": "K8M2QR", "totalCents": 41_200, "currency": "GBP"},
    },
}

ACCRUED = {
    "eventId": "evt_01J9",
    "eventType": "points.accrued",
    "eventVersion": 1,
    "occurredAt": "2026-09-29T10:14:23.106Z",
    "producer": "voyager-loyalty",
    "correlationId": "req_01J8",
    "payload": {
        "userId": "c0ffee00-0000-4000-8000-000000000001",
        "pnr": "K8M2QR",
        "points": 412,
        "balanceAfter": 1_412,
        "contactEmail": "traveller@voyager.demo",
    },
}


class StubChaos:
    def __init__(self, fail_service: bool = False) -> None:
        self._fail_service = fail_service

    def maybe_service_fail(self, _service: str) -> bool:
        return self._fail_service

    async def maybe_service_delay(self, _service: str) -> float:
        return 0.0

    def active_flags(self) -> list[str]:
        return []


class StubEmail:
    def __init__(self, *behaviours) -> None:
        self.behaviours = list(behaviours)
        self.sent: list[Notification] = []

    async def send(self, notification: Notification):
        self.sent.append(notification)
        behaviour = (
            self.behaviours.pop(0) if self.behaviours else DeliveryResult(True, 202, "msg_1")
        )
        if isinstance(behaviour, Exception):
            raise behaviour
        return behaviour


def encode(event: dict) -> bytes:
    return json.dumps(event).encode("utf-8")


@pytest.mark.asyncio
async def test_a_deliverable_message_is_sent_on_the_first_attempt():
    email = StubEmail(DeliveryResult(True, 202, "msg_1"))
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(encode(CONFIRMED))

    assert outcome.kind == "sent"
    assert outcome.attempts == 1
    assert outcome.template == "booking_confirmed"
    assert outcome.correlation_id == "req_01J8"
    assert len(email.sent) == 1


@pytest.mark.asyncio
async def test_a_transient_failure_is_retried_and_then_succeeds():
    email = StubEmail(
        DependencyError("The email provider is unreachable."),
        DeliveryResult(True, 202, "msg_2"),
    )
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(encode(CONFIRMED))

    assert outcome.kind == "sent"
    assert outcome.attempts == 2


@pytest.mark.asyncio
async def test_a_malformed_message_reaches_the_dlq_after_exactly_three_attempts():
    email = StubEmail()
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(b'{"eventType":"points.accrued","payload":')

    assert outcome.kind == "dead_lettered"
    assert outcome.attempts == 3
    assert outcome.failure_reason is not None
    assert outcome.failure_reason.startswith("malformed_message")
    assert email.sent == []


@pytest.mark.asyncio
async def test_a_provider_that_never_recovers_reaches_the_dlq_after_three_attempts():
    email = StubEmail(
        DependencyError("The email provider is unreachable."),
        DependencyError("The email provider is unreachable."),
        DependencyError("The email provider is unreachable."),
    )
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(encode(CONFIRMED))

    assert outcome.kind == "dead_lettered"
    assert outcome.attempts == 3
    assert len(email.sent) == 3


@pytest.mark.asyncio
async def test_a_rejected_message_goes_straight_to_the_dlq():
    # mock-email answers 422 under `email_failure_rate`. A rejection is permanent,
    # so retrying it would only delay the DLQ entry.
    email = StubEmail(DeliveryResult(False, 422, reason="Message is malformed."))
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(encode(CONFIRMED))

    assert outcome.kind == "dead_lettered"
    assert outcome.attempts == 1
    assert outcome.failure_reason is not None
    assert outcome.failure_reason.startswith("rejected_by_provider")


@pytest.mark.asyncio
async def test_an_event_with_no_template_is_dropped_without_an_email():
    email = StubEmail()
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(
        encode({**ACCRUED, "eventType": "booking.held", "payload": {"bookingId": "x"}})
    )

    assert outcome.kind == "dropped"
    assert outcome.failure_reason is None
    assert email.sent == []


@pytest.mark.asyncio
async def test_an_event_with_no_recipient_is_dropped_rather_than_dead_lettered():
    # payment-service's `payment.refunded` carries no address today. Filling the
    # DLQ with it would make the DLQ useless as a signal.
    email = StubEmail()
    deliverer = Deliverer(SETTINGS, email, StubChaos())
    payload = {k: v for k, v in ACCRUED["payload"].items() if k != "contactEmail"}

    outcome = await deliverer.deliver(encode({**ACCRUED, "payload": payload}))

    assert outcome.kind == "dropped"
    assert outcome.failure_reason is not None
    assert outcome.failure_reason.startswith("no_recipient")
    assert email.sent == []


@pytest.mark.asyncio
async def test_a_loyalty_event_is_routed_by_its_event_type():
    email = StubEmail()
    deliverer = Deliverer(SETTINGS, email, StubChaos())

    outcome = await deliverer.deliver(encode(ACCRUED))

    assert outcome.kind == "sent"
    assert outcome.template == "loyalty_points_accrued"


@pytest.mark.asyncio
async def test_service_error_rate_degrades_delivery_without_losing_the_message():
    email = StubEmail()
    deliverer = Deliverer(SETTINGS, email, StubChaos(fail_service=True))

    outcome = await deliverer.deliver(encode(CONFIRMED))

    assert outcome.kind == "dead_lettered"
    assert outcome.attempts == 3
    assert email.sent == []
