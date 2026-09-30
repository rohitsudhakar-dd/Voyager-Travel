"""Kafka consumer for `voyager-notifications-v1`.

Subscribes to the four topics in § 6 that carry something worth emailing, and is
the only producer of `voyager.notifications.dlq`.

Offsets are committed manually, after the message has been either delivered or
dead-lettered. That is what makes both exit criteria hold at once: a poison
message never blocks the partition, and a worker that was killed for two minutes
resumes from its committed offset with nothing lost.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.structs import ConsumerRecord

from app import config as topics
from app import kafka_context
from app import metrics
from app.chaos import Chaos
from app.config import Settings
from app.delivery import Deliverer, Outcome
from app.email_client import EmailClient

POLL_TIMEOUT_MS = 1_000
PAUSE_POLL_SECONDS = 1.0
ATTACH_RETRY_SECONDS = 10.0


class NotificationConsumer:
    def __init__(self, settings: Settings, chaos: Chaos, logger) -> None:
        self._settings = settings
        self._chaos = chaos
        self._log = logger
        self._email = EmailClient(settings)
        self._deliverer = Deliverer(settings, self._email, chaos)
        self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)

        self._consumer: AIOKafkaConsumer | None = None
        self._producer: AIOKafkaProducer | None = None
        self._tasks: list[asyncio.Task] = []
        self._stopping = asyncio.Event()
        self._paused = False

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        """Attach in the background.

        Kafka is allowed to be absent at boot: the HTTP surface comes up first so
        the container reports healthy and `/ready` tells the truth about the
        broker, rather than crash-looping until the broker is elected.
        """
        self._tasks.append(asyncio.create_task(self._attach_forever()))
        self._tasks.append(asyncio.create_task(self._pause_loop()))

    async def stop(self) -> None:
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks.clear()
        await self._detach()
        await self._email.close()

    async def _attach_forever(self) -> None:
        attempt = 0
        while not self._stopping.is_set():
            attempt += 1
            try:
                await self._attach()
                self._log.info(
                    "Kafka attached",
                    consumer_group=topics.CONSUMER_GROUP,
                    topics=list(topics.SUBSCRIBED_TOPICS),
                    attempt=attempt,
                )
                await self._consume_forever()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the loop is the recovery
                self._log.warning(
                    "Kafka attach failed",
                    attempt=attempt,
                    retry_in_seconds=ATTACH_RETRY_SECONDS,
                    error={"kind": type(exc).__name__, "message": str(exc)},
                )
                await self._detach()
                await asyncio.sleep(ATTACH_RETRY_SECONDS)

    async def _attach(self) -> None:
        self._consumer = AIOKafkaConsumer(
            *topics.SUBSCRIBED_TOPICS,
            bootstrap_servers=self._settings.kafka_bootstrap_servers,
            group_id=topics.CONSUMER_GROUP,
            client_id=self._settings.dd_service,
            enable_auto_commit=False,
            # A brand new group starts at the head. Replaying a week of booking
            # events on first boot would send a week of duplicate email.
            auto_offset_reset="latest",
        )
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self._settings.kafka_bootstrap_servers,
            client_id=self._settings.dd_service,
        )
        await self._consumer.start()
        await self._producer.start()

    async def _detach(self) -> None:
        if self._consumer is not None:
            await self._consumer.stop()
            self._consumer = None
        if self._producer is not None:
            await self._producer.stop()
            self._producer = None
        self._paused = False

    # ------------------------------------------------------------------- chaos

    async def _pause_loop(self) -> None:
        """`kafka_consumer_pause` names a consumer group.

        Pausing the subscription is what produces genuine, growing lag; skipping
        messages would not. Pausing is re-applied every tick so partitions picked
        up in a rebalance are paused too.
        """
        while not self._stopping.is_set():
            await asyncio.sleep(PAUSE_POLL_SECONDS)
            consumer = self._consumer
            if consumer is None:
                continue

            await self._chaos.refresh()
            target = self._chaos.get_value("kafka_consumer_pause", "")
            should_pause = target == topics.CONSUMER_GROUP

            if should_pause:
                assignment = consumer.assignment()
                if assignment:
                    consumer.pause(*assignment)
            elif consumer.paused():
                consumer.resume(*consumer.paused())

            if should_pause != self._paused:
                self._paused = should_pause
                self._log.warning(
                    "Consumer paused by chaos flag"
                    if should_pause
                    else "Consumer resumed",
                    consumer_group=topics.CONSUMER_GROUP,
                    paused=should_pause,
                )

    # --------------------------------------------------------------- consuming

    async def _consume_forever(self) -> None:
        consumer = self._consumer
        assert consumer is not None

        while not self._stopping.is_set():
            batches = await consumer.getmany(timeout_ms=POLL_TIMEOUT_MS, max_records=20)
            for partition, records in batches.items():
                for record in records:
                    await self._handle(record)
                # Committed per partition after the batch: at-least-once, which
                # is what the idempotency guards downstream are written for.
                await consumer.commit({partition: records[-1].offset + 1})

    async def _handle(self, record: ConsumerRecord) -> None:
        kafka_context.activate_consumed(record)
        await self._chaos.refresh()

        # Per-message processing delay, and the generic per-service one. Both are
        # real waiting, which is what a slow consumer is.
        slow_ms = self._chaos.get_value("kafka_slow_consumer_ms", 0)
        if slow_ms > 0:
            await asyncio.sleep(slow_ms / 1000)
        await self._chaos.maybe_service_delay(self._settings.dd_service)

        outcome = await self._deliverer.deliver(record.value)

        if outcome.kind == "sent":
            await self._mark_sent(record.value)

        if outcome.kind == "dead_lettered":
            await self._dead_letter(record, outcome)

        self._log_outcome(record, outcome)
        self._record_metrics(record, outcome)

    async def _mark_sent(self, payload: dict) -> None:
        """Record that this booking's mail has gone out.

        The confirmation page asks whether the itinerary has been sent, and
        until now nothing anywhere could answer: mail is sent by this consumer,
        asynchronously, and nothing about it is written down. The booking row
        cannot say so either -- it is confirmed long before the email leaves.

        Redis rather than a column because the answer only matters while the
        traveller is still looking at the page. A day is far longer than that
        and keeps the key count bounded on its own.

        Failures are swallowed. An unreachable Redis should cost the amber
        "your email is on its way" banner, not a redelivery of mail that has
        already been sent.
        """
        booking_id = payload.get("bookingId") or payload.get("booking_id")
        if not booking_id:
            return
        try:
            await self._redis.setex(f"voyager:notifications:sent:{booking_id}", 86_400, "1")
        except Exception:  # noqa: BLE001 - see docstring
            self._log.warning("Could not record that mail was sent", booking_id=booking_id)

    async def _dead_letter(self, record: ConsumerRecord, outcome: Outcome) -> None:
        assert self._producer is not None

        payload = {
            "originalTopic": record.topic,
            "originalPartition": record.partition,
            "originalOffset": record.offset,
            "failureReason": outcome.failure_reason,
            "attemptCount": outcome.attempts,
            "failedAt": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "original": _original(record.value),
        }
        # The original key is preserved so a DLQ message can still be traced back
        # to its booking.
        await self._producer.send_and_wait(
            topics.DLQ_TOPIC,
            key=record.key,
            value=json.dumps(payload).encode("utf-8"),
            headers=kafka_context.produce_headers(topics.DLQ_TOPIC),
        )

    def _record_metrics(self, record: ConsumerRecord, outcome: Outcome) -> None:
        """The § 14 metrics for one handled message.

        The lag gauge is reported on every message, including the ones that need
        no email: it is a property of the consumer group's position, not of what
        the message turned out to be, and reporting it only for delivered mail
        would make the gauge go quiet exactly when a flood of unroutable events
        is what put the group behind.
        """
        metrics.lag_seconds(
            produced_at_ms=record.timestamp, consumer_group=topics.CONSUMER_GROUP
        )

        if outcome.kind == "sent":
            metrics.sent(outcome.template)
        elif outcome.kind == "dead_lettered":
            metrics.dead_lettered(outcome.template, outcome.failure_reason)

    def _log_outcome(self, record: ConsumerRecord, outcome: Outcome) -> None:
        fields = {
            "kafka": {
                "topic": record.topic,
                "partition": record.partition,
                "offset": record.offset,
                "consumer_group": topics.CONSUMER_GROUP,
            },
            "notification": {
                "event_type": outcome.event_type,
                "template": outcome.template,
                "attempt_count": outcome.attempts,
                "message_id": outcome.message_id,
            },
            "http": {"request_id": outcome.correlation_id},
            "chaos": {"active_flags": ",".join(self._chaos.active_flags())},
        }

        if outcome.kind == "sent":
            self._log.info("Notification sent", **fields)
        elif outcome.kind == "dropped" and outcome.failure_reason:
            self._log.warning(
                "Notification dropped without a recipient",
                error={"kind": "NoRecipient", "message": outcome.failure_reason},
                **fields,
            )
        elif outcome.kind == "dropped":
            self._log.debug("Event needs no notification", **fields)
        else:
            self._log.error(
                "Notification dead lettered",
                error={"kind": "NotificationUndeliverable", "message": outcome.failure_reason},
                **fields,
            )


def _original(raw: bytes | None) -> object:
    """The original message, parsed when it can be and verbatim when it cannot.

    A DLQ entry that hides the bytes that broke it is useless.
    """
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")
