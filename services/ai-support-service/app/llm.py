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
