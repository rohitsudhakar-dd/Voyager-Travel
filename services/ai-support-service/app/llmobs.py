"""LLM Observability (03-EXECUTION-ORDER.md phase 10, item 9).

Everything this service tells LLM Observability is spelled once, here: where
the product is switched on, how a span of each kind is opened and annotated,
and what a token costs. A tag or a metric key spelled two ways is two facets
in Datadog and neither of them is complete.

Four things about the wiring are not obvious and are all load-bearing.

**`enable_llmobs()` runs at import of `app.main`, not in the lifespan.**
`LLMObs.enable()` ends in `tracer.configure()`, which rebuilds the tracer's
span processors. A trace in flight while that happens finishes against an
aggregator that never saw it start, and is dropped -- no span, no error, no log
line above debug. At import the interpreter is still single-threaded and
uvicorn has not bound the port, so there is nothing in flight to lose.

**The openai integration is switched off** (`DD_TRACE_OPENAI_ENABLED=false` in
Compose, and `integrations_enabled=False` here so `enable()` does not patch it
back). Once LLM Observability is on, that integration emits an `llm` span of
its own for every completion. Left on, each model call would appear twice and
every token and cost figure in the product would read double, which is a worse
failure than the missing `openai.request` span -- the hop to mock-llm is still
traced by the httpx integration underneath it.

That is also why `DD_LLMOBS_ENABLED` is left empty in Compose rather than set
to true. A truthy value makes `ddtrace/bootstrap/preload.py` call
`LLMObs.enable()` before the app is imported, with integrations on: it patches
openai explicitly, which bypasses `DD_TRACE_OPENAI_ENABLED` entirely, and the
call below then returns early because the product is already enabled. Every
completion appears twice and nothing anywhere says why.

**Nothing here may assume the product is on.** `LLMObs.enable()` returns
quietly when `DD_LLMOBS_ENABLED` is falsy, and `LLMObs.llm()` and
`LLMObs.annotate()` then dereference an instance that was never built. A
support chat that crashes because observability is off is not a trade anyone
would make, so every entry point below is guarded and degrades to no span.

**Whether it actually came up is logged at boot.** Silence is the documented
behaviour of every failure mode here, so the state is asserted out loud rather
than inferred later from an empty page in Datadog.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from functools import wraps
from typing import Any, Callable, Iterator

from ddtrace import tracer
from ddtrace.constants import ERROR_MSG, ERROR_TYPE
from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import tool

from app.config import Settings

_MILLION = 1_000_000


def enable_llmobs(settings: Settings, logger) -> None:
    LLMObs.enable(
        ml_app=settings.dd_llmobs_ml_app,
        integrations_enabled=False,
        agentless_enabled=False,
    )
    logger.info(
        "LLM Observability configured",
        llmobs={"enabled": LLMObs.enabled, "ml_app": settings.dd_llmobs_ml_app},
    )


def estimate_cost_usd(
    settings: Settings, prompt_tokens: int, completion_tokens: int
) -> float:
    """Cost of one completion, at a tariff Voyager makes up.

    Datadog derives no cost for a model it has never heard of, and
    `voyager-support-v1` is invented, so the price is ours to state. The two
    defaults are the same constants the "Estimated cost per hour" widget in
    datadog/dashboards/d6-ai-support.json applies to `voyager.support.tokens`.
    A dashboard and a span that disagree about the price of a token are worse
    than either of them alone.
    """
    return (
        prompt_tokens * settings.llm_cost_input_usd_per_million
        + completion_tokens * settings.llm_cost_output_usd_per_million
    ) / _MILLION


# ------------------------------------------------------------------- spans


@contextmanager
def workflow_span(name: str) -> Iterator[Any]:
    """The turn, end to end. One per user message."""
    if not LLMObs.enabled:
        yield None
        return
    with LLMObs.workflow(name=name) as span:
        yield span


@contextmanager
def llm_span(name: str, *, model_name: str, model_provider: str) -> Iterator[Any]:
    """One model call.

    A context manager rather than the `@llm` decorator because the call it
    wraps is an async generator -- tokens are forwarded to the browser as they
    arrive, and `support_first_token` can only be honest if nothing buffers.
    The decorator's `iscoroutinefunction` check is false for a generator
    function, so it would open and close the span around the *creation* of the
    generator and time nothing at all.
    """
    if not LLMObs.enabled:
        yield None
        return
    with LLMObs.llm(
        model_name=model_name, model_provider=model_provider, name=name
    ) as span:
        yield span


def record_dropped_tool_call(name: str, *, intent: str, reason: str) -> None:
    """A tool call the model was expected to make and did not.

    This is the `llm_degrade_tools` shape. mock-llm answers in prose instead of
    emitting a tool call, so no tool ever runs, and the chain would otherwise
    record the failure as the *absence* of a step -- legible only to someone
    who already knows what the chain looks like when it works. Writing the drop
    down as a failed `tool` span puts it where a tool failure is looked for.

    The span is instantaneous because nothing ran. That is the point of it.
    """
    if not LLMObs.enabled:
        return
    with LLMObs.tool(name=name) as span:
        annotate(
            span=span, input_data={"intent": intent}, output_data={"reason": reason}
        )
        mark_error(span, "DroppedToolCallError", reason)


def annotate(**kwargs: Any) -> None:
    if not LLMObs.enabled:
        return
    LLMObs.annotate(**kwargs)


def mark_error(span, kind: str, message: str) -> None:
    """Fail a span with a constant message.

    Both strings are constants for the same reason the typed exceptions in
    errors.py are: interpolate a conversation id into either and Error Tracking
    groups one issue per request instead of one per fault.
    """
    if span is None:
        return
    span.error = 1
    span.set_tag_str(ERROR_TYPE, kind)
    span.set_tag_str(ERROR_MSG, message)


def tool_span(name: str) -> Callable:
    """Wrap a tool handler in an LLM Observability `tool` span.

    The name is the tool's own, so the span reads `lookup_booking` rather than
    the private method behind it (05-FUNCTIONALITY.md § 9). Arguments and
    results are annotated by hand because the automatic annotation would
    serialise `self` and the entire conversation context alongside them.
    """

    def decorate(func):
        async def annotated(self, args, context):
            annotate(input_data=redact(args))
            result = await func(self, args, context)
            annotate(output_data=redact(result.result), tags={"outcome": result.outcome})
            if result.outcome == "error":
                # `refused` and `not_found` are answers the model is expected to
                # relay, not failures. Only `error` is a call that broke.
                mark_error(
                    tracer.current_span(),
                    "ToolCallError",
                    "The tool call did not complete.",
                )
            return result

        return tool(name=name, _automatic_io_annotation=False)(wraps(func)(annotated))

    return decorate


# ---------------------------------------------------------------- APM tags


def tag_root(tags: dict[str, Any]) -> None:
    """Tag the request's local root span, dropping values that are absent.

    The root rather than the current span: a tag on a leaf can only be found by
    someone who already knows which leaf to open, while on the root it is a
    facet the APM trace list can be filtered by.
    """
    root = tracer.current_root_span()
    if root is None:
        return
    for key, value in tags.items():
        if value not in (None, ""):
            root.set_tag_str(key, str(value))


# --------------------------------------------------------------- redaction

# Datadog is the right place for a prompt and the wrong place for a card
# number. The assistant is told never to ask for one, but a traveller can
# volunteer one unprompted, and from then on it is in the history every later
# turn replays. Digit runs of card length are masked on the way into a span
# annotation; nothing else about the text is touched.
_CARD_LIKE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return _CARD_LIKE.sub("[redacted]", value)
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value
