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

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.structs import ConsumerRecord

from app import config as topics
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
        await self._chaos.refresh()

        # Per-message processing delay, and the generic per-service one. Both are
        # real waiting, which is what a slow consumer is.
        slow_ms = self._chaos.get_value("kafka_slow_consumer_ms", 0)
        if slow_ms > 0:
            await asyncio.sleep(slow_ms / 1000)
        await self._chaos.maybe_service_delay(self._settings.dd_service)

        outcome = await self._deliverer.deliver(record.value)

        if outcome.kind == "dead_lettered":
            await self._dead_letter(record, outcome)

        self._log_outcome(record, outcome)

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
        )

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
