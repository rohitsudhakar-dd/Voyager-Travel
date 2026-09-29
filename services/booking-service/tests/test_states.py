"""Every legal transition, and every illegal one.

05-FUNCTIONALITY.md § 4.1 asks for a test per illegal transition. Rather than
writing sixty-odd of them by hand, the cases are generated from the cross
product of states and triggers and subtracted from the legal table -- which
means adding a transition to the table cannot silently remove its test.
"""

from __future__ import annotations

import pytest

from app.domain.states import (
    ALL_STATES,
    ALL_TRIGGERS,
    TERMINAL_STATES,
    TRANSITIONS,
    BookingState,
    Trigger,
    can_transition,
    next_state,
)
from app.errors import InvalidBookingTransitionError

LEGAL = sorted(
    ((state, trigger, target) for (state, trigger), target in TRANSITIONS.items()),
    key=lambda case: (str(case[0]), str(case[1])),
)

ILLEGAL = sorted(
    (
        (state, trigger)
        for state in ALL_STATES
        for trigger in ALL_TRIGGERS
        if (state, trigger) not in TRANSITIONS
    ),
    key=lambda case: (str(case[0]), str(case[1])),
)


@pytest.mark.parametrize(
    "state,trigger,expected", LEGAL, ids=[f"{s}-{t}" for s, t, _ in LEGAL]
)
def test_legal_transition(state, trigger, expected):
    assert next_state(state, trigger) is expected
    assert can_transition(state, trigger)


@pytest.mark.parametrize("state,trigger", ILLEGAL, ids=[f"{s}-{t}" for s, t in ILLEGAL])
def test_illegal_transition_raises(state, trigger):
    assert not can_transition(state, trigger)
    with pytest.raises(InvalidBookingTransitionError) as caught:
        next_state(state, trigger)
    # 409, because the request was well-formed and the client may retry after
    # re-reading the booking.
    assert caught.value.status_code == 409
    assert caught.value.details["from"] == str(state)


def test_there_are_illegal_transitions_to_test():
    # Guards the generator: a table that accidentally allowed everything would
    # otherwise make the suite above vacuous.
    assert len(ILLEGAL) > 50
    assert len(LEGAL) == len(TRANSITIONS)


def test_only_expired_and_refunded_are_terminal():
    """The two easy mistakes are treating FAILED and CANCELLED as dead ends.

    FAILED must be able to retry while the hold lives, and CANCELLED must be
    able to advance to REFUNDED, or a cancelled booking never returns anyone's
    money.
    """
    assert TERMINAL_STATES == {BookingState.EXPIRED, BookingState.REFUNDED}
    for state in TERMINAL_STATES:
        assert not any(origin == state for origin, _ in TRANSITIONS)

    assert can_transition(BookingState.FAILED, Trigger.RETRY)
    assert can_transition(BookingState.CANCELLED, Trigger.REFUND_COMPLETED)


def test_confirmation_requires_pending_payment():
    """The transition that would be a money bug if it were ever allowed."""
    for state in ALL_STATES - {BookingState.PENDING_PAYMENT}:
        with pytest.raises(InvalidBookingTransitionError):
            next_state(state, Trigger.PAYMENT_AUTHORIZED)


def test_a_confirmed_booking_cannot_expire():
    """A hold sweep must never touch a paid-for booking."""
    with pytest.raises(InvalidBookingTransitionError):
        next_state(BookingState.CONFIRMED, Trigger.SWEEP)


def test_error_names_allowed_triggers():
    with pytest.raises(InvalidBookingTransitionError) as caught:
        next_state(BookingState.DRAFT, Trigger.PAYMENT_AUTHORIZED)
    assert caught.value.details["allowed"] == ["abandon", "hold"]
