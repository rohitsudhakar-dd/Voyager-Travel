from __future__ import annotations

from dataclasses import dataclass

from app.intents import cancellation_confirmed, classify


@dataclass
class Turn:
    role: str
    content: str | None


def test_intents_are_classified_from_the_user_s_words():
    assert classify("I need to cancel my flight, PNR K8M2QR") == "cancellation_policy"
    assert classify("where is my booking?") == "booking_lookup"
    assert classify("how many bags can I take?") == "baggage_query"
    assert classify("has my refund been sent?") == "refund_status"
    assert classify("can I move my flight to Friday?") == "change_request"
    assert classify("hello") == "general"


def test_asking_to_cancel_is_not_confirming():
    history = [Turn("user", "I need to cancel my flight, PNR K8M2QR")]
    assert cancellation_confirmed(history) is False


def test_confirmation_requires_the_assistant_to_have_asked_first():
    history = [
        Turn("user", "yes"),
        Turn("assistant", "Would you like me to cancel that booking?"),
    ]
    assert cancellation_confirmed(history) is False


def test_a_yes_after_the_assistant_raises_cancelling_is_confirmation():
    history = [
        Turn("user", "I want to cancel booking K8M2QR"),
        Turn("assistant", "A fee applies. Shall I cancel it for you?"),
        Turn("user", "yes please, go ahead"),
    ]
    assert cancellation_confirmed(history) is True


def test_tool_turns_without_content_do_not_break_the_gate():
    history = [
        Turn("user", "cancel it"),
        Turn("tool", None),
        Turn("assistant", "Shall I cancel it?"),
        Turn("user", "confirmed"),
    ]
    assert cancellation_confirmed(history) is True
