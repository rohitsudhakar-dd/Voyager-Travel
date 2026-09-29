"""Runtime configuration for notification-worker.

Every value comes from the environment. Nothing is hardcoded, and DD_SERVICE is
supplied by Compose rather than by the application (02-TECH-STACK.md § 12).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Topic and consumer-group names are contracts, not configuration
# (05-FUNCTIONALITY.md § 6). An operator who changes them breaks the Data
# Streams topology, so they are constants rather than settings.
CONSUMER_GROUP = "voyager-notifications-v1"
BOOKINGS_TOPIC = "voyager.bookings.events"
PAYMENTS_TOPIC = "voyager.payments.events"
OUTBOUND_TOPIC = "voyager.notifications.outbound"
ACCRUALS_TOPIC = "voyager.loyalty.accruals"
DLQ_TOPIC = "voyager.notifications.dlq"

SUBSCRIBED_TOPICS = (
    BOOKINGS_TOPIC,
    PAYMENTS_TOPIC,
    OUTBOUND_TOPIC,
    ACCRUALS_TOPIC,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # Identity
    dd_service: str = "voyager-notifications"
    dd_env: str = "demo"
    dd_version: str = "dev"
    log_level: str = "INFO"

    # Dependencies
    redis_url: str = "redis://redis:6379"
    kafka_brokers: str = "kafka:9092"
    email_base_url: str = "http://mock-email:4920"
    email_from_address: str = "no-reply@voyager.demo"

    # Delivery. Three attempts then the DLQ, per the Phase 5 exit criteria.
    max_attempts: int = 3
    retry_backoff_ms: int = 200
    email_timeout_seconds: float = 5.0

    # How long a readiness probe waits on any single dependency.
    readiness_timeout_seconds: float = 2.0

    @property
    def kafka_bootstrap_servers(self) -> list[str]:
        return [broker.strip() for broker in self.kafka_brokers.split(",") if broker.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
