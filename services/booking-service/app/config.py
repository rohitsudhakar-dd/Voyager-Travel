"""Runtime configuration for booking-service.

Every value comes from the environment. Nothing is hardcoded, and DD_SERVICE is
supplied by Compose rather than by the application (02-TECH-STACK.md § 12).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # Identity
    dd_service: str = "voyager-booking"
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
    search_base_url: str = "http://search-service:4010"
    pricing_base_url: str = "http://pricing-service:4020"

    port: int = 4030

    # § 15: fifteen minutes, non-extendable. Overridable only so the exit
    # criteria can watch a hold expire without waiting a quarter of an hour.
    hold_ttl_minutes: int = 15

    # How long a readiness probe waits on any single dependency.
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
