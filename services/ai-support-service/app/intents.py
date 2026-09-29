"""Intent classification, and the cancellation confirmation gate.

Both are keyword matching, and both are here rather than in the prompt on
purpose.

`support_conversations.intent` is a column and the `intent` tag on
`voyager.support.conversations`, so it has to be decided server-side from the
user's words -- the model is not asked what the intent was, because a
low-cardinality tag cannot depend on what a model felt like saying.

The confirmation gate is the more important of the two. `initiate_cancellation`
may only run after the user has said yes in the conversation, and that check
lives here and is called from the tool handler. A prompt-only guard is a demo
waiting to embarrass you.
"""

from __future__ import annotations

import re
from typing import Iterable, Literal, Protocol

Intent = Literal[
    "booking_lookup",
    "cancellation_policy",
    "change_request",
    "baggage_query",
    "refund_status",
    "general",
]

_KEYWORDS: list[tuple[Intent, re.Pattern[str]]] = [
    ("refund_status", re.compile(r"\brefund(ed|s)?\b|money back|reimburse", re.I)),
    ("cancellation_policy", re.compile(r"\bcancel|cancellation|policy|penalt", re.I)),
    (
        "change_request",
        re.compile(r"\bchange|reschedul|rebook|move my|different date|amend", re.I),
    ),
    ("baggage_query", re.compile(r"\bbag(gage|s)?\b|luggage|suitcase|carry.?on", re.I)),
    (
        "booking_lookup",
        re.compile(r"\bbooking|reservation|itinerary|pnr|confirmation|my flight", re.I),
    ),
]


def classify(text: str) -> Intent:
    for intent, pattern in _KEYWORDS:
        if pattern.search(text):
            return intent
    return "general"


_AFFIRMATIVE = re.compile(
    r"\b(yes|yep|yeah|confirm|confirmed|go ahead|do it|please cancel|proceed)\b", re.I
)
_CANCELLATION_TOPIC = re.compile(r"cancel", re.I)


class _Turn(Protocol):
    role: str
    content: str | None


def cancellation_confirmed(history: Iterable[_Turn]) -> bool:
    """True only once the assistant has raised cancelling and the user has then
    agreed, in that order.

    Order is what makes this a gate rather than a keyword search: a user who
    opens with "cancel my flight" has asked for something, not confirmed it.
    """
    asked = False
    for turn in history:
        content = turn.content or ""
        if turn.role == "assistant" and _CANCELLATION_TOPIC.search(content):
            asked = True
        elif turn.role == "user" and asked and _AFFIRMATIVE.search(content):
            return True
    return False
