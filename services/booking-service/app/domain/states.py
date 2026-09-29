"""The booking state machine, transcribed from 05-FUNCTIONALITY.md § 4.1.

The transition table below is the whole specification. Anything not in it
raises, which is what keeps `FAILED -> CONFIRMED` from ever quietly happening
because one handler forgot a guard.
"""

from __future__ import annotations

from enum import StrEnum

from app.errors import InvalidBookingTransitionError


class BookingState(StrEnum):
    DRAFT = "DRAFT"
    HELD = "HELD"
    PENDING_PAYMENT = "PENDING_PAYMENT"
    CONFIRMED = "CONFIRMED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"
    REFUNDED = "REFUNDED"


class Trigger(StrEnum):
    HOLD = "hold"
    ABANDON = "abandon"
    AUTHORIZE = "authorize"
    SWEEP = "sweep"
    PAYMENT_AUTHORIZED = "payment.authorized"
    PAYMENT_FAILED = "payment.failed"
    RETRY = "retry"
    CANCEL = "cancel"
    REFUND_COMPLETED = "refund.completed"


# (from, trigger) -> to. Exhaustive: the § 4.1 table and nothing else.
TRANSITIONS: dict[tuple[BookingState, Trigger], BookingState] = {
    (BookingState.DRAFT, Trigger.HOLD): BookingState.HELD,
    (BookingState.DRAFT, Trigger.ABANDON): BookingState.CANCELLED,
    (BookingState.HELD, Trigger.AUTHORIZE): BookingState.PENDING_PAYMENT,
    (BookingState.HELD, Trigger.SWEEP): BookingState.EXPIRED,
    (BookingState.HELD, Trigger.ABANDON): BookingState.CANCELLED,
    (BookingState.PENDING_PAYMENT, Trigger.PAYMENT_AUTHORIZED): BookingState.CONFIRMED,
    (BookingState.PENDING_PAYMENT, Trigger.PAYMENT_FAILED): BookingState.FAILED,
    (BookingState.PENDING_PAYMENT, Trigger.SWEEP): BookingState.EXPIRED,
    (BookingState.FAILED, Trigger.RETRY): BookingState.PENDING_PAYMENT,
    (BookingState.CONFIRMED, Trigger.CANCEL): BookingState.CANCELLED,
    (BookingState.CANCELLED, Trigger.REFUND_COMPLETED): BookingState.REFUNDED,
}

# Only these two. FAILED can retry while the hold lives, and CANCELLED still
# owes the traveller a refund, so neither is an end.
TERMINAL_STATES = frozenset({BookingState.EXPIRED, BookingState.REFUNDED})

ALL_STATES = frozenset(BookingState)
ALL_TRIGGERS = frozenset(Trigger)


def can_transition(current: BookingState, trigger: Trigger) -> bool:
    return (current, trigger) in TRANSITIONS


def next_state(current: BookingState, trigger: Trigger) -> BookingState:
    """Resolve a transition or refuse it.

    The error carries both ends of the attempted move, because "invalid
    transition" on its own is useless at three in the morning.
    """
    try:
        return TRANSITIONS[(current, trigger)]
    except KeyError:
        raise InvalidBookingTransitionError(
            f"A booking in {current} cannot be {_describe(trigger)}.",
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
        Trigger.HOLD: "put on hold",
        Trigger.ABANDON: "abandoned",
        Trigger.AUTHORIZE: "sent for payment",
        Trigger.SWEEP: "expired",
        Trigger.PAYMENT_AUTHORIZED: "confirmed",
        Trigger.PAYMENT_FAILED: "failed",
        Trigger.RETRY: "retried",
        Trigger.CANCEL: "cancelled",
        Trigger.REFUND_COMPLETED: "refunded",
    }[trigger]
