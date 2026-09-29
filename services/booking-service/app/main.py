"""booking-service ASGI entrypoint.

Phase 1 stands the service up so it can own schema migrations and answer the
uniform health probes. The booking lifecycle itself arrives in Phase 4.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.config import get_settings
from app.health import router as health_router

settings = get_settings()

app = FastAPI(
    title="Voyager booking-service",
    version=settings.dd_version,
    docs_url="/docs",
)

app.include_router(health_router)
