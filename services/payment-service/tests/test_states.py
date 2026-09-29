"""The payment state machine (05-FUNCTIONALITY.md § 4.2).

The test that earns its keep here is the one asserting DECLINED and ERROR are
reached by different triggers and never converge. Conflating them is the
classic payment-system modelling bug, and it is invisible until someone tries
to alert on "payment failures" and gets paged for expired cards.
"""

from __future__ import annotations

import pytest

from app.domain.states import (
    TERMINAL_STATES,
    TRANSITIONS,
    PaymentState,
    Trigger,
    can_transition,
    next_state,
)
from app.errors import InvalidPaymentTransitionError

LEGAL = sorted(
    ((state, trigger, target) for (state, trigger), target in TRANSITIONS.items()),
    key=lambda case: (str(case[0]), str(case[1])),
)

ILLEGAL = sorted(
    (
        (state, trigger)
        for state in PaymentState
        for trigger in Trigger
        if (state, trigger) not in TRANSITIONS
    ),
    key=lambda case: (str(case[0]), str(case[1])),
)


@pytest.mark.parametrize(
    "state,trigger,expected", LEGAL, ids=[f"{s}-{t}" for s, t, _ in LEGAL]
)
def test_legal_transition(state, trigger, expected):
    assert next_state(state, trigger) is expected


@pytest.mark.parametrize("state,trigger", ILLEGAL, ids=[f"{s}-{t}" for s, t in ILLEGAL])
def test_illegal_transition_raises(state, trigger):
    with pytest.raises(InvalidPaymentTransitionError) as caught:
        next_state(state, trigger)
    assert caught.value.status_code == 409


def test_declined_and_error_stay_distinct():
    assert next_state(PaymentState.AUTHORIZING, Trigger.DECLINE) is PaymentState.DECLINED
    assert next_state(PaymentState.AUTHORIZING, Trigger.FAIL) is PaymentState.ERROR

    # Neither is reachable by the other's trigger, from anywhere.
    for state in PaymentState:
        if can_transition(state, Trigger.DECLINE):
            assert next_state(state, Trigger.DECLINE) is not PaymentState.ERROR
        if can_transition(state, Trigger.FAIL):
            assert next_state(state, Trigger.FAIL) is not PaymentState.DECLINED


def test_a_declined_payment_cannot_be_captured():
    with pytest.raises(InvalidPaymentTransitionError):
        next_state(PaymentState.DECLINED, Trigger.CAPTURE)


def test_only_an_authorized_payment_can_be_captured():
    for state in set(PaymentState) - {PaymentState.AUTHORIZED}:
        with pytest.raises(InvalidPaymentTransitionError):
            next_state(state, Trigger.CAPTURE)


def test_refunds_start_from_a_capture():
    with pytest.raises(InvalidPaymentTransitionError):
        next_state(PaymentState.AUTHORIZED, Trigger.REFUND)
    assert next_state(PaymentState.CAPTURED, Trigger.REFUND) is PaymentState.REFUNDED


def test_a_partial_refund_can_be_topped_up_to_a_full_one():
    assert (
        next_state(PaymentState.PARTIALLY_REFUNDED, Trigger.REFUND_PARTIAL)
        is PaymentState.PARTIALLY_REFUNDED
    )
    assert (
        next_state(PaymentState.PARTIALLY_REFUNDED, Trigger.REFUND)
        is PaymentState.REFUNDED
    )


def test_3ds_returns_to_authorizing():
    assert (
        next_state(PaymentState.AUTHORIZING, Trigger.CHALLENGE)
        is PaymentState.REQUIRES_3DS
    )
    assert (
        next_state(PaymentState.REQUIRES_3DS, Trigger.RESUBMIT)
        is PaymentState.AUTHORIZING
    )


def test_terminal_states_have_no_way_out():
    assert TERMINAL_STATES == {
        PaymentState.REFUNDED,
        PaymentState.DECLINED,
        PaymentState.ERROR,
    }
    for state in TERMINAL_STATES:
        assert not any(origin == state for origin, _ in TRANSITIONS)
