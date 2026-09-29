"""Trace and Data Streams context across Kafka, injected and extracted by hand.

ddtrace 2.14 instruments `confluent_kafka` and nothing else, so the aiokafka
producers and consumers in this service are invisible to it: messages left here
carrying no headers at all, which cost two things at once. Traces stopped dead
at the publish -- a booking and the email it caused looked like unrelated
requests -- and Data Streams Monitoring had no pathway to follow, so the
topology it is supposed to draw was empty.

The Node services use kafkajs, which dd-trace does instrument, and their
messages already carry `x-datadog-*`, `traceparent` and `dd-pathway-ctx-base64`.
These helpers put the same headers on the Python side so the pipeline is
continuous rather than continuous-except-for-Python.

Switching to confluent_kafka would get this for free, but it would mean
rewriting the messaging layer of three services to buy instrumentation, and the
public checkpoint API exists precisely so that unsupported clients do not have
to.
"""

from __future__ import annotations

from typing import Any

from ddtrace import tracer
from ddtrace.data_streams import set_consume_checkpoint, set_produce_checkpoint
from ddtrace.propagation.http import HTTPPropagator


def produce_headers(topic: str) -> list[tuple[str, bytes]]:
    """Headers for a message about to be published to `topic`.

    The checkpoint is set even when no span is active. A message published from
    a background task still belongs to the pipeline, and a pathway with a hole
    in it is reported as a broken topology rather than a partial one.
    """
    carrier: dict[str, str] = {}

    span = tracer.current_span()
    if span is not None:
        HTTPPropagator.inject(span.context, carrier)

    set_produce_checkpoint("kafka", topic, carrier.__setitem__)

    return [(key, value.encode()) for key, value in carrier.items()]


def activate_consumed(record: Any) -> None:
    """Continue the producer's trace and pathway for a consumed record.

    Called before the message is handled, because activating the context
    afterwards would leave the handler's spans parented to nothing -- which is
    the exact symptom this module exists to remove.
    """
    headers = {
        key: value.decode() if isinstance(value, bytes) else value
        for key, value in (record.headers or ())
    }

    set_consume_checkpoint("kafka", record.topic, headers.get)

    # A message produced before this shipped, or by a producer that failed to
    # inject, has no context to continue. Activating the empty one would
    # detach the consumer from its own trace, so it is left alone.
    context = HTTPPropagator.extract(headers)
    if context.trace_id is not None:
        tracer.context_provider.activate(context)
