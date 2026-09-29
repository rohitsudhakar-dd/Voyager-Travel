from __future__ import annotations

import pytest

from app.envelope import parse
from app.templates import (
    MalformedMessage,
    NoRecipient,
    NotRoutable,
    notification_for,
    render_itinerary,
)

CONFIRMED_PAYLOAD = {
    "bookingId": "4f1d9d64-8f7a-4d4f-9c86-3d6b0f9f1f2a",
    "pnr": "K8M2QR",
    "productType": "flight",
    "currency": "GBP",
    "contactEmail": "traveller@voyager.demo",
    "totalCents": 41_200,
    "items": [
        {"description": "LHR to JFK", "totalPriceCents": 35_000},
        {"description": "Checked bag", "totalPriceCents": 2_000},
    ],
    "passengers": [{"firstName": "Ada", "lastName": "Lovelace", "seatAssignment": "14C"}],
}


def test_confirmed_booking_renders_an_itinerary():
    notification = notification_for(
        "notification.requested",
        {"template": "booking_confirmed", **CONFIRMED_PAYLOAD},
    )
    assert notification.template == "booking_confirmed"
    assert notification.recipient == "traveller@voyager.demo"
    assert "K8M2QR" in notification.body
    assert "LHR to JFK" in notification.body
    assert "412.00 GBP" in notification.body


def test_domain_events_that_a_producer_requests_explicitly_are_not_routed_twice():
    # booking-service puts `booking_confirmed` and `booking_cancelled` on the
    # outbound topic itself, so routing the domain events as well would send two.
    for event_type in ("booking.confirmed", "booking.cancelled"):
        with pytest.raises(NotRoutable):
            notification_for(event_type, CONFIRMED_PAYLOAD)


def test_itinerary_survives_a_payload_with_no_line_items():
    body = render_itinerary({"pnr": "K8M2QR", "productType": "hotel"})
    assert "K8M2QR" in body


def test_events_with_no_template_are_not_routable():
    with pytest.raises(NotRoutable):
        notification_for("booking.held", CONFIRMED_PAYLOAD)


def test_missing_recipient_is_not_routable():
    payload = {key: value for key, value in CONFIRMED_PAYLOAD.items() if key != "contactEmail"}
    with pytest.raises(NoRecipient):
        notification_for("booking.expired", payload)


def test_outbound_messages_honour_the_template_they_name():
    notification = notification_for(
        "notification.requested",
        {
            "template": "payment_failed",
            "recipient": "traveller@voyager.demo",
            "variables": {"pnr": "K8M2QR", "declineCode": "insufficient_funds"},
        },
    )
    assert notification.template == "payment_failed"
    assert "insufficient_funds" in notification.body


def test_a_receipt_never_carries_more_than_the_last_four_digits():
    notification = notification_for(
        "notification.requested",
        {
            "template": "payment_receipt",
            "recipient": "traveller@voyager.demo",
            "variables": {
                "pnr": "K8M2QR",
                "amountCents": 41_200,
                "currency": "GBP",
                "cardLast4": "4242",
            },
        },
    )
    assert "412.00 GBP" in notification.body
    assert "4242" in notification.body
    assert "cardNumber" not in notification.body


def test_unknown_template_still_produces_a_sendable_body():
    notification = notification_for(
        "notification.requested",
        {
            "template": "seat_reminder",
            "recipient": "traveller@voyager.demo",
            "variables": {"pnr": "K8M2QR"},
        },
    )
    assert notification.template == "seat_reminder"
    assert "K8M2QR" in notification.body


def test_loyalty_events_are_routed():
    notification = notification_for(
        "points.accrued",
        {
            "userId": "c0ffee00-0000-4000-8000-000000000001",
            "contactEmail": "member@voyager.demo",
            "pnr": "K8M2QR",
            "points": 412,
            "balanceAfter": 1_412,
        },
    )
    assert notification.template == "loyalty_points_accrued"
    assert "412" in notification.body


def test_envelope_rejects_truncated_json():
    with pytest.raises(MalformedMessage):
        parse(b'{"eventType":"points.accrued","payload":')
