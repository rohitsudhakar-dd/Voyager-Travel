"""The Kafka producer.

Messages are keyed by `booking_id` so every event for one booking lands on one
partition and stays ordered -- `booking.confirmed` arriving before
`booking.created` would make the loyalty and notification consumers wrong.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from aiokafka import AIOKafkaProducer

from app import kafka_context
from app.kafka import envelope

log = structlog.get_logger()


class Producer:
    def __init__(self, brokers: str, chaos) -> None:
        self._brokers = brokers
        self._chaos = chaos
        self._producer: AIOKafkaProducer | None = None

    async def start(self) -> None:
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self._brokers,
            value_serializer=lambda value: json.dumps(value).encode(),
            key_serializer=lambda key: key.encode() if key else None,
            # `all` because losing a booking.confirmed is not recoverable
            # downstream: loyalty points and the confirmation email both hang
            # off it.
            acks="all",
            enable_idempotence=True,
        )
        await self._producer.start()

    async def stop(self) -> None:
        if self._producer is not None:
            await self._producer.stop()
            self._producer = None

    async def send(
        self,
        topic: str,
        key: str | None,
        event_type: str,
        payload: dict[str, Any],
        *,
        correlation_id: str = "",
    ) -> None:
        if self._producer is None:
            raise RuntimeError("producer is not started")

        message = envelope.build(
            event_type, payload, correlation_id=correlation_id
        )

        if self._chaos.maybe_fail("kafka_producer_error_rate"):
            # Raised rather than swallowed: a caller that cannot publish needs
            # to decide whether its transaction still stands.
            log.error(
                "Event publish failed",
                error={
                    "kind": "KafkaProducerError",
                    "message": "injected producer failure",
                },
                kafka={"topic": topic, "event_type": event_type},
            )
            raise KafkaPublishError(f"could not publish {event_type} to {topic}")

        if self._chaos.maybe_fail("kafka_poison_rate"):
            # A malformed message, not a missing one. The consumer has to
            # reject it and route it to the DLQ, which is what fills the DLQ
            # for scenario S5.
            message = {"eventType": event_type, "payload": "<<malformed>>"}

        await self._producer.send_and_wait(
            topic,
            value=message,
            key=key,
            headers=kafka_context.produce_headers(topic),
        )
        log.info(
            "Event published",
            kafka={
                "topic": topic,
                "event_type": event_type,
                "event_id": message.get("eventId", ""),
                "key": key,
            },
        )


class KafkaPublishError(Exception):
    pass
