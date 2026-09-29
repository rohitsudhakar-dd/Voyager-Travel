"""Runtime configuration for ai-support-service.

Every value comes from the environment. Nothing is hardcoded, and DD_SERVICE is
supplied by Compose rather than by the application (02-TECH-STACK.md § 12).

`LLM_BASE_URL` is what makes the provider swappable: the stock `openai` client
points at mock-llm by default and at a real provider by changing one variable
(02-TECH-STACK.md § 7.1).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # Identity
    dd_service: str = "voyager-ai-support"
    dd_env: str = "demo"
    dd_version: str = "dev"
    log_level: str = "INFO"

    # DogStatsD. The Agent's container name, not localhost: the socket is on
    # another container, and a client pointed at localhost reports nothing at
    # all with no error to say so.
    dd_dogstatsd_host: str = "datadog-agent"
    dd_dogstatsd_port: int = 8125

    # Postgres -- this service owns support_conversations and support_messages.
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "voyager"
    postgres_password: str = ""
    postgres_db: str = "voyager"

    redis_url: str = "redis://redis:6379"

    # LLM
    llm_provider: str = "mock"
    llm_base_url: str = "http://mock-llm:4930/v1"
    llm_api_key: str = "mock-key"
    llm_model: str = "voyager-support-v1"
    llm_timeout_seconds: float = 60.0
    llm_max_tool_rounds: int = 2

    # LLM Observability. `ml_app` groups the traces in the product and is the
    # one value LLMObs.enable() refuses to start without.
    dd_llmobs_ml_app: str = "voyager-support"

    # The tariff the cost annotation on an `llm` span is computed from. It is
    # invented, because `voyager-support-v1` is invented -- but it is the same
    # invention as the cost widget on datadog/dashboards/d6-ai-support.json,
    # which is the point of it being configuration rather than a literal.
    llm_cost_input_usd_per_million: float = 0.50
    llm_cost_output_usd_per_million: float = 1.50

    # Downstream services the tools call. Nothing here mutates a booking
    # directly -- every change goes through booking-service (§ 1).
    booking_base_url: str = "http://booking-service:4030"
    loyalty_base_url: str = "http://loyalty-service:4050"
    downstream_timeout_seconds: float = 5.0

    # How many turns of history are replayed to the model.
    history_window: int = 20

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
