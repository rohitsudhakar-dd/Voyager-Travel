"""Runtime configuration for payment-service.

Every value comes from the environment. Nothing is hardcoded, and DD_SERVICE is
supplied by Compose rather than by the application (02-TECH-STACK.md § 12).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # Identity
    dd_service: str = "voyager-payment"
    dd_env: str = "demo"
    dd_version: str = "dev"

    # DogStatsD. The Agent's container name, not localhost: the socket is on
    # another container, and a client pointed at localhost reports nothing at
    # all with no error to say so.
    dd_dogstatsd_host: str = "datadog-agent"
    dd_dogstatsd_port: int = 8125

    # Postgres
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "voyager"
    postgres_password: str = ""
    postgres_db: str = "voyager"

    # Redis and Kafka
    redis_url: str = "redis://redis:6379"
    kafka_brokers: str = "kafka:9092"

    # Upstreams
    payments_base_url: str = "http://mock-payments:4910"
    booking_base_url: str = "http://booking-service:4030"

    port: int = 4040

    # § 3.2: idempotency records are honoured for 24 hours, matching what
    # mock-payments promises its callers.
    idempotency_ttl_hours: int = 24

    readiness_timeout_seconds: float = 2.0

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
