"""DogStatsD business metrics for ai-support-service
(05-FUNCTIONALITY.md § 14).

One file, like the tracer and the logger, so the whole DogStatsD integration is
readable in one sitting. Every metric name and every tag key in the service is
spelled once, here: a name spelled two ways is two metrics in Datadog and
neither of them is complete.

Two rules from § 14 shape everything below.

*Cardinality.* A conversation id, a user id or a PNR in a metric tag is a cost
incident -- each distinct value is a billable time series, forever. `intent`,
`tool`, `outcome`, `direction` and `model` are all fixed, short lists; nothing
here takes a message, an identifier or anything the model wrote. The
conversation id goes on the span and in the log line.

*Global tags.* `env`, `service` and `version` are appended by the client from
DD_ENV, DD_SERVICE and DD_VERSION, so no call site passes them; doing so would
send each one twice.

There is no cost metric here on purpose. § 14 does not define one, and
datadog/dashboards/d6-ai-support.json derives cost on the widget from
`voyager.support.tokens` at a stated tariff. Voyager talks to a mock model, so
any tariff is arbitrary; one arbitrary constant in a dashboard formula is easier
to correct than a second metric that looks measured.
"""

from __future__ import annotations

from datadog.dogstatsd import DogStatsd

from app.config import get_settings

CONVERSATIONS = "voyager.support.conversations"
TOOL_CALLS = "voyager.support.tool_calls"
TOKENS = "voyager.support.tokens"
ESCALATIONS = "voyager.support.escalations"

# Prompt and completion, in Datadog's own LLM Observability vocabulary, which is
# what the token widgets on d6-ai-support.json already query.
INPUT = "input"
OUTPUT = "output"

_settings = get_settings()
_statsd = DogStatsd(
    host=_settings.dd_dogstatsd_host,
    port=_settings.dd_dogstatsd_port,
    # Buffering trades a syscall per metric for a delay before the Agent sees
    # anything. Off, because `llm_degrade_tools` is demonstrated by watching the
    # tool-call success rate fall within seconds of the toggle.
    disable_buffering=True,
)


def conversation_started(intent: str) -> None:
    """One conversation, tagged with the intent it opened on.

    Counted on the conversation's first message rather than when the row is
    created, because until somebody says something there is no intent to tag it
    with -- and an `intent:unknown` bucket the size of the whole metric would
    make the breakdown useless.
    """
    _statsd.increment(CONVERSATIONS, tags=[f"intent:{intent}"])


def tool_call(*, tool: str, outcome: str) -> None:
    _statsd.increment(TOOL_CALLS, tags=[f"tool:{tool}", f"outcome:{outcome}"])


def tokens(*, prompt: int, completion: int, model: str) -> None:
    """Token counts for one answered turn.

    Both directions, because the cost asymmetry between them is the whole point:
    a prompt that grows with the conversation history and a completion that does
    not are two different problems with two different fixes.
    """
    if prompt:
        _statsd.distribution(
            TOKENS, prompt, tags=[f"direction:{INPUT}", f"model:{model}"]
        )
    if completion:
        _statsd.distribution(
            TOKENS, completion, tags=[f"direction:{OUTPUT}", f"model:{model}"]
        )


def escalation(intent: str) -> None:
    """A conversation handed to a human.

    Tagged with the intent, so "which questions we cannot answer" is a single
    query rather than a manual read of transcripts.
    """
    _statsd.increment(ESCALATIONS, tags=[f"intent:{intent}"])
