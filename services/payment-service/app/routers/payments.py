"""The payment surface, per 05-FUNCTIONALITY.md §§ 2.6, 4.2 and 8."""

from __future__ import annotations

from typing import Any, Literal

import httpx
import structlog
from fastapi import APIRouter, Header, Response
from pydantic import BaseModel, Field

from app import clients, db, tracing
from app.config import get_settings
from app.domain.states import PaymentState, Trigger
from app.errors import (
    PaymentProviderError,
    RefundExceedsCaptureError,
    ValidationError,
)
from app.kafka import envelope
from app.middleware import current_request_id
from app.repo import idempotency
from app.repo import payments as payment_repo
from app.state import runtime

router = APIRouter(prefix="/v1/payments", tags=["payments"])
log = structlog.get_logger()

# mock-payments' vocabulary, mapped onto ours. Kept explicit so an unexpected
# provider status fails loudly instead of being treated as an approval.
PROVIDER_STATUS = {
    "authorized": Trigger.APPROVE,
    "captured": Trigger.APPROVE,
    "declined": Trigger.DECLINE,
    "requires_3ds": Trigger.CHALLENGE,
}


class Card(BaseModel):
    number: str
    expiryMonth: int = Field(ge=1, le=12)
    expiryYear: int
    cvc: str
    holderName: str | None = None


class Authorize(BaseModel):
    bookingId: str
    amountCents: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    card: Card
    capture: bool = False


class Capture(BaseModel):
    amountCents: int | None = Field(default=None, gt=0)


class Refund(BaseModel):
    amountCents: int = Field(gt=0)
    reason: str | None = None


class Complete3DS(BaseModel):
    success: bool = True


# --------------------------------------------------------------- authorize --


@router.post("/authorize", status_code=201)
async def authorize(
    body: Authorize,
    response: Response,
    idempotency_key: str = Header(alias="Idempotency-Key"),
) -> dict:
    """Authorize a payment against the booking's total.

    The booking is re-read from booking-service rather than trusted from the
    request, so a client cannot pay £1 for a £900 flight by sending its own
    amount.
    """
    settings = get_settings()
    endpoint = "POST /v1/payments/authorize"
    request_hash = idempotency.fingerprint(body.model_dump())

    # Before the idempotency check, so a replay and a key collision are both
    # findable by the booking they were about.
    tracing.tag_root({"booking.id": body.bookingId})

    async with db.session() as session:
        replay = await idempotency.find(
            session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
        )
    if replay is not None:
        # A replay is a success, not a second charge. The counter that tracks
        # these becomes a metric in Phase 8.
        log.info(
            "Idempotent replay served",
            payment={"idempotency_key": idempotency_key},
            booking={"id": body.bookingId},
        )
        response.status_code = replay["status"]
        response.headers["Idempotent-Replay"] = "true"
        return replay["body"]

    booking = await _fetch_booking(body.bookingId)
    tracing.tag_booking(booking)
    _assert_authorizable(booking, body)

    # booking-service owns the booking's state, so the move to
    # PENDING_PAYMENT is its decision. It happens before the card is touched:
    # a booking we could not move is a booking whose confirmation would later
    # be refused, and charging first would leave money against it.
    await _advance_booking(body.bookingId)

    card_number = body.card.number.replace(" ", "")
    async with db.transaction() as session:
        payment = await payment_repo.create(
            session,
            booking_id=body.bookingId,
            idempotency_key=idempotency_key,
            amount_cents=booking["totalCents"],
            currency=booking["currency"],
            card_last4=card_number[-4:],
            card_brand=_brand_of(card_number),
        )
        payment = await payment_repo.transition(
            session, payment=payment, trigger=Trigger.SUBMIT
        )

    try:
        provider = await clients.charge(
            amount_cents=booking["totalCents"],
            currency=booking["currency"],
            card={
                "number": card_number,
                "exp_month": body.card.expiryMonth,
                "exp_year": body.card.expiryYear,
                "cvc": body.card.cvc,
                "holder_name": body.card.holderName,
            },
            idempotency_key=idempotency_key,
            booking_id=body.bookingId,
        )
    except PaymentProviderError as exc:
        payment = await _record_provider_error(payment, exc)
        await _publish_failure(payment, reason="provider_error")
        raise

    payment = await _apply_provider_result(payment, provider)
    body_out = _public(payment)

    async with db.transaction() as session:
        await idempotency.record(
            session,
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            status=201,
            body=body_out,
            ttl_hours=settings.idempotency_ttl_hours,
        )

    await _publish_result(payment, booking)
    return body_out


# ----------------------------------------------------------------- capture --


@router.post("/{payment_id}/capture")
async def capture(payment_id: str, body: Capture) -> dict:
    async with db.session() as session:
        payment = await payment_repo.get(session, payment_id)
    tracing.tag_payment(payment)

    provider = await clients.capture(payment["provider_reference"], body.amountCents)

    async with db.transaction() as session:
        payment = await payment_repo.get(session, payment_id, for_update=True)
        payment = await payment_repo.transition(
            session,
            payment=payment,
            trigger=Trigger.CAPTURE,
            provider_payload=provider,
        )

    await runtime.producer.send(
        envelope.TOPIC_PAYMENTS,
        payment["booking_id"],
        "payment.captured",
        _event_payload(payment),
        correlation_id=current_request_id(),
    )
    log.info("Payment captured", payment=_log_fields(payment))
    return _public(payment)


# ------------------------------------------------------------------ refund --


@router.post("/{payment_id}/refund")
async def refund(payment_id: str, body: Refund) -> dict:
    async with db.session() as session:
        payment = await payment_repo.get(session, payment_id)
    tracing.tag_payment(payment)

    # § 15: refunds are capped at what was actually captured. Anything else
    # is a path to paying a customer money they never gave us.
    already = payment.get("refunded_amount_cents") or 0
    remaining = payment["amount_cents"] - already
    if body.amountCents > remaining:
        raise RefundExceedsCaptureError(
            details={
                "requestedCents": body.amountCents,
                "refundableCents": remaining,
            }
        )

    provider = await clients.refund(payment["provider_reference"], body.amountCents)
    total_refunded = already + body.amountCents
    full = total_refunded >= payment["amount_cents"]

    async with db.transaction() as session:
        payment = await payment_repo.get(session, payment_id, for_update=True)
        payment = await payment_repo.transition(
            session,
            payment=payment,
            trigger=Trigger.REFUND if full else Trigger.REFUND_PARTIAL,
            refunded_amount_cents=total_refunded,
            provider_payload=provider,
        )

    # A refund is the one payment outcome that always ends in an email, and
    # the address lives on the booking. Refunds are rare enough that one read
    # here costs nothing worth saving.
    booking = await _fetch_booking(payment["booking_id"])
    # The only path where this service sees a PNR: it is issued on
    # confirmation, which is long after the card was charged.
    tracing.tag_booking(booking)

    await runtime.producer.send(
        envelope.TOPIC_PAYMENTS,
        payment["booking_id"],
        "payment.refunded",
        {
            **_event_payload(payment, booking),
            "refundedCents": total_refunded,
            "full": full,
        },
        correlation_id=current_request_id(),
    )
    log.info(
        "Payment refunded",
        payment={**_log_fields(payment), "refunded_cents": total_refunded},
    )
    return _public(payment)


# -------------------------------------------------------------------- 3DS --


@router.post("/{payment_id}/3ds/complete")
async def complete_3ds(payment_id: str, body: Complete3DS) -> dict:
    """Finish a 3DS challenge and resubmit the authorization."""
    async with db.session() as session:
        payment = await payment_repo.get(session, payment_id)
    tracing.tag_payment(payment)

    if payment["state"] != PaymentState.REQUIRES_3DS:
        raise ValidationError(
            "This payment is not waiting on a 3DS challenge.",
            details={"state": payment["state"]},
        )

    provider = await clients.complete_3ds(
        payment["provider_reference"], success=body.success
    )

    async with db.transaction() as session:
        payment = await payment_repo.get(session, payment_id, for_update=True)
        payment = await payment_repo.transition(
            session,
            payment=payment,
            trigger=Trigger.RESUBMIT,
            provider_payload=provider,
        )

    payment = await _apply_provider_result(payment, provider)
    booking = await _fetch_booking(payment["booking_id"])
    await _publish_result(payment, booking)
    return _public(payment)


# ---------------------------------------------------------------- webhooks --

# `/v1/webhooks/provider` sits outside the `/v1/payments` prefix, per
# 03-EXECUTION-ORDER.md's Phase 4 endpoint list.
webhooks = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


@webhooks.post("/provider")
async def provider_webhook(payload: dict[str, Any]) -> dict:
    """The asynchronous authorization result from mock-payments.

    It usually says what the synchronous response already said, so this is
    written to be a no-op on a payment that has already moved on -- that is
    what makes an at-least-once webhook safe.
    """
    reference = payload.get("data", {}).get("id") or payload.get("charge_id")
    if not reference:
        return {"status": "ignored", "reason": "no charge reference"}

    async with db.session() as session:
        payment = await payment_repo.get_by_provider_reference(session, reference)
    if payment is None:
        return {"status": "ignored", "reason": "unknown charge"}
    tracing.tag_payment(payment)

    if payment["state"] not in (PaymentState.AUTHORIZING, PaymentState.REQUIRES_3DS):
        log.info(
            "Webhook had no effect",
            payment={**_log_fields(payment), "webhook_type": payload.get("type")},
        )
        return {"status": "noop", "state": payment["state"]}

    payment = await _apply_provider_result(payment, payload.get("data", payload))
    booking = await _fetch_booking(payment["booking_id"])
    await _publish_result(payment, booking)
    return {"status": "applied", "state": payment["state"]}


# ------------------------------------------------------------------- reads --


@router.get("/by-booking/{booking_id}")
async def get_payment_for_booking(booking_id: str) -> dict:
    """The latest payment attempt against a booking, for the BFF.

    A booking with no payment yet is not an error -- that is every booking
    between HELD and the moment the traveller enters a card -- so this answers
    with a null payment rather than a 404.
    """
    tracing.tag_root({"booking.id": booking_id})
    async with db.session() as session:
        payment = await payment_repo.latest_for_booking(session, booking_id)
        if payment is None:
            return {"bookingId": booking_id, "payment": None}
        events = await payment_repo.events_for(session, payment["id"])
    tracing.tag_payment(payment)
    return {"bookingId": booking_id, "payment": {**_public(payment), "events": events}}


@router.get("/methods/{user_id}")
async def get_saved_methods(user_id: str) -> dict:
    """Cards this traveller has paid with before, by last four and brand.

    There is no card vault behind this. It reads the payments ledger, which
    only ever held the last four digits.
    """
    tracing.tag_root({"usr.id": user_id})
    async with db.session() as session:
        methods = await payment_repo.methods_for_user(session, user_id)
    return {"userId": user_id, "methods": methods}


@router.get("/{payment_id}")
async def get_payment(payment_id: str) -> dict:
    async with db.session() as session:
        payment = await payment_repo.get(session, payment_id)
        events = await payment_repo.events_for(session, payment_id)
    tracing.tag_payment(payment)
    return {**_public(payment), "events": events}


# ------------------------------------------------------------------ shared --


async def _apply_provider_result(payment: dict, provider: dict) -> dict:
    """Translate the provider's answer into a state transition."""
    status = provider.get("status", "")
    trigger = PROVIDER_STATUS.get(status)
    if trigger is None:
        raise PaymentProviderError(
            "The payment provider returned a status we do not understand.",
            details={"providerStatus": status},
        )

    async with db.transaction() as session:
        current = await payment_repo.get(session, payment["id"], for_update=True)
        if current["state"] != PaymentState.AUTHORIZING:
            return current
        updated = await payment_repo.transition(
            session,
            payment=current,
            trigger=trigger,
            provider_reference=provider.get("id"),
            decline_code=provider.get("decline_code"),
            failure_message=provider.get("failure_message"),
            provider_payload=_redacted(provider),
        )

    if updated["state"] == PaymentState.DECLINED:
        log.warning(
            "Payment declined",
            payment={**_log_fields(updated), "decline_code": updated["decline_code"]},
        )
    else:
        log.info("Payment authorized", payment=_log_fields(updated))
    return updated


async def _record_provider_error(payment: dict, exc: PaymentProviderError) -> dict:
    async with db.transaction() as session:
        current = await payment_repo.get(session, payment["id"], for_update=True)
        updated = await payment_repo.transition(
            session,
            payment=current,
            trigger=Trigger.FAIL,
            failure_message=exc.message,
            provider_payload=exc.details,
        )
    log.error(
        "Payment provider failed",
        error={"kind": exc.type, "message": exc.message},
        payment=_log_fields(updated),
    )
    return updated


async def _publish_result(payment: dict, booking: dict) -> None:
    if payment["state"] in (PaymentState.AUTHORIZED, PaymentState.CAPTURED):
        await runtime.producer.send(
            envelope.TOPIC_PAYMENTS,
            payment["booking_id"],
            "payment.authorized",
            _event_payload(payment, booking),
            correlation_id=current_request_id(),
        )
        await runtime.producer.send(
            envelope.TOPIC_NOTIFICATIONS,
            payment["booking_id"],
            "notification.requested",
            {
                "template": "payment_receipt",
                "recipient": booking.get("contactEmail", ""),
                "variables": {
                    "amountCents": payment["amount_cents"],
                    "currency": payment["currency"],
                    "cardLast4": payment["card_last4"],
                },
            },
            correlation_id=current_request_id(),
        )
    elif payment["state"] == PaymentState.DECLINED:
        await _publish_failure(payment, reason="declined", booking=booking)


async def _publish_failure(
    payment: dict, *, reason: str, booking: dict | None = None
) -> None:
    """A decline and a provider error are different events.

    booking-service treats both as `PENDING_PAYMENT -> FAILED`, but the event
    type is what lets a monitor alert on one and not the other.
    """
    await runtime.producer.send(
        envelope.TOPIC_PAYMENTS,
        payment["booking_id"],
        "payment.declined" if reason == "declined" else "payment.failed",
        {**_event_payload(payment, booking), "reason": reason},
        correlation_id=current_request_id(),
    )


async def _fetch_booking(booking_id: str) -> dict:
    settings = get_settings()
    try:
        response = await clients.client().get(
            f"{settings.booking_base_url}/v1/bookings/{booking_id}"
        )
    except httpx.HTTPError as exc:
        from app.errors import VoyagerError

        raise VoyagerError(
            "The booking could not be read.", details={"bookingId": booking_id}
        ) from exc

    if response.status_code == 404:
        raise ValidationError(
            "No booking matches that reference.", details={"bookingId": booking_id}
        )
    if response.status_code >= 400:
        from app.errors import VoyagerError

        raise VoyagerError(
            "The booking could not be read.",
            details={"bookingId": booking_id, "status": response.status_code},
        )
    return response.json()


async def _advance_booking(booking_id: str) -> None:
    """Ask booking-service to move HELD (or FAILED) to PENDING_PAYMENT.

    A failure here aborts the authorization rather than being logged and
    ignored, because the alternative is a charged card against a booking that
    can never be confirmed.
    """
    settings = get_settings()
    try:
        response = await clients.client().post(
            f"{settings.booking_base_url}/v1/bookings/{booking_id}/authorizing"
        )
    except httpx.HTTPError as exc:
        from app.errors import VoyagerError

        raise VoyagerError(
            "The booking could not be prepared for payment.",
            details={"bookingId": booking_id},
        ) from exc

    if response.status_code >= 400:
        from app.errors import InvalidPaymentTransitionError

        raise InvalidPaymentTransitionError(
            "This booking is not ready to be paid for.",
            details={"bookingId": booking_id, "status": response.status_code},
        )


def _assert_authorizable(booking: dict, body: Authorize) -> None:
    # § 15: only from HELD or FAILED, and only for the booking's own total.
    if booking["state"] not in ("HELD", "FAILED"):
        from app.errors import InvalidPaymentTransitionError

        raise InvalidPaymentTransitionError(
            "This booking is not ready to be paid for.",
            details={"bookingState": booking["state"]},
        )
    if body.amountCents != booking["totalCents"]:
        raise ValidationError(
            "The amount does not match the booking total.",
            details={
                "submittedCents": body.amountCents,
                "bookingTotalCents": booking["totalCents"],
            },
        )
    if body.currency.upper() != booking["currency"].upper():
        raise ValidationError(
            "The currency does not match the booking.",
            details={"submitted": body.currency, "booking": booking["currency"]},
        )


def _brand_of(number: str) -> str:
    # Invented brands, matching mock-payments. No real card network appears
    # anywhere in Voyager.
    return {"4": "meridian", "5": "cobalt", "3": "summit", "6": "orbit"}.get(
        number[:1], "unknown"
    )


def _redacted(provider: dict) -> dict:
    """Strip anything card-shaped before the payload reaches the ledger."""
    safe = {k: v for k, v in provider.items() if k not in ("card", "number", "cvc")}
    card = provider.get("card")
    if isinstance(card, dict):
        safe["card"] = {"last4": card.get("last4"), "brand": card.get("brand")}
    return safe


def _log_fields(payment: dict) -> dict:
    # Never the number, never the CVC. Last four and brand only.
    return {
        "id": payment["id"],
        "state": payment["state"],
        "amount_cents": payment["amount_cents"],
        "currency": payment["currency"],
        "card_last4": payment["card_last4"],
        "card_brand": payment["card_brand"],
    }


def _event_payload(payment: dict, booking: dict | None = None) -> dict:
    return {
        "paymentId": payment["id"],
        "bookingId": payment["booking_id"],
        # notification-worker has no database, so an event with no address is
        # an event it can only drop. Every publisher that leads to an email
        # passes the booking; the rest leave these null rather than adding an
        # HTTP call to a path that does not need one.
        "contactEmail": (booking or {}).get("contactEmail"),
        "pnr": (booking or {}).get("pnr"),
        "state": payment["state"],
        "amountCents": payment["amount_cents"],
        "currency": payment["currency"],
        "cardLast4": payment["card_last4"],
        "cardBrand": payment["card_brand"],
        "declineCode": payment.get("decline_code"),
    }


def _public(payment: dict) -> dict:
    return {
        "id": payment["id"],
        "bookingId": payment["booking_id"],
        "state": payment["state"],
        "amountCents": payment["amount_cents"],
        "currency": payment["currency"],
        "cardLast4": payment["card_last4"],
        "cardBrand": payment["card_brand"],
        "declineCode": payment.get("decline_code"),
        "failureMessage": payment.get("failure_message"),
        "requires3ds": payment.get("requires_3ds", False),
        "refundedAmountCents": payment.get("refunded_amount_cents") or 0,
        "authorizedAt": payment.get("authorized_at"),
        "capturedAt": payment.get("captured_at"),
        "refundedAt": payment.get("refunded_at"),
        "createdAt": payment.get("created_at"),
    }
