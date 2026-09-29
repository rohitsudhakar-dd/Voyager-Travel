"""Persistence for `support_conversations` and `support_messages`.

ai-support-service owns both tables and is the only writer of either
(05-FUNCTIONALITY.md § 1). It owns no others: a booking change goes to
booking-service over HTTP, never to the bookings table.

Raw SQL through SQLAlchemy's async engine, because the schema lives in
booking-service's migrations as raw DDL and there is no declarative metadata to
mirror it from.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


@dataclass(frozen=True)
class Conversation:
    id: UUID
    user_id: UUID | None
    booking_id: UUID | None
    state: str
    intent: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class Message:
    id: int
    role: str
    content: str | None
    tool_name: str | None
    tool_args: dict[str, Any] | None
    tool_result: dict[str, Any] | None
    tokens_prompt: int | None
    tokens_completion: int | None
    latency_ms: int | None
    created_at: datetime


class SupportRepo:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def ping(self) -> None:
        async with self._engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def create_conversation(
        self, user_id: UUID | None, booking_id: UUID | None
    ) -> Conversation:
        conversation_id = uuid4()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    text(
                        """
                        INSERT INTO voyager.support_conversations
                            (id, user_id, booking_id, state)
                        VALUES (:id, :user_id, :booking_id, 'open')
                        RETURNING id, user_id, booking_id, state, intent,
                                  created_at, updated_at
                        """
                    ),
                    {
                        "id": conversation_id,
                        "user_id": user_id,
                        "booking_id": booking_id,
                    },
                )
            ).one()
        return _conversation(row)

    async def get_conversation(self, conversation_id: UUID) -> Conversation | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    text(
                        """
                        SELECT id, user_id, booking_id, state, intent,
                               created_at, updated_at
                          FROM voyager.support_conversations
                         WHERE id = :id
                        """
                    ),
                    {"id": conversation_id},
                )
            ).one_or_none()
        return _conversation(row) if row is not None else None

    async def list_messages(self, conversation_id: UUID, limit: int) -> list[Message]:
        """Oldest first, capped at the last `limit` turns.

        The window is applied in SQL rather than in Python so a long-running
        conversation does not grow the prompt without bound.
        """
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        """
                        SELECT * FROM (
                            SELECT id, role, content, tool_name, tool_args, tool_result,
                                   tokens_prompt, tokens_completion, latency_ms, created_at
                              FROM voyager.support_messages
                             WHERE conversation_id = :conversation_id
                             ORDER BY created_at DESC, id DESC
                             LIMIT :limit
                        ) recent
                        ORDER BY created_at ASC, id ASC
                        """
                    ),
                    {"conversation_id": conversation_id, "limit": limit},
                )
            ).all()
        return [_message(row) for row in rows]

    async def append_message(
        self,
        conversation_id: UUID,
        role: str,
        *,
        content: str | None = None,
        tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None,
        tool_result: dict[str, Any] | None = None,
        tokens_prompt: int | None = None,
        tokens_completion: int | None = None,
        latency_ms: int | None = None,
        trace_id: str | None = None,
    ) -> int:
        async with self._engine.begin() as conn:
            message_id = (
                await conn.execute(
                    text(
                        """
                        INSERT INTO voyager.support_messages
                            (conversation_id, role, content, tool_name,
                             tool_args, tool_result, tokens_prompt,
                             tokens_completion, latency_ms, trace_id)
                        VALUES
                            (:conversation_id, :role, :content, :tool_name,
                             CAST(:tool_args AS JSONB), CAST(:tool_result AS JSONB),
                             :tokens_prompt, :tokens_completion, :latency_ms, :trace_id)
                        RETURNING id
                        """
                    ),
                    {
                        "conversation_id": conversation_id,
                        "role": role,
                        "content": content,
                        "tool_name": tool_name,
                        "tool_args": _json(tool_args),
                        "tool_result": _json(tool_result),
                        "tokens_prompt": tokens_prompt,
                        "tokens_completion": tokens_completion,
                        "latency_ms": latency_ms,
                        "trace_id": trace_id,
                    },
                )
            ).scalar_one()
            await conn.execute(
                text(
                    """
                    UPDATE voyager.support_conversations
                       SET updated_at = now()
                     WHERE id = :id
                    """
                ),
                {"id": conversation_id},
            )
        return int(message_id)

    async def set_intent(self, conversation_id: UUID, intent: str) -> None:
        """First intent wins: it is what the conversation was opened about, and a
        stable value is what makes it usable as a metric tag."""
        async with self._engine.begin() as conn:
            await conn.execute(
                text(
                    """
                    UPDATE voyager.support_conversations
                       SET intent = :intent, updated_at = now()
                     WHERE id = :id AND intent IS NULL
                    """
                ),
                {"id": conversation_id, "intent": intent},
            )

    async def set_state(self, conversation_id: UUID, state: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                text(
                    """
                    UPDATE voyager.support_conversations
                       SET state = :state, updated_at = now()
                     WHERE id = :id
                    """
                ),
                {"id": conversation_id, "state": state},
            )


def _json(value: dict[str, Any] | None) -> str | None:
    return None if value is None else json.dumps(value)


def _conversation(row: Any) -> Conversation:
    return Conversation(
        id=row.id,
        user_id=row.user_id,
        booking_id=row.booking_id,
        state=row.state,
        intent=row.intent,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _message(row: Any) -> Message:
    return Message(
        id=row.id,
        role=row.role,
        content=row.content,
        tool_name=row.tool_name,
        tool_args=row.tool_args,
        tool_result=row.tool_result,
        tokens_prompt=row.tokens_prompt,
        tokens_completion=row.tokens_completion,
        latency_ms=row.latency_ms,
        created_at=row.created_at,
    )
