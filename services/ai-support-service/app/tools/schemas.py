"""The five tools from 05-FUNCTIONALITY.md § 9, in OpenAI function-calling form.

The descriptions matter: they are the only thing the model reads when deciding
which tool to reach for. `initiate_cancellation` says out loud that confirmation
is required, but that sentence is a courtesy -- the gate is enforced in the
handler, not here.
"""

from __future__ import annotations

from typing import Any

LOOKUP_BOOKING = "lookup_booking"
GET_CANCELLATION_POLICY = "get_cancellation_policy"
INITIATE_CANCELLATION = "initiate_cancellation"
GET_LOYALTY_BALANCE = "get_loyalty_balance"
ESCALATE_TO_HUMAN = "escalate_to_human"

TOOL_NAMES = (
    LOOKUP_BOOKING,
    GET_CANCELLATION_POLICY,
    INITIATE_CANCELLATION,
    GET_LOYALTY_BALANCE,
    ESCALATE_TO_HUMAN,
)

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": LOOKUP_BOOKING,
            "description": (
                "Look up a booking by its six-character booking reference (PNR) "
                "and the lead traveller's surname."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pnr": {"type": "string", "description": "Six-character booking reference."},
                    "lastName": {"type": "string", "description": "Lead traveller's surname."},
                },
                "required": ["pnr", "lastName"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": GET_CANCELLATION_POLICY,
            "description": (
                "Fetch the cancellation terms for a booking already found in this "
                "conversation. Use before discussing refunds."
            ),
            "parameters": {
                "type": "object",
                "properties": {"bookingId": {"type": "string"}},
                "required": ["bookingId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": INITIATE_CANCELLATION,
            "description": (
                "Cancel a booking. Only call this after the traveller has "
                "explicitly agreed to cancel in this conversation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "bookingId": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["bookingId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": GET_LOYALTY_BALANCE,
            "description": "Fetch the signed-in member's points balance and tier.",
            "parameters": {
                "type": "object",
                "properties": {"userId": {"type": "string"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": ESCALATE_TO_HUMAN,
            "description": (
                "Hand the conversation to a human agent. Use when the traveller "
                "asks for a person or the request cannot be resolved."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "conversationId": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["summary"],
            },
        },
    },
]
