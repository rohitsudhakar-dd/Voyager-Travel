"""DogStatsD business metrics for payment-service (05-FUNCTIONALITY.md § 14).

One file, like the tracer and the logger, so the whole DogStatsD integration is
readable in one sitting. Every metric name and every tag key in the service is
spelled once, here: a name spelled two ways is two metrics in Datadog and
neither of them is complete.

Three rules shape everything below.

*Nothing card-shaped.* `card_brand` and `card_last4` are the only card facts
this service is allowed to keep, and only the brand is low-cardinality enough to
be a tag. A number, a CVC or a holder name never reaches a metric, a log or a
span.

*Cardinality.* A payment id, a booking id or an amount in a metric tag is a cost
incident -- each distinct value is a billable time series, forever. They go on
spans and in logs, where they belong.

*Global tags.* `env`, `service` and `version` are appended by the client from
DD_ENV, DD_SERVICE and DD_VERSION, so no call site passes them; doing so would
send each one twice.
"""

from __future__ import annotations

from datadog.dogstatsd import DogStatsd

from app.config import get_settings

AUTHORIZED = "voyager.payment.authorized"
DECLINED = "voyager.payment.declined"
ERRORS = "voyager.payment.errors"
IDEMPOTENCY_REPLAYS = "voyager.payment.idempotency_replays"
PROVIDER_LATENCY_MS = "voyager.payment.provider_latency_ms"

# The one provider Voyager has. It matches the `payments.provider` column
# default, which is the value every payment row carries, so the tag on a
# provider call and the tag on its outcome describe the same thing.
PROVIDER = "mockpay"

_settings = get_settings()
_statsd = DogStatsd(
    host=_settings.dd_dogstatsd_host,
    port=_settings.dd_dogstatsd_port,
    # Buffering trades a syscall per metric for a delay before the Agent sees
    # anything. Off, because scenario S2 turns a decline rate up and expects the
    # graph to move within seconds.
    disable_buffering=True,
)


def authorized(payment: dict) -> None:
    _statsd.increment(
        AUTHORIZED,
        tags=[
            f"provider:{payment.get('provider') or PROVIDER}",
            f"card_brand:{payment.get('card_brand') or 'unknown'}",
        ],
    )


def declined(payment: dict) -> None:
    """A decline is a tagged business outcome, not an error (§ 13.3).

    It has its own metric for the same reason it has no span error: the SLO and
    the error rate are about whether Voyager worked, and a card that a bank
    refused is Voyager working correctly.
    """
    _statsd.increment(
        DECLINED,
        tags=[
            f"provider:{payment.get('provider') or PROVIDER}",
            f"decline_code:{payment.get('decline_code') or 'unknown'}",
        ],
    )


def errored(error_kind: str, provider: str | None = None) -> None:
    """A genuine provider failure -- unreachable, or a 4xx/5xx from the API.

    `error_kind` is the exception's class name, the same string the § 13.2
    envelope returns and the log line carries. A status code here instead would
    make "errors by kind" a chart of numbers rather than of causes.
    """
    _statsd.increment(
        ERRORS, tags=[f"provider:{provider or PROVIDER}", f"error_kind:{error_kind}"]
    )


def idempotency_replay(endpoint: str) -> None:
    """A replay served from the idempotency record rather than charged again.

    `endpoint` is the route template -- "POST /v1/payments/authorize" -- which is
    one value per route and not one per payment.
    """
    _statsd.increment(IDEMPOTENCY_REPLAYS, tags=[f"endpoint:{endpoint}"])


def provider_latency_ms(milliseconds: float, *, operation: str) -> None:
    """How long the provider took, by operation.

    Recorded for failures as well as successes: a provider that refuses a
    request after four seconds is slow and broken, and dropping those
    observations would leave it looking only broken.
    """
    _statsd.distribution(
        PROVIDER_LATENCY_MS,
        milliseconds,
        tags=[f"provider:{PROVIDER}", f"operation:{operation}"],
    )
