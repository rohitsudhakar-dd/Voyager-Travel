"""Tool execution.

Three rules are enforced here rather than in the prompt, because a prompt is a
suggestion and a handler is a gate:

1. `initiate_cancellation` runs only after the traveller has agreed in the
   conversation (05-FUNCTIONALITY.md § 9).
2. A booking may only be read or cancelled if it already appeared in this
   conversation -- via the conversation's own `booking_id` or an earlier
   `lookup_booking` result. Otherwise a model that invents a booking id, or a
   caller that feeds it one, becomes a way to read other people's bookings.
3. `get_loyalty_balance` always uses the conversation's user, never the `userId`
   the model passed. Same reason.

`llm_hallucinate` exists to make the model's *output* wrong. These three rules
are what stop it also making the *data* wrong.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Literal

from app.clients import BookingClient, LoyaltyClient
from app.errors import DependencyError
from app.intents import cancellation_confirmed
from app.llmobs import tool_span
from app.repo import Conversation, Message, SupportRepo
from app.tools.schemas import (
    ESCALATE_TO_HUMAN,
    GET_CANCELLATION_POLICY,
    GET_LOYALTY_BALANCE,
    INITIATE_CANCELLATION,
    LOOKUP_BOOKING,
)

Outcome = Literal["ok", "not_found", "refused", "error"]


@dataclass(frozen=True)
class ToolResult:
    outcome: Outcome
    result: dict[str, Any]


@dataclass(frozen=True)
class ToolContext:
    conversation: Conversation
    history: list[Message]


def known_booking_ids(context: ToolContext) -> set[str]:
    """Booking ids this conversation has legitimately seen."""
    known: set[str] = set()
    if context.conversation.booking_id is not None:
        known.add(str(context.conversation.booking_id))

    for message in context.history:
        result = message.tool_result
        if not isinstance(result, dict):
            continue
        for booking in _bookings_in(result):
            identifier = booking.get("id") or booking.get("bookingId")
            if isinstance(identifier, str):
                known.add(identifier)
    return known


def known_pnrs(history: list[Message]) -> set[str]:
    """Booking references this conversation actually retrieved.

    The counterpart to `known_booking_ids`, and the basis of the hallucination
    check in conversation.py: a reference in an answer that is not in here was
    not read out of the database, whatever the model says about it.
    """
    known: set[str] = set()
    for message in history:
        result = message.tool_result
        if not isinstance(result, dict):
            continue
        for booking in _bookings_in(result):
            pnr = booking.get("pnr") or booking.get("recordLocator")
            if isinstance(pnr, str):
                known.add(pnr.upper())
    return known


def _bookings_in(result: dict[str, Any]) -> Iterable[dict[str, Any]]:
    booking = result.get("booking")
    if isinstance(booking, dict):
        yield booking
    bookings = result.get("bookings")
    if isinstance(bookings, list):
        yield from (item for item in bookings if isinstance(item, dict))


class ToolRunner:
    def __init__(
        self, repo: SupportRepo, booking: BookingClient, loyalty: LoyaltyClient
    ) -> None:
        self._repo = repo
        self._booking = booking
        self._loyalty = loyalty

    async def run(
        self, name: str, args: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        handler = {
            LOOKUP_BOOKING: self._lookup_booking,
            GET_CANCELLATION_POLICY: self._get_cancellation_policy,
            INITIATE_CANCELLATION: self._initiate_cancellation,
            GET_LOYALTY_BALANCE: self._get_loyalty_balance,
            ESCALATE_TO_HUMAN: self._escalate_to_human,
        }.get(name)

        if handler is None:
            return ToolResult(
                "error", {"status": "error", "reason": f"Unknown tool: {name}"}
            )

        try:
            return await handler(args, context)
        except DependencyError as exc:
            # Surfaced to the model as a tool failure so it can apologise rather
            # than invent an answer, and logged as an error by the caller.
            return ToolResult(
                "error",
                {"status": "error", "reason": exc.message, "details": exc.details},
            )

    # ------------------------------------------------------------------- tools

    @tool_span("lookup_booking")
    async def _lookup_booking(
        self, args: dict[str, Any], _context: ToolContext
    ) -> ToolResult:
        pnr = _string(args.get("pnr"))
        last_name = _string(args.get("lastName"))
        if not pnr or not last_name:
            return ToolResult(
                "refused",
                {
                    "status": "missing_arguments",
                    "reason": "Both the booking reference and the surname are needed.",
                },
            )

        response = await self._booking.find_by_pnr(pnr.upper(), last_name)
        if response.status_code == 404 or not response.body:
            return ToolResult(
                "not_found",
                {
                    "status": "not_found",
                    "reason": "No booking matches that reference and surname.",
                },
            )
        if not response.ok:
            return ToolResult(
                "error", {"status": "error", "reason": "The booking could not be read."}
            )

        return ToolResult("ok", {"status": "ok", **_as_booking_result(response.body)})

    @tool_span("get_cancellation_policy")
    async def _get_cancellation_policy(
        self, args: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        booking_id = _string(args.get("bookingId"))
        if not booking_id or booking_id not in known_booking_ids(context):
            return ToolResult("refused", _unknown_booking())

        response = await self._booking.get_booking(booking_id)
        if response.status_code == 404 or not isinstance(response.body, dict):
            return ToolResult("not_found", {"status": "not_found"})

        return ToolResult("ok", {"status": "ok", **_policy_from(response.body)})

    @tool_span("initiate_cancellation")
    async def _initiate_cancellation(
        self, args: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        booking_id = _string(args.get("bookingId"))
        if not booking_id or booking_id not in known_booking_ids(context):
            return ToolResult("refused", _unknown_booking())

        if not cancellation_confirmed(context.history):
            return ToolResult(
                "refused",
                {
                    "status": "confirmation_required",
                    "reason": (
                        "The traveller has not yet confirmed. Explain the refund "
                        "terms and ask them to confirm before cancelling."
                    ),
                },
            )

        reason = _string(args.get("reason")) or "Cancelled via support chat"
        response = await self._booking.cancel(booking_id, reason)
        if not response.ok:
            return ToolResult(
                "error",
                {
                    "status": "error",
                    "reason": "The booking could not be cancelled.",
                    "details": response.body if isinstance(response.body, dict) else {},
                },
            )

        return ToolResult(
            "ok",
            {
                "status": "ok",
                "bookingId": booking_id,
                "booking": response.body if isinstance(response.body, dict) else None,
            },
        )

    @tool_span("get_loyalty_balance")
    async def _get_loyalty_balance(
        self, _args: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        user_id = context.conversation.user_id
        if user_id is None:
            return ToolResult(
                "refused",
                {
                    "status": "not_signed_in",
                    "reason": "Loyalty balances are only available to signed-in members.",
                },
            )

        response = await self._loyalty.get_balance(user_id)
        if not response.ok or not isinstance(response.body, dict):
            return ToolResult(
                "error",
                {"status": "error", "reason": "The loyalty balance could not be read."},
            )

        body = response.body
        return ToolResult(
            "ok",
            {
                "status": "ok",
                "pointsBalance": body.get("pointsBalance"),
                "tier": body.get("tier"),
                "nextTier": body.get("nextTier"),
            },
        )

    @tool_span("escalate_to_human")
    async def _escalate_to_human(
        self, args: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        # The model's `conversationId` argument is ignored in favour of the real
        # one: it is not the model's business which conversation it is in.
        summary = _string(args.get("summary")) or "Escalated from support chat"
        await self._repo.set_state(context.conversation.id, "escalated")
        return ToolResult(
            "ok",
            {
                "status": "ok",
                "conversationId": str(context.conversation.id),
                "state": "escalated",
                "summary": summary,
            },
        )


# ---------------------------------------------------------------------- shaping


def _unknown_booking() -> dict[str, Any]:
    return {
        "status": "unknown_booking",
        "reason": (
            "That booking has not been looked up in this conversation. Ask for the "
            "booking reference and surname and call lookup_booking first."
        ),
    }


def _as_booking_result(body: Any) -> dict[str, Any]:
    """booking-service may answer a PNR lookup with one booking or a collection.

    Both shapes are accepted because the endpoint serves both the guest lookup
    and the list form (§ 2.5).
    """
    if isinstance(body, list):
        return {"bookings": body}
    if isinstance(body, dict):
        if isinstance(body.get("bookings"), list):
            return {"bookings": body["bookings"]}
        return {"booking": body}
    return {"booking": None}


_POLICY_KEYS = ("refundable", "changeable", "cancellationHours", "cancellationPolicy")


def _policy_from(booking: dict[str, Any]) -> dict[str, Any]:
    """Pull whatever cancellation terms the booking carries.

    § 15 says the refund amount is computed from the fare's cancellation policy
    via pricing-service, but § 2 defines no pricing-service endpoint that returns
    one, so the terms are read off the booking and reported as unavailable when
    they are not there. Saying "I do not know" is the only honest option; making
    a refund figure up is not.
    """
    terms = {key: booking[key] for key in _POLICY_KEYS if key in booking}

    # booking-service keeps the fare's `refundable` flag in the booking metadata.
    metadata = booking.get("metadata")
    if isinstance(metadata, dict):
        for key in _POLICY_KEYS:
            if key in metadata and key not in terms:
                terms[key] = metadata[key]

    for item in booking.get("items") or []:
        if not isinstance(item, dict):
            continue
        metadata = item.get("itemMetadata") or item.get("item_metadata") or {}
        source = {**item, **(metadata if isinstance(metadata, dict) else {})}
        for key in _POLICY_KEYS:
            if key in source and key not in terms:
                terms[key] = source[key]

    return {
        "bookingId": booking.get("id") or booking.get("bookingId"),
        "state": booking.get("state"),
        "totalCents": booking.get("totalCents") or booking.get("total_cents"),
        "currency": booking.get("currency"),
        "terms": terms or None,
        "termsAvailable": bool(terms),
    }


def _string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
