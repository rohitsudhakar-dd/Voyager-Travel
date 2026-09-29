"""The payment state machine (05-FUNCTIONALITY.md § 4.2).

The distinction that matters here is DECLINED versus ERROR. A decline is a
business outcome -- the card said no, and the system worked. An ERROR is an
infrastructure failure -- we could not reach the provider at all. Conflating
them is the most common modelling mistake in payment systems, and keeping them
apart is what stops a customer's expired card from paging an engineer.
"""

from __future__ import annotations

from enum import StrEnum

from app.errors import InvalidPaymentTransitionError


class PaymentState(StrEnum):
    CREATED = "CREATED"
    AUTHORIZING = "AUTHORIZING"
    REQUIRES_3DS = "REQUIRES_3DS"
    AUTHORIZED = "AUTHORIZED"
    CAPTURED = "CAPTURED"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED"
    REFUNDED = "REFUNDED"
    DECLINED = "DECLINED"
    ERROR = "ERROR"


class Trigger(StrEnum):
    SUBMIT = "submit"
    APPROVE = "approve"
    DECLINE = "decline"
    CHALLENGE = "challenge"
    RESUBMIT = "resubmit"
    FAIL = "fail"
    CAPTURE = "capture"
    REFUND = "refund"
    REFUND_PARTIAL = "refund.partial"


TRANSITIONS: dict[tuple[PaymentState, Trigger], PaymentState] = {
    (PaymentState.CREATED, Trigger.SUBMIT): PaymentState.AUTHORIZING,
    (PaymentState.AUTHORIZING, Trigger.APPROVE): PaymentState.AUTHORIZED,
    (PaymentState.AUTHORIZING, Trigger.DECLINE): PaymentState.DECLINED,
    (PaymentState.AUTHORIZING, Trigger.CHALLENGE): PaymentState.REQUIRES_3DS,
    (PaymentState.AUTHORIZING, Trigger.FAIL): PaymentState.ERROR,
    (PaymentState.REQUIRES_3DS, Trigger.RESUBMIT): PaymentState.AUTHORIZING,
    (PaymentState.AUTHORIZED, Trigger.CAPTURE): PaymentState.CAPTURED,
    (PaymentState.CAPTURED, Trigger.REFUND): PaymentState.REFUNDED,
    (PaymentState.CAPTURED, Trigger.REFUND_PARTIAL): PaymentState.PARTIALLY_REFUNDED,
    (PaymentState.PARTIALLY_REFUNDED, Trigger.REFUND): PaymentState.REFUNDED,
    (PaymentState.PARTIALLY_REFUNDED, Trigger.REFUND_PARTIAL): (
        PaymentState.PARTIALLY_REFUNDED
    ),
}

TERMINAL_STATES = frozenset(
    {PaymentState.REFUNDED, PaymentState.DECLINED, PaymentState.ERROR}
)


def can_transition(current: PaymentState, trigger: Trigger) -> bool:
    return (current, trigger) in TRANSITIONS


def next_state(current: PaymentState, trigger: Trigger) -> PaymentState:
    try:
        return TRANSITIONS[(current, trigger)]
    except KeyError:
        raise InvalidPaymentTransitionError(
            f"A payment in {current} cannot be {_describe(trigger)}.",
            details={
                "from": str(current),
                "trigger": str(trigger),
                "allowed": sorted(
                    str(t) for (state, t) in TRANSITIONS if state == current
                ),
            },
        ) from None


def _describe(trigger: Trigger) -> str:
    return {
        Trigger.SUBMIT: "submitted",
        Trigger.APPROVE: "approved",
        Trigger.DECLINE: "declined",
        Trigger.CHALLENGE: "challenged for 3DS",
        Trigger.RESUBMIT: "resubmitted",
        Trigger.FAIL: "marked as a provider error",
        Trigger.CAPTURE: "captured",
        Trigger.REFUND: "refunded in full",
        Trigger.REFUND_PARTIAL: "refunded in part",
    }[trigger]
