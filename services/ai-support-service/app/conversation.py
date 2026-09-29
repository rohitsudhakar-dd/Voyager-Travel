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
import re
from typing import Any, AsyncIterator

from ddtrace.llmobs.decorators import retrieval, task

from app import metrics
from app.chaos import Chaos
from app.config import Settings
from app.errors import LlmProviderError
from app.intents import classify
from app.llm import Completion, LlmClient, Token
from app.llmobs import (
    annotate,
    record_dropped_tool_call,
    redact,
    tag_root,
    workflow_span,
)
from app.repo import Conversation, Message, SupportRepo
from app.tools.handlers import ToolContext, ToolRunner, known_pnrs
from app.tools.schemas import ESCALATE_TO_HUMAN, TOOL_SCHEMAS

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
        # On the root span, not on the workflow span: a trace list can be
        # filtered by a root tag and cannot be filtered by a child's.
        tag_root(
            {
                "usr.id": conversation.user_id,
                "support.conversation_id": conversation.id,
                "support.intent": intent,
                "llm.model": self._llm.model,
                "chaos.active_flags": ",".join(self._chaos.active_flags()),
            }
        )

        with workflow_span("support.handle_message") as workflow:
            annotate(span=workflow, input_data=redact(content))

            # Before set_intent overwrites it: a conversation with no intent yet
            # has never had a message, so this is the turn that opened it. § 14
            # wants one count per conversation, not one per turn.
            if conversation.intent is None:
                metrics.conversation_started(intent)

            await self._repo.set_intent(conversation.id, intent)
            await self._repo.append_message(conversation.id, "user", content=content)

            history = await self._load_history(conversation.id)
            messages = _to_wire(history)

            try:
                completion = None
                async for event in self._round(messages, round_number=1):
                    if isinstance(event, Token):
                        yield _sse("token", {"content": event.text})
                    else:
                        completion = event.completion

                assert completion is not None

                if completion.tool_calls:
                    async for event in self._run_tools(
                        conversation, history, messages, completion, intent
                    ):
                        yield event

                    # Second completion: the answer, with the tool result in context.
                    final = None
                    async for event in self._round(messages, round_number=2):
                        if isinstance(event, Token):
                            yield _sse("token", {"content": event.text})
                        else:
                            final = event.completion
                    assert final is not None
                    completion = _merge(completion, final)
                elif self._chaos.is_enabled("llm_degrade_tools") and intent != "general":
                    # The answer will sound helpful and do nothing. That is
                    # exactly the failure mode that is invisible without output
                    # monitoring, so it is recorded rather than repaired.
                    #
                    # `general` is excluded because no tool was owed: there is
                    # nothing to look up for "what can you help me with".
                    record_dropped_tool_call(
                        "support.tool_call_dropped",
                        intent=intent,
                        reason=_DROPPED_TOOL_REASON,
                    )
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

            message_id = await self._persist_answer(conversation.id, completion)

            # After _merge, so a tool-using turn reports the cost of both
            # completions rather than only the second.
            metrics.tokens(
                prompt=completion.prompt_tokens,
                completion=completion.completion_tokens,
                model=completion.model or self._llm.model,
            )

            invented = _unverified_references(completion.content, history)
            if invented:
                # The `llm_hallucinate` signature, detected without reference to
                # the flag: an answer quoting a booking reference that no tool
                # call returned did not get it from the database. Nothing is
                # rewritten -- the flag exists to show that output quality is
                # invisible to latency and error monitors, and repairing it here
                # would delete the demo.
                annotate(
                    span=workflow,
                    tags={"answer_quality": "unverified_booking_reference"},
                )
                self._log.warning(
                    "Answer cites a booking reference no tool returned",
                    conversation={"id": str(conversation.id), "intent": intent},
                    llm={"model": completion.model},
                    chaos={"active_flags": ",".join(self._chaos.active_flags())},
                )

            annotate(span=workflow, output_data=redact(completion.content))

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

    def _round(self, messages: list[dict[str, Any]], *, round_number: int):
        return self._llm.stream(
            messages, tools=TOOL_SCHEMAS, round_number=round_number
        )

    @retrieval(name="support.load_history", _automatic_io_annotation=False)
    async def _load_history(self, conversation_id) -> list[Message]:
        """The turn's context, fetched from Postgres.

        A `retrieval` span rather than a plain one because that is what it is:
        the store is relational instead of vector, but the step answers the
        same question -- which prior turns are worth putting in front of the
        model (05-FUNCTIONALITY.md § 9).
        """
        history = await self._repo.list_messages(
            conversation_id, self._settings.history_window
        )
        annotate(
            input_data=str(conversation_id),
            output_data=[
                {
                    "id": str(message.id),
                    "name": message.tool_name or message.role,
                    "text": redact(_document_text(message)),
                }
                for message in history
            ],
        )
        return history

    @task(name="support.persist_message", _automatic_io_annotation=False)
    async def _persist_answer(self, conversation_id, completion: Completion) -> int:
        return await self._repo.append_message(
            conversation_id,
            "assistant",
            content=completion.content,
            tokens_prompt=completion.prompt_tokens,
            tokens_completion=completion.completion_tokens,
            latency_ms=completion.latency_ms,
        )

    async def _run_tools(
        self,
        conversation: Conversation,
        history: list[Message],
        messages: list[dict[str, Any]],
        completion: Completion,
        intent: str,
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

            metrics.tool_call(tool=call.name, outcome=result.outcome)
            # Only a successful escalation. A refused one means the handler's
            # gate held, which is the opposite of a conversation reaching a
            # human.
            if call.name == ESCALATE_TO_HUMAN and result.outcome == "ok":
                metrics.escalation(intent)

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


_DROPPED_TOOL_REASON = (
    "The model answered in prose where a tool call belonged, so no tool ran."
)

# The PNR alphabet, which excludes 0, 1, I and O (03-EXECUTION-ORDER.md phase 5).
_PNR_SHAPED = re.compile(r"\b([A-HJ-NP-Z2-9]{6})\b")


def _unverified_references(content: str | None, history: list[Message]) -> list[str]:
    """Booking references in an answer that no tool call produced."""
    if not content:
        return []
    known = known_pnrs(history)
    return sorted({pnr for pnr in _PNR_SHAPED.findall(content) if pnr not in known})


def _document_text(message: Message) -> str:
    if message.content:
        return message.content
    if message.tool_name:
        return f"{message.tool_name}: {json.dumps(message.tool_result)}"
    return ""


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
