"""DogStatsD business metrics for notification-worker
(05-FUNCTIONALITY.md § 14).

One file, like the tracer and the logger, so the whole DogStatsD integration is
readable in one sitting. Every metric name and every tag key in the service is
spelled once, here: a name spelled two ways is two metrics in Datadog and
neither of them is complete.

Two rules from § 14 shape everything below.

*Cardinality.* A recipient address in a metric tag would be one billable time
series per traveller, forever -- and an email address on a metric is a privacy
problem on top of a cost one. `template` is a fixed set of names; the address
goes in the log line and on the span.

*Global tags.* `env`, `service` and `version` are appended by the client from
DD_ENV, DD_SERVICE and DD_VERSION, so no call site passes them; doing so would
send each one twice.
"""

from __future__ import annotations

import time

from datadog.dogstatsd import DogStatsd

from app.config import get_settings

SENT = "voyager.notifications.sent"
DLQ = "voyager.notifications.dlq"
LAG_SECONDS = "voyager.notifications.lag_seconds"

# A message that could not be parsed has no template, and a dead-letter counted
# without one would silently drop out of a "by template" breakdown.
UNKNOWN_TEMPLATE = "unknown"

_settings = get_settings()
_statsd = DogStatsd(
    host=_settings.dd_dogstatsd_host,
    port=_settings.dd_dogstatsd_port,
    # Buffering trades a syscall per metric for a delay before the Agent sees
    # anything. Off, because `kafka_consumer_pause` is demonstrated by watching
    # the lag gauge move, and a buffered gauge is a gauge that moves late.
    disable_buffering=True,
)


def sent(template: str | None) -> None:
    _statsd.increment(SENT, tags=[f"template:{template or UNKNOWN_TEMPLATE}"])


def dead_lettered(template: str | None, failure_reason: str | None) -> None:
    """One dead-letter, classified by why.

    `failure_reason` is deliberately not the Outcome's own string: that carries
    the provider's message interpolated into it, which is unbounded and would put
    one time series on the bill per distinct error text. Only the classification
    in front of the colon is kept -- `rejected_by_provider`,
    `provider_unavailable`, `malformed_message` -- which is the part that says
    what to do about it. The full text stays in the log line and in the DLQ
    record.
    """
    _statsd.increment(
        DLQ,
        tags=[
            f"template:{template or UNKNOWN_TEMPLATE}",
            f"failure_reason:{classify_failure(failure_reason)}",
        ],
    )


def classify_failure(failure_reason: str | None) -> str:
    if not failure_reason:
        return "unknown"
    return failure_reason.split(":", 1)[0].strip() or "unknown"


def lag_seconds(*, produced_at_ms: int | None, consumer_group: str) -> None:
    """How far behind the group is, measured on the message just handled.

    Kafka's own consumer lag is a count of messages and the Agent's Kafka check
    already reports it. This is the same question in the unit an operator
    actually cares about: a backlog of 500 messages means nothing without
    knowing how fast they drain, but "the oldest thing we are working on was
    produced ninety seconds ago" needs no context at all.

    A gauge, not a distribution: § 14 says gauge, and the last value is the
    honest one -- the lag now, not the average lag over the flush interval.
    """
    if not produced_at_ms or produced_at_ms <= 0:
        return
    age = time.time() - (produced_at_ms / 1000)
    # A clock skew between broker and consumer can make this negative, and a
    # negative lag on a graph is worse than a missing point.
    _statsd.gauge(
        LAG_SECONDS, max(age, 0.0), tags=[f"consumer_group:{consumer_group}"]
    )
