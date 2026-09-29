"""Orchestration for one user message.

The shape is the span diagram in 05-FUNCTIONALITY.md § 9, and it is written as
that shape on purpose so Phase 10 can decorate it without restructuring it:

    support.handle_message
    ├── support.load_history      (Postgres)
    ├── chat.completion #1        (tool_calls returned)
    ├── tool: <name>              (booking-service / loyalty-service)
    ├── chat.completion #2        (final answer, streamed)
    └── support.persist_message   (Postgres)

Everything is yielded as it happens rather than collected and returned: the
browser needs the first token as soon as the model produces it.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from app.chaos import Chaos
from app.config import Settings
from app.errors import LlmProviderError
from app.intents import classify
from app.llm import Completion, LlmClient, Token
from app.repo import Conversation, Message, SupportRepo
from app.tools.handlers import ToolContext, ToolRunner
from app.tools.schemas import TOOL_SCHEMAS

SYSTEM_PROMPT = (
    "You are the Voyager travel support assistant. Voyager is an online travel "
    "agency selling flights and hotels. Help with bookings, changes, "
    "cancellations, baggage and refunds.\n"
    "Use the tools to fetch real booking and loyalty data; never guess a booking "
    "reference, a price, or a travel date. If a tool reports that it cannot do "
    "something, tell the traveller plainly and offer the next step.\n"
    "Be concise and warm. Never ask for card details."
)


class ConversationService:
    def __init__(
        self,
        settings: Settings,
        repo: SupportRepo,
        llm: LlmClient,
        tools: ToolRunner,
        chaos: Chaos,
        logger,
    ) -> None:
        self._settings = settings
        self._repo = repo
        self._llm = llm
        self._tools = tools
        self._chaos = chaos
        self._log = logger

    async def handle_message(
        self, conversation: Conversation, content: str
    ) -> AsyncIterator[dict[str, Any]]:
        await self._chaos.refresh()

        intent = classify(content)
        await self._repo.set_intent(conversation.id, intent)
        await self._repo.append_message(conversation.id, "user", content=content)

        history = await self._repo.list_messages(
            conversation.id, self._settings.history_window
        )
        messages = _to_wire(history)

        try:
            completion = None
            async for event in self._round(messages, tools=TOOL_SCHEMAS):
                if isinstance(event, Token):
                    yield _sse("token", {"content": event.text})
                else:
                    completion = event.completion

            assert completion is not None

            if completion.tool_calls:
                async for event in self._run_tools(
                    conversation, history, messages, completion
                ):
                    yield event

                # Second completion: the answer, with the tool result in context.
                final = None
                async for event in self._round(messages, tools=TOOL_SCHEMAS):
                    if isinstance(event, Token):
                        yield _sse("token", {"content": event.text})
                    else:
                        final = event.completion
                assert final is not None
                completion = _merge(completion, final)
            elif self._chaos.is_enabled("llm_degrade_tools"):
                # The answer will sound helpful and do nothing. That is exactly
                # the failure mode that is invisible without output monitoring,
                # so it is logged rather than repaired.
                self._log.warning(
                    "Model answered without calling a tool",
                    conversation={"id": str(conversation.id), "intent": intent},
                    llm={"model": completion.model},
                    chaos={"active_flags": ",".join(self._chaos.active_flags())},
                )

        except LlmProviderError as exc:
            self._log.error(
                "Completion failed",
                conversation={"id": str(conversation.id), "intent": intent},
                error={"kind": type(exc).__name__, "message": exc.message},
                chaos={"active_flags": ",".join(self._chaos.active_flags())},
            )
            yield _sse(
                "error",
                {
                    "error": {
                        "type": type(exc).__name__,
                        "code": exc.code,
                        "message": exc.message,
                        "details": exc.details,
                    }
                },
            )
            return

        message_id = await self._repo.append_message(
            conversation.id,
            "assistant",
            content=completion.content,
            tokens_prompt=completion.prompt_tokens,
            tokens_completion=completion.completion_tokens,
            latency_ms=completion.latency_ms,
        )

        self._log.info(
            "Support message answered",
            conversation={"id": str(conversation.id), "intent": intent},
            llm={
                "model": completion.model,
                "prompt_tokens": completion.prompt_tokens,
                "completion_tokens": completion.completion_tokens,
                "first_token_ms": completion.first_token_ms,
                "latency_ms": completion.latency_ms,
            },
            chaos={"active_flags": ",".join(self._chaos.active_flags())},
        )

        yield _sse(
            "message",
            {
                "messageId": message_id,
                "role": "assistant",
                "content": completion.content,
                "intent": intent,
                "usage": {
                    "promptTokens": completion.prompt_tokens,
                    "completionTokens": completion.completion_tokens,
                },
            },
        )

        refreshed = await self._repo.get_conversation(conversation.id)
        yield _sse(
            "done",
            {
                "conversationId": str(conversation.id),
                "state": refreshed.state if refreshed else conversation.state,
            },
        )

    # ------------------------------------------------------------------ helpers

    def _round(self, messages: list[dict[str, Any]], *, tools):
        return self._llm.stream(messages, tools=tools)

    async def _run_tools(
        self,
        conversation: Conversation,
        history: list[Message],
        messages: list[dict[str, Any]],
        completion: Completion,
    ) -> AsyncIterator[dict[str, Any]]:
        messages.append(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": json.dumps(call.arguments),
                        },
                    }
                    for call in completion.tool_calls
                ],
            }
        )

        context = ToolContext(conversation=conversation, history=history)

        for call in completion.tool_calls:
            yield _sse("tool_call", {"tool": call.name, "args": call.arguments})

            result = await self._tools.run(call.name, call.arguments, context)

            await self._repo.append_message(
                conversation.id,
                "tool",
                content=None,
                tool_name=call.name,
                tool_args=call.arguments,
                tool_result=result.result,
            )
            # Appended to the in-memory history too, so a second tool call in the
            # same turn can see what the first one found.
            history.append(
                Message(
                    id=0,
                    role="tool",
                    content=None,
                    tool_name=call.name,
                    tool_args=call.arguments,
                    tool_result=result.result,
                    tokens_prompt=None,
                    tokens_completion=None,
                    latency_ms=None,
                    created_at=conversation.updated_at,
                )
            )

            log = self._log.warning if result.outcome != "ok" else self._log.info
            log(
                "Tool call completed",
                conversation={"id": str(conversation.id)},
                tool={"name": call.name, "outcome": result.outcome},
                chaos={"active_flags": ",".join(self._chaos.active_flags())},
            )

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result.result),
                }
            )
            yield _sse(
                "tool_result",
                {
                    "tool": call.name,
                    "outcome": result.outcome,
                    "result": result.result,
                },
            )


def _sse(event: str, data: dict[str, Any]) -> dict[str, Any]:
    return {"event": event, "data": data}


def _merge(first: Completion, second: Completion) -> Completion:
    """One user message, two completions, one set of totals.

    Token counts are summed because the cost of answering was the cost of both
    calls -- reporting only the second would understate every tool-using turn.
    """
    return Completion(
        content=second.content or first.content,
        tool_calls=first.tool_calls,
        finish_reason=second.finish_reason,
        model=second.model or first.model,
        prompt_tokens=first.prompt_tokens + second.prompt_tokens,
        completion_tokens=first.completion_tokens + second.completion_tokens,
        latency_ms=first.latency_ms + second.latency_ms,
        first_token_ms=first.first_token_ms or second.first_token_ms,
    )


def _to_wire(history: list[Message]) -> list[dict[str, Any]]:
    """Persisted history in OpenAI wire form.

    Tool results from *earlier* turns become system notes rather than `tool`
    messages: a `tool` message is only valid immediately after the assistant
    message that requested it, and reconstructing that pairing across turns would
    be a lot of machinery for context a note carries just as well.
    """
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]

    for message in history:
        if message.role in ("user", "assistant") and message.content:
            messages.append({"role": message.role, "content": message.content})
        elif message.role == "tool" and message.tool_name:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        f"Earlier result of {message.tool_name}: "
                        f"{json.dumps(message.tool_result)}"
                    ),
                }
            )

    return messages
