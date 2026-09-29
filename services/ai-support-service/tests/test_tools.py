from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

from app.clients import Response
from app.repo import Conversation, Message
from app.tools.handlers import ToolContext, ToolRunner

BOOKING_ID = "4f1d9d64-8f7a-4d4f-9c86-3d6b0f9f1f2a"
USER_ID = UUID("c0ffee00-0000-4000-8000-000000000001")
NOW = datetime(2026, 9, 29, 10, 14, 22, tzinfo=timezone.utc)

BOOKING = {
    "id": BOOKING_ID,
    "pnr": "K8M2QR",
    "state": "CONFIRMED",
    "totalCents": 41_200,
    "currency": "GBP",
    "items": [{"description": "LHR to JFK", "itemMetadata": {"refundable": True}}],
}


def conversation(user_id: UUID | None = USER_ID, booking_id: UUID | None = None):
    return Conversation(
        id=uuid4(),
        user_id=user_id,
        booking_id=booking_id,
        state="open",
        intent=None,
        created_at=NOW,
        updated_at=NOW,
    )


def message(role: str, content: str | None = None, **kwargs) -> Message:
    return Message(
        id=1,
        role=role,
        content=content,
        tool_name=kwargs.get("tool_name"),
        tool_args=kwargs.get("tool_args"),
        tool_result=kwargs.get("tool_result"),
        tokens_prompt=None,
        tokens_completion=None,
        latency_ms=None,
        created_at=NOW,
    )


def looked_up(booking: dict | None = None) -> Message:
    return message(
        "tool",
        tool_name="lookup_booking",
        tool_args={"pnr": "K8M2QR", "lastName": "Lovelace"},
        tool_result={"status": "ok", "booking": booking or BOOKING},
    )


class StubRepo:
    def __init__(self) -> None:
        self.states: list[tuple[UUID, str]] = []

    async def set_state(self, conversation_id: UUID, state: str) -> None:
        self.states.append((conversation_id, state))


class StubBooking:
    def __init__(self, lookup: Response | None = None) -> None:
        self._lookup = lookup or Response(200, BOOKING)
        self.cancelled: list[tuple[str, str]] = []

    async def find_by_pnr(self, pnr: str, last_name: str) -> Response:
        return self._lookup

    async def get_booking(self, booking_id: str) -> Response:
        return Response(200, BOOKING)

    async def cancel(self, booking_id: str, reason: str) -> Response:
        self.cancelled.append((booking_id, reason))
        return Response(200, {**BOOKING, "state": "CANCELLED"})


class StubLoyalty:
    def __init__(self) -> None:
        self.requested: list[str] = []

    async def get_balance(self, user_id) -> Response:
        self.requested.append(str(user_id))
        return Response(200, {"pointsBalance": 1_412, "tier": "silver", "nextTier": None})


def runner(repo=None, booking=None, loyalty=None) -> ToolRunner:
    return ToolRunner(repo or StubRepo(), booking or StubBooking(), loyalty or StubLoyalty())


@pytest.mark.asyncio
async def test_lookup_booking_returns_the_booking():
    result = await runner().run(
        "lookup_booking", {"pnr": "k8m2qr", "lastName": "Lovelace"}, ToolContext(conversation(), [])
    )
    assert result.outcome == "ok"
    assert result.result["booking"]["pnr"] == "K8M2QR"


@pytest.mark.asyncio
async def test_lookup_booking_needs_both_arguments():
    result = await runner().run(
        "lookup_booking", {"pnr": "K8M2QR"}, ToolContext(conversation(), [])
    )
    assert result.outcome == "refused"
    assert result.result["status"] == "missing_arguments"


@pytest.mark.asyncio
async def test_an_unknown_booking_cannot_have_its_policy_read():
    # The model invented a booking id -- which is what `llm_hallucinate` makes it
    # do -- and the handler refuses rather than reading a stranger's booking.
    result = await runner().run(
        "get_cancellation_policy", {"bookingId": BOOKING_ID}, ToolContext(conversation(), [])
    )
    assert result.outcome == "refused"
    assert result.result["status"] == "unknown_booking"


@pytest.mark.asyncio
async def test_a_looked_up_booking_can_have_its_policy_read():
    result = await runner().run(
        "get_cancellation_policy",
        {"bookingId": BOOKING_ID},
        ToolContext(conversation(), [looked_up()]),
    )
    assert result.outcome == "ok"
    assert result.result["termsAvailable"] is True
    assert result.result["terms"]["refundable"] is True


@pytest.mark.asyncio
async def test_cancellation_is_refused_until_the_traveller_confirms():
    booking = StubBooking()
    context = ToolContext(
        conversation(),
        [message("user", "cancel booking K8M2QR"), looked_up()],
    )

    result = await runner(booking=booking).run(
        "initiate_cancellation", {"bookingId": BOOKING_ID}, context
    )

    assert result.outcome == "refused"
    assert result.result["status"] == "confirmation_required"
    assert booking.cancelled == []


@pytest.mark.asyncio
async def test_cancellation_is_refused_for_a_booking_this_conversation_never_saw():
    booking = StubBooking()
    context = ToolContext(
        conversation(),
        [
            message("user", "cancel it"),
            message("assistant", "Shall I cancel that booking?"),
            message("user", "yes go ahead"),
        ],
    )

    result = await runner(booking=booking).run(
        "initiate_cancellation", {"bookingId": BOOKING_ID}, context
    )

    assert result.outcome == "refused"
    assert booking.cancelled == []


@pytest.mark.asyncio
async def test_cancellation_proceeds_once_looked_up_and_confirmed():
    booking = StubBooking()
    context = ToolContext(
        conversation(),
        [
            message("user", "cancel booking K8M2QR"),
            looked_up(),
            message("assistant", "A fee applies. Shall I cancel it?"),
            message("user", "yes, please cancel"),
        ],
    )

    result = await runner(booking=booking).run(
        "initiate_cancellation", {"bookingId": BOOKING_ID, "reason": "Plans changed"}, context
    )

    assert result.outcome == "ok"
    assert booking.cancelled == [(BOOKING_ID, "Plans changed")]


@pytest.mark.asyncio
async def test_the_conversation_s_booking_id_counts_as_looked_up():
    booking = StubBooking()
    context = ToolContext(
        conversation(booking_id=UUID(BOOKING_ID)),
        [
            message("assistant", "Would you like me to cancel this booking?"),
            message("user", "confirm"),
        ],
    )

    result = await runner(booking=booking).run(
        "initiate_cancellation", {"bookingId": BOOKING_ID}, context
    )

    assert result.outcome == "ok"


@pytest.mark.asyncio
async def test_loyalty_balance_ignores_the_user_id_the_model_supplied():
    loyalty = StubLoyalty()
    context = ToolContext(conversation(), [])

    result = await runner(loyalty=loyalty).run(
        "get_loyalty_balance", {"userId": "00000000-0000-4000-8000-000000000999"}, context
    )

    assert result.outcome == "ok"
    assert loyalty.requested == [str(USER_ID)]


@pytest.mark.asyncio
async def test_a_guest_conversation_has_no_loyalty_balance():
    result = await runner().run(
        "get_loyalty_balance", {}, ToolContext(conversation(user_id=None), [])
    )
    assert result.outcome == "refused"
    assert result.result["status"] == "not_signed_in"


@pytest.mark.asyncio
async def test_escalation_sets_the_conversation_state():
    repo = StubRepo()
    context = ToolContext(conversation(), [])

    result = await runner(repo=repo).run(
        "escalate_to_human",
        {"conversationId": "whatever-the-model-said", "summary": "Wants a human"},
        context,
    )

    assert result.outcome == "ok"
    assert repo.states == [(context.conversation.id, "escalated")]
    # The real conversation id, not the model's argument.
    assert result.result["conversationId"] == str(context.conversation.id)


@pytest.mark.asyncio
async def test_an_unknown_tool_is_an_error_rather_than_a_crash():
    result = await runner().run("delete_everything", {}, ToolContext(conversation(), []))
    assert result.outcome == "error"
