"""notification-worker ASGI entrypoint.

The Kafka consumer runs as a task inside this process rather than as a separate
container: one process means one `DD_SERVICE`, one set of runtime metrics, and
one place for `/ready` to report from. The HTTP surface is health only -- this
service has no business API (05-FUNCTIONALITY.md § 1).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import config as topics
from app.chaos import close_chaos, get_chaos
from app.config import get_settings
from app.consumer import NotificationConsumer
from app.health import router as health_router
from app.logging import configure_logging, get_logger

settings = get_settings()
configure_logging(
    settings.dd_service, settings.dd_env, settings.dd_version, settings.log_level
)
logger = get_logger("app.notifications")


@asynccontextmanager
async def lifespan(app: FastAPI):
    chaos = get_chaos(settings.redis_url)
    consumer = NotificationConsumer(settings, chaos, logger)
    consumer.start()

    # Startup line with the resolved config, secrets excluded. During a demo this
    # is the fastest way to prove which version is running.
    logger.info(
        "Service started",
        consumer_group=topics.CONSUMER_GROUP,
        topics=list(topics.SUBSCRIBED_TOPICS),
        dlq_topic=topics.DLQ_TOPIC,
        kafka_brokers=settings.kafka_bootstrap_servers,
        email_base_url=settings.email_base_url,
        max_attempts=settings.max_attempts,
    )
    try:
        yield
    finally:
        logger.info("Shutting down")
        await consumer.stop()
        await close_chaos()


app = FastAPI(
    title="Voyager notification-worker",
    version=settings.dd_version,
    docs_url="/docs",
    lifespan=lifespan,
)

app.include_router(health_router)
