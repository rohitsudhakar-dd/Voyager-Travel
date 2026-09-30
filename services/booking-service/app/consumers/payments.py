"""Consumer of `voyager.payments.events` on `voyager-booking-payments-v1`.

This is what drives PENDING_PAYMENT to CONFIRMED or FAILED. It is a consumer
rather than a synchronous call on purpose: the authorization result arrives
from the provider's webhook, which is the same shape real OTAs live with.
"""

from __future__ import annotations

import asyncio
import json

import structlog
from aiokafka import AIOKafkaConsumer

from app import db, kafka_context, metrics, tracing
from app.domain.states import BookingState, Trigger
from app.errors import InvalidBookingTransitionError
from app.kafka import envelope
from app.repo import bookings as booking_repo
from app.repo import holds as hold_repo
from app.state import runtime

CONSUMER_GROUP = "voyager-booking-payments-v1"

log = structlog.get_logger()


async def run(brokers: str, stop: asyncio.Event) -> None:
    consumer = AIOKafkaConsumer(
        envelope.TOPIC_PAYMENTS,
        bootstrap_servers=brokers,
        group_id=CONSUMER_GROUP,
        # Commit after the handler, not on a timer: a rebalance mid-message
        # should replay it, not skip it.
        enable_auto_commit=False,
        auto_offset_reset="earliest",
        value_deserializer=lambda raw: json.loads(raw.decode()),
    )
    await consumer.start()
    log.info("Consumer started", kafka={"group": CONSUMER_GROUP})

    try:
        while not stop.is_set():
            batch = await consumer.getmany(timeout_ms=1000, max_records=50)
            for _partition, messages in batch.items():
                for message in messages:
                    kafka_context.activate_consumed(message)
                    await _handle(message.value)
            if batch:
                await consumer.commit()

            # A paused group is a stopped consumer, not a discarding one, so
            # the lag on the group genuinely grows.
            while runtime.chaos.get_value("kafka_consumer_pause", "") == CONSUMER_GROUP:
                if stop.is_set():
                    break
                await runtime.chaos.refresh(force=True)
                await asyncio.sleep(1)
    finally:
        await consumer.stop()
        log.info("Consumer stopped", kafka={"group": CONSUMER_GROUP})


async def _handle(event: dict) -> None:
    delay_ms = runtime.chaos.get_value("kafka_slow_consumer_ms", 0)
    if delay_ms > 0:
        await asyncio.sleep(delay_ms / 1000)

    event_type = event.get("eventType")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        log.warning(
            "Event skipped",
            error={"kind": "MalformedEventError", "message": "payload is not an object"},
            kafka={"topic": envelope.TOPIC_PAYMENTS, "event_type": event_type},
        )
        return

    booking_id = payload.get("bookingId")
    if not booking_id:
        return

    correlation_id = event.get("correlationId", "")
    try:
        if event_type == "payment.authorized":
            await confirm(booking_id, correlation_id=correlation_id)
        elif event_type in ("payment.declined", "payment.failed"):
            await fail(booking_id, payload, correlation_id=correlation_id)
        elif event_type == "payment.refunded":
            await refund(booking_id, correlation_id=correlation_id)
    except InvalidBookingTransitionError as exc:
        # Kafka redelivers, so the same authorization can arrive twice. A
        # booking that is already CONFIRMED is the desired end state, not a
        # failure -- log it and move the offset on.
        log.info(
            "Event had no effect",
            booking={"id": booking_id},
            kafka={"event_type": event_type},
            reason=exc.message,
        )


async def confirm(booking_id: str, *, correlation_id: str = "") -> dict:
    """PENDING_PAYMENT -> CONFIRMED: issue the PNR and consume the hold."""
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        booking = await booking_repo.transition(
            session, booking=booking, trigger=Trigger.PAYMENT_AUTHORIZED
        )
        pnr = await booking_repo.issue_pnr(session, booking_id)
        booking["pnr"] = pnr
        consumed = await hold_repo.consume(session, booking_id)
        itinerary = {
            "booking": booking,
            "items": await booking_repo.items_for(session, booking_id),
            "passengers": await booking_repo.passengers_for(session, booking_id),
        }

    # The PNR is only allocated after `booking.state_transition` has closed, so
    # it is tagged from here. On the POST /confirm path that reaches the
    # request span; consumed from Kafka there is no span left to carry it,
    # because ddtrace 2.14 has no aiokafka integration to open one.
    tracing.tag_booking(booking)
    metrics.booking_confirmed(booking)

    if runtime.chaos.is_enabled("booking_memory_leak"):
        # Retained forever, keyed per booking, reachable from a module-level
        # object for the life of the process. The heap climb is genuine, so
        # the profiler attributes it here rather than to a synthetic metric.
        runtime.leaked_itineraries[booking_id] = itinerary

    await runtime.producer.send(
        envelope.TOPIC_BOOKINGS,
        booking_id,
        "booking.confirmed",
        envelope.booking_payload(booking),
        correlation_id=correlation_id,
    )
    await runtime.producer.send(
        envelope.TOPIC_NOTIFICATIONS,
        booking_id,
        "notification.requested",
        {
            "template": "booking_confirmed",
            "recipient": booking["contact_email"],
            # Alongside `variables` rather than inside it: variables is the
            # template's data, and a template that never renders a booking id
            # should not be handed one. notification-worker has no database,
            # so these two are the only way its spans can carry booking.id
            # and product.type.
            "bookingId": booking_id,
            "productType": booking["product_type"],
            "variables": {
                "pnr": pnr,
                "totalCents": booking["total_cents"],
                "currency": booking["currency"],
            },
        },
        correlation_id=correlation_id,
    )
    log.info(
        "Booking confirmed",
        booking={"id": booking_id, "pnr": pnr, "state": booking["state"]},
        holds_consumed=consumed,
    )
    return booking


async def fail(booking_id: str, payload: dict, *, correlation_id: str = "") -> dict:
    """PENDING_PAYMENT -> FAILED. The hold survives, so the traveller can
    retry with another card while their seat is still theirs."""
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        booking = await booking_repo.transition(
            session, booking=booking, trigger=Trigger.PAYMENT_FAILED
        )

    await runtime.producer.send(
        envelope.TOPIC_NOTIFICATIONS,
        booking_id,
        "notification.requested",
        {
            "template": "payment_failed",
            "recipient": booking["contact_email"],
            # Alongside `variables` rather than inside it: variables is the
            # template's data, and a template that never renders a booking id
            # should not be handed one. notification-worker has no database,
            # so these two are the only way its spans can carry booking.id
            # and product.type.
            "bookingId": booking_id,
            "productType": booking["product_type"],
            "variables": {
                "declineCode": payload.get("declineCode"),
                "holdExpiresAt": booking.get("hold_expires_at"),
            },
        },
        correlation_id=correlation_id,
    )
    # `reason` is payment-service's own word for what happened -- "declined" or
    # "provider_error" -- and it is used verbatim. A decline code here instead
    # would answer the same question payment-service's own metric already
    # answers, and this one is about the booking, not the card.
    metrics.booking_failed(
        product=booking["product_type"],
        failure_reason=payload.get("reason") or "unknown",
    )
    log.warning(
        "Booking payment failed",
        booking={"id": booking_id, "state": booking["state"]},
        payment={"decline_code": payload.get("declineCode")},
    )
    return booking


async def refund(booking_id: str, *, correlation_id: str = "") -> dict:
    async with db.transaction() as session:
        booking = await booking_repo.get(session, booking_id, for_update=True)
        booking = await booking_repo.transition(
            session, booking=booking, trigger=Trigger.REFUND_COMPLETED
        )

    log.info(
        "Booking refunded", booking={"id": booking_id, "state": booking["state"]}
    )
    return booking


__all__ = ["run", "confirm", "fail", "refund", "CONSUMER_GROUP", "BookingState"]
