"""The LLM client: the stock `openai` async client pointed at `LLM_BASE_URL`.

Using the real client rather than hand-rolled HTTP is the point. mock-llm speaks
the OpenAI wire format including SSE framing and tool calls, so swapping in a
real provider is one environment variable and no code
(05-FUNCTIONALITY.md § 5.4).

Streaming is exposed as an async generator of events so the caller can forward
tokens to the browser as they arrive -- `support_first_token` is one of the
custom RUM timings, and it can only be honest if nothing buffers here.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import openai

from app.config import Settings
from app.errors import LlmProviderError
from app.llmobs import annotate, estimate_cost_usd, llm_span, redact


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Completion:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0
    first_token_ms: int | None = None


@dataclass(frozen=True)
class Token:
    text: str


@dataclass(frozen=True)
class Done:
    completion: Completion


LlmEvent = Token | Done


class LlmClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = openai.AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            timeout=settings.llm_timeout_seconds,
            # No client-side retries: `llm_error_rate` should show up as exactly
            # that error rate in APM. A retrying client would hide the flag it is
            # there to demonstrate.
            max_retries=0,
        )

    @property
    def model(self) -> str:
        return self._settings.llm_model

    async def stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        round_number: int = 1,
    ) -> AsyncIterator[LlmEvent]:
        with llm_span(
            "chat.completion",
            model_name=self._settings.llm_model,
            model_provider=self._settings.llm_provider,
        ) as span:
            async for event in self._stream(messages, tools=tools):
                if isinstance(event, Done):
                    _annotate_completion(
                        span, self._settings, messages, event.completion, round_number
                    )
                yield event

    async def _stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[LlmEvent]:
        started = time.monotonic()
        first_token_at: float | None = None
        content: list[str] = []
        partial: dict[int, dict[str, str]] = {}
        finish_reason: str | None = None
        prompt_tokens = 0
        completion_tokens = 0
        model = self._settings.llm_model

        try:
            stream = await self._client.chat.completions.create(
                model=self._settings.llm_model,
                messages=messages,  # type: ignore[arg-type]
                tools=tools,  # type: ignore[arg-type]
                stream=True,
                stream_options={"include_usage": True},
            )

            async for chunk in stream:
                if chunk.model:
                    model = chunk.model
                if chunk.usage is not None:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens

                for choice in chunk.choices:
                    if choice.finish_reason:
                        finish_reason = choice.finish_reason
                    delta = choice.delta
                    if delta is None:
                        continue

                    if delta.content:
                        if first_token_at is None:
                            first_token_at = time.monotonic()
                        content.append(delta.content)
                        yield Token(delta.content)

                    for fragment in delta.tool_calls or []:
                        # Arguments may arrive split across chunks, so they are
                        # accumulated by index rather than assumed whole.
                        slot = partial.setdefault(
                            fragment.index, {"id": "", "name": "", "arguments": ""}
                        )
                        if fragment.id:
                            slot["id"] = fragment.id
                        if fragment.function is not None:
                            if fragment.function.name:
                                slot["name"] = fragment.function.name
                            if fragment.function.arguments:
                                slot["arguments"] += fragment.function.arguments

        except openai.OpenAIError as exc:
            raise LlmProviderError(
                "The assistant is temporarily unavailable.",
                provider=self._settings.llm_provider,
                model=self._settings.llm_model,
                cause=type(exc).__name__,
            ) from exc

        yield Done(
            Completion(
                content="".join(content),
                tool_calls=[
                    ToolCall(
                        id=slot["id"],
                        name=slot["name"],
                        arguments=_arguments(slot["arguments"]),
                    )
                    for _, slot in sorted(partial.items())
                    if slot["name"]
                ],
                finish_reason=finish_reason,
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                latency_ms=int((time.monotonic() - started) * 1000),
                first_token_ms=(
                    int((first_token_at - started) * 1000)
                    if first_token_at is not None
                    else None
                ),
            )
        )

    async def ping(self) -> None:
        await self._client.models.list()

    async def close(self) -> None:
        await self._client.close()


def _annotate_completion(
    span,
    settings: Settings,
    messages: list[dict[str, Any]],
    completion: Completion,
    round_number: int,
) -> None:
    """What LLM Observability shows for one model call.

    `total_cost` is estimated rather than measured, because the provider is
    invented and bills nobody. It is annotated anyway: a chain whose token
    counts are visible but whose cost is not makes the one question an LLM bill
    provokes -- which conversations are expensive -- unanswerable in the
    product that exists to answer it.
    """
    annotate(
        span=span,
        input_data=redact(_as_messages(messages)),
        output_data=redact(_answer_of(completion)),
        metadata={
            "round": round_number,
            "streamed": True,
            "finish_reason": completion.finish_reason,
            "tool_calls": [call.name for call in completion.tool_calls],
        },
        metrics={
            "input_tokens": completion.prompt_tokens,
            "output_tokens": completion.completion_tokens,
            "total_tokens": completion.prompt_tokens + completion.completion_tokens,
            "total_cost": estimate_cost_usd(
                settings, completion.prompt_tokens, completion.completion_tokens
            ),
            # Seconds, as the LLM Observability schema defines it. This is the
            # number `llm_latency_ms` moves, and the one the browser feels.
            "time_to_first_token": (completion.first_token_ms or 0) / 1000,
        },
    )


def _as_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """The wire messages in the shape LLM Observability accepts.

    A tool-call turn carries `content: null` and its payload in `tool_calls`,
    which the annotation rejects as a non-string content. Rendering the request
    as text keeps the turn in the conversation rather than dropping the one
    message that explains why a tool ran.
    """
    rendered = []
    for message in messages:
        content = message.get("content")
        if not isinstance(content, str):
            calls = message.get("tool_calls") or []
            content = " ".join(
                f"[tool call] {call['function']['name']}({call['function']['arguments']})"
                for call in calls
            )
        rendered.append({"role": str(message.get("role", "")), "content": content})
    return rendered


def _answer_of(completion: Completion) -> list[dict[str, str]]:
    if completion.tool_calls:
        return [
            {
                "role": "assistant",
                "content": " ".join(
                    f"[tool call] {call.name}({json.dumps(call.arguments)})"
                    for call in completion.tool_calls
                ),
            }
        ]
    return [{"role": "assistant", "content": completion.content}]


def _arguments(raw: str) -> dict[str, Any]:
    """A model that emits unparseable arguments is a tool-call failure, not a
    crash: the handler decides what a missing argument means."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}
