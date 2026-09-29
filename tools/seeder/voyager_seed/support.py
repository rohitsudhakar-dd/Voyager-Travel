"""Seeded support conversations, so the AI support history is not empty.

Conversations are attached to real confirmed bookings and quote their real
PNRs, which means the seeded transcripts are consistent with the booking data
a tool call would return.
"""

from __future__ import annotations

import random
from datetime import timedelta
from typing import Iterator

from psycopg.types.json import Jsonb

from . import catalog
from .bookings import STATES_WITH_PNR, BookingFactory
from .identity import NS_CONVERSATION, uuid_for


def pick_conversation_bookings(factory: BookingFactory, count: int) -> list:
    """Walk the booking space until enough confirmed bookings are found."""
    chosen = []
    total = factory.config.volumes.bookings
    # A coprime stride spreads the sample across the whole range instead of
    # clustering it at the start.
    stride = 7_919
    index = 0
    for _ in range(total):
        index = (index + stride) % total
        facts = factory.facts(index)
        if facts.state in STATES_WITH_PNR and facts.user_id:
            chosen.append(facts)
            if len(chosen) >= count:
                break
    return chosen


def conversation_rows(conversations: list, rng: random.Random) -> Iterator[tuple]:
    for position, facts in enumerate(conversations):
        started = (facts.confirmed_at or facts.created_at) + timedelta(
            hours=rng.randrange(1, 720)
        )
        state = rng.choices(
            ("resolved", "open", "escalated"), weights=(0.78, 0.14, 0.08)
        )[0]
        yield (
            str(uuid_for(NS_CONVERSATION, position)),
            facts.user_id,
            facts.id,
            state,
            rng.choice(catalog.SUPPORT_INTENTS),
            started,
            started + timedelta(minutes=rng.randrange(1, 30)),
        )


CONVERSATION_COLUMNS = (
    "id", "user_id", "booking_id", "state", "intent", "created_at", "updated_at",
)


def message_rows(conversations: list, rng: random.Random) -> Iterator[tuple]:
    """Four messages per conversation: the shape of one tool-using exchange."""
    for position, facts in enumerate(conversations):
        conversation_id = str(uuid_for(NS_CONVERSATION, position))
        started = (facts.confirmed_at or facts.created_at) + timedelta(
            hours=rng.randrange(1, 720)
        )
        intent = rng.choice(catalog.SUPPORT_INTENTS)
        opener = catalog.SUPPORT_OPENERS[intent].format(pnr=facts.pnr)

        prompt_tokens = rng.randrange(180, 520)
        completion_tokens = rng.randrange(40, 260)

        yield (
            conversation_id, "user", opener, None, None, None,
            None, None, None, None, started,
        )
        yield (
            conversation_id, "assistant", None, "lookup_booking",
            Jsonb({"pnr": facts.pnr, "lastName": facts.passengers[0].last_name}),
            None, prompt_tokens, 24, rng.randrange(240, 1400), None,
            started + timedelta(seconds=2),
        )
        yield (
            conversation_id, "tool", None, "lookup_booking", None,
            Jsonb(
                {
                    "pnr": facts.pnr,
                    "state": facts.state,
                    "product_type": facts.product_type,
                    "total_cents": facts.total_cents,
                }
            ),
            None, None, rng.randrange(18, 140), None,
            started + timedelta(seconds=3),
        )
        yield (
            conversation_id, "assistant",
            f"Your booking {facts.pnr} is {facts.state.lower()}. "
            "Let me know if you would like to make a change.",
            None, None, None, prompt_tokens + 120, completion_tokens,
            rng.randrange(320, 1800), None,
            started + timedelta(seconds=5),
        )


MESSAGE_COLUMNS = (
    "conversation_id", "role", "content", "tool_name", "tool_args",
    "tool_result", "tokens_prompt", "tokens_completion", "latency_ms",
    "trace_id", "created_at",
)
