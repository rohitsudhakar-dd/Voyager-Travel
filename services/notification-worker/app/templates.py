"""Event to email: routing, itinerary rendering, and the template catalogue.

Pure functions with no I/O, so the rendering rules are unit-testable and the
consumer stays about delivery.

The template identifiers are not named anywhere in the specification, so they
are defined here once and referenced nowhere else. They are the `template` tag
on `voyager.notifications.sent` and `voyager.notifications.dlq`, so they are
deliberately few and stable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Event type -> template, for events that no producer asks about explicitly.
#
# booking-service and payment-service already request `booking_confirmed`,
# `booking_cancelled`, `payment_failed` and `payment_receipt` on
# `voyager.notifications.outbound`, so those same domain events are deliberately
# absent here -- routing both would send every customer two identical emails.
TEMPLATES: dict[str, str] = {
    "booking.expired": "booking_expired",
    "payment.refunded": "payment_refunded",
    "points.accrued": "loyalty_points_accrued",
    "tier.upgraded": "loyalty_tier_upgraded",
}

SUBJECTS: dict[str, str] = {
    "booking_confirmed": "Your Voyager booking is confirmed",
    "booking_cancelled": "Your Voyager booking has been cancelled",
    "booking_expired": "Your Voyager reservation has expired",
    "payment_receipt": "Your Voyager payment receipt",
    "payment_failed": "We could not take payment for your booking",
    "payment_refunded": "Your Voyager refund is on its way",
    "loyalty_points_accrued": "You have earned Voyager points",
    "loyalty_tier_upgraded": "Welcome to your new Voyager tier",
}


class MalformedMessage(Exception):
    """The message cannot be turned into an email. Retried, then DLQ'd."""


class NotRoutable(Exception):
    """Nothing to send for this event type. Acknowledged and dropped."""


class NoRecipient(NotRoutable):
    """The event maps to a template but carries no address.

    Dropped rather than dead-lettered: no retry and no manual DLQ replay can
    invent an address, and a DLQ that fills up with events a producer simply
    does not populate stops meaning anything. It is logged as a warning so the
    gap is still visible.
    """


@dataclass(frozen=True)
class Notification:
    template: str
    recipient: str
    subject: str
    body: str
    variables: dict[str, Any] = field(default_factory=dict)


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return None


def _money(cents: Any, currency: Any) -> str:
    try:
        amount = int(cents) / 100
    except (TypeError, ValueError):
        return "—"
    return f"{amount:,.2f} {currency or ''}".strip()


def _recipient(payload: dict[str, Any]) -> str:
    recipient = _first(payload, "recipient", "contactEmail", "contact_email", "email")
    if not isinstance(recipient, str) or "@" not in recipient:
        raise NoRecipient("Message has no usable recipient address.")
    return recipient


def render_itinerary(payload: dict[str, Any]) -> str:
    """The confirmation email body.

    Built from whatever the event carries: an event that omits the line items
    still produces a sensible email rather than a stack trace.
    """
    pnr = _first(payload, "pnr") or "pending"
    product = _first(payload, "productType", "product_type") or "trip"
    lines = [
        f"Booking reference: {pnr}",
        f"Product: {product}",
    ]

    items = _first(payload, "items", "bookingItems", "booking_items") or []
    if isinstance(items, list) and items:
        lines.append("")
        lines.append("Itinerary")
        for item in items:
            if not isinstance(item, dict):
                continue
            description = _first(item, "description") or _first(
                item, "itemType", "item_type"
            )
            price = _money(
                _first(item, "totalPriceCents", "total_price_cents"),
                _first(payload, "currency"),
            )
            lines.append(f"  - {description} ({price})")

    passengers = _first(payload, "passengers") or []
    if isinstance(passengers, list) and passengers:
        lines.append("")
        lines.append("Travellers")
        for passenger in passengers:
            if not isinstance(passenger, dict):
                continue
            first_name = _first(passenger, "firstName", "first_name") or ""
            last_name = _first(passenger, "lastName", "last_name") or ""
            seat = _first(passenger, "seatAssignment", "seat_assignment")
            suffix = f", seat {seat}" if seat else ""
            lines.append(f"  - {first_name} {last_name}".rstrip() + suffix)

    total = _money(
        _first(payload, "totalCents", "total_cents"), _first(payload, "currency")
    )
    lines.extend(["", f"Total paid: {total}"])
    return "\n".join(lines)


def _body(template: str, payload: dict[str, Any]) -> str:
    if template == "booking_confirmed":
        return render_itinerary(payload)

    pnr = _first(payload, "pnr") or _first(payload, "bookingId", "booking_id") or "—"

    if template == "booking_cancelled":
        reason = _first(payload, "cancellationReason", "cancellation_reason", "reason")
        return (
            f"Booking {pnr} has been cancelled."
            + (f"\nReason: {reason}" if reason else "")
            + "\nAny refund due will follow separately."
        )
    if template == "booking_expired":
        return (
            f"We held your reservation {pnr} for 15 minutes and it has now expired. "
            "Nothing has been charged. You are welcome to search again."
        )
    if template == "payment_failed":
        code = _first(payload, "declineCode", "decline_code")
        expires = _first(payload, "holdExpiresAt", "hold_expires_at")
        return (
            f"Your payment for booking {pnr} was declined"
            + (f" ({code})" if code else "")
            + ".\nYour reservation is still held, so you can try another card."
            + (f"\nIt is held until {expires}." if expires else "")
        )
    if template == "payment_receipt":
        # Only ever the last four digits and the scheme: § 10.1 forbids the card
        # number and the CVC leaving payment-service at all.
        last4 = _first(payload, "cardLast4", "card_last4")
        return (
            f"We have taken {_money(_first(payload, 'amountCents', 'amount_cents'), _first(payload, 'currency'))} "
            f"for booking {pnr}."
            + (f"\nCard ending {last4}." if last4 else "")
        )
    if template == "payment_refunded":
        amount = _money(
            _first(
                payload,
                "refundedCents",
                "refundedAmountCents",
                "refunded_amount_cents",
                "amountCents",
            ),
            _first(payload, "currency"),
        )
        return (
            f"A refund of {amount} for booking {pnr} has been sent to your original "
            "payment method. Banks typically take five to ten business days."
        )
    if template == "loyalty_points_accrued":
        points = _first(payload, "points") or 0
        balance = _first(payload, "balanceAfter", "balance_after") or 0
        return (
            f"You earned {points} points on booking {pnr}.\n"
            f"Your balance is now {balance} points."
        )
    if template == "loyalty_tier_upgraded":
        from_tier = _first(payload, "fromTier", "from_tier") or "standard"
        to_tier = _first(payload, "toTier", "to_tier") or "silver"
        return (
            f"Congratulations — you have moved from {from_tier} to {to_tier}. "
            "Your new earn rate applies from your next booking."
        )
    raise NotRoutable(template)


def notification_for(event_type: str, payload: dict[str, Any]) -> Notification:
    """Route one event to one email.

    `voyager.notifications.outbound` carries `{template, recipient, variables}`
    and is honoured as given, because its producers have already decided what
    should be sent.
    """
    if not isinstance(payload, dict):
        raise MalformedMessage("Event payload is not an object.")

    explicit_template = _first(payload, "template")
    if explicit_template:
        variables = _first(payload, "variables") or {}
        if not isinstance(variables, dict):
            raise MalformedMessage("Outbound payload variables is not an object.")
        merged = {**variables, **{k: v for k, v in payload.items() if k != "variables"}}
        template = str(explicit_template)
        return Notification(
            template=template,
            recipient=_recipient(merged),
            subject=SUBJECTS.get(template, "A message about your Voyager booking"),
            body=_body(template, merged) if template in SUBJECTS else _render_variables(variables),
            variables=variables,
        )

    template = TEMPLATES.get(event_type)
    if template is None:
        raise NotRoutable(event_type)

    return Notification(
        template=template,
        recipient=_recipient(payload),
        subject=SUBJECTS[template],
        body=_body(template, payload),
        variables=payload,
    )


def _render_variables(variables: dict[str, Any]) -> str:
    """Fallback body for a template this service does not know about.

    Better than refusing to send: the producer asked for a specific template,
    and losing the message would be worse than sending a plain one.
    """
    return "\n".join(f"{key}: {value}" for key, value in sorted(variables.items()))
