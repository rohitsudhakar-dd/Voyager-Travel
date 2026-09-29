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

    # Postgres
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "voyager"
    postgres_password: str = ""
    postgres_db: str = "voyager"

    # Redis and Kafka
    redis_url: str = "redis://redis:6379"
    kafka_brokers: str = "kafka:9092"

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
