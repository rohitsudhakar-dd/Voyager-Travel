"""Support conversation API (05-FUNCTIONALITY.md § 2.7).

    POST /v1/support/conversations              -> {conversationId}
    POST /v1/support/conversations/{id}/messages -> SSE stream
    GET  /v1/support/conversations/{id}          -> full history

The stream carries three kinds of event -- tokens, tool-call events, and a final
message -- because the UI renders a visible chip per tool call, and those chips
do real explanatory work: the audience understands the trace structure before
you have switched tabs.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, AsyncIterator
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.errors import ConversationNotFoundError
from app.repo import Conversation

router = APIRouter(prefix="/v1/support", tags=["support"])


class CreateConversationRequest(BaseModel):
    userId: UUID | None = None
    bookingId: UUID | None = None


class MessageRequest(BaseModel):
    content: Annotated[str, Field(min_length=1, max_length=4_000)]


@router.post("/conversations", status_code=201)
async def create_conversation(
    body: CreateConversationRequest | None, request: Request
) -> dict:
    body = body or CreateConversationRequest()
    repo = request.app.state.repo
    conversation = await repo.create_conversation(body.userId, body.bookingId)

    request.app.state.logger.info(
        "Conversation opened",
        conversation={"id": str(conversation.id)},
        usr={"id": str(body.userId) if body.userId else None},
    )
    return {
        "conversationId": str(conversation.id),
        "state": conversation.state,
        "createdAt": conversation.created_at.isoformat(),
    }


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: UUID, request: Request) -> dict:
    repo = request.app.state.repo
    conversation = await _require(repo, conversation_id)
    messages = await repo.list_messages(
        conversation_id, request.app.state.settings.history_window
    )

    return {
        "conversationId": str(conversation.id),
        "userId": str(conversation.user_id) if conversation.user_id else None,
        "bookingId": str(conversation.booking_id) if conversation.booking_id else None,
        "state": conversation.state,
        "intent": conversation.intent,
        "createdAt": conversation.created_at.isoformat(),
        "messages": [
            {
                "id": message.id,
                "role": message.role,
                "content": message.content,
                "toolName": message.tool_name,
                "toolArgs": message.tool_args,
                "toolResult": message.tool_result,
                "createdAt": message.created_at.isoformat(),
            }
            for message in messages
        ],
    }


@router.post("/conversations/{conversation_id}/messages")
async def post_message(
    conversation_id: UUID, body: MessageRequest, request: Request
) -> StreamingResponse:
    repo = request.app.state.repo
    conversation = await _require(repo, conversation_id)
    conversations = request.app.state.conversations

    async def events() -> AsyncIterator[bytes]:
        async for event in conversations.handle_message(conversation, body.content):
            yield _frame(event["event"], event["data"])

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Buffering an SSE stream defeats the entire purpose of it.
            "X-Accel-Buffering": "no",
        },
    )


async def _require(repo, conversation_id: UUID) -> Conversation:
    conversation = await repo.get_conversation(conversation_id)
    if conversation is None:
        raise ConversationNotFoundError(
            "That conversation does not exist.", conversationId=str(conversation_id)
        )
    return conversation


def _frame(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
