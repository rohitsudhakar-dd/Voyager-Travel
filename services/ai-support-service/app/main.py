"""ai-support-service ASGI entrypoint.

Wires the four collaborators once, at startup: the repository that owns the
conversation tables, the LLM client, the tool runner, and the chaos reader.
Everything else reads them off `app.state`, so there is one place to look when
asking what this service talks to.
"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import create_async_engine

from app.chaos import close_chaos, get_chaos
from app.clients import BookingClient, LoyaltyClient
from app.config import get_settings
from app.conversation import ConversationService
from app.errors import DependencyError, ValidationError, VoyagerError, envelope
from app.health import router as health_router
from app.llm import LlmClient
from app.llmobs import enable_llmobs
from app.logging import configure_logging, get_logger
from app.repo import SupportRepo
from app.routers.support import router as support_router
from app.tools.handlers import ToolRunner

settings = get_settings()
configure_logging(
    settings.dd_service, settings.dd_env, settings.dd_version, settings.log_level
)
logger = get_logger("app.support")

# At import, not in the lifespan: LLMObs.enable() rebuilds the tracer's span
# processors, and a trace already in flight when it does is dropped silently.
# Here the port is not bound yet, so there is none. See app/llmobs.py.
enable_llmobs(settings, logger)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The engine connects lazily, so Postgres is allowed to be absent at boot:
    # the container comes up, /health passes, and /ready tells the truth.
    engine = create_async_engine(settings.database_url, pool_size=5, max_overflow=5)

    chaos = get_chaos(settings.redis_url)
    repo = SupportRepo(engine)
    llm = LlmClient(settings)
    booking = BookingClient(settings)
    loyalty = LoyaltyClient(settings)
    tools = ToolRunner(repo, booking, loyalty)

    app.state.settings = settings
    app.state.logger = logger
    app.state.chaos = chaos
    app.state.repo = repo
    app.state.llm = llm
    app.state.conversations = ConversationService(
        settings, repo, llm, tools, chaos, logger
    )

    logger.info(
        "Service started",
        llm={
            "provider": settings.llm_provider,
            "base_url": settings.llm_base_url,
            "model": settings.llm_model,
        },
        downstream={
            "booking_base_url": settings.booking_base_url,
            "loyalty_base_url": settings.loyalty_base_url,
        },
        postgres_host=settings.postgres_host,
        postgres_user=settings.postgres_user,
        redis_url=settings.redis_url,
    )
    try:
        yield
    finally:
        logger.info("Shutting down")
        await booking.close()
        await loyalty.close()
        await llm.close()
        await engine.dispose()
        await close_chaos()


app = FastAPI(
    title="Voyager ai-support-service",
    version=settings.dd_version,
    docs_url="/docs",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(support_router)

_PROBES = ("/health", "/ready")


@app.middleware("http")
async def observe_and_degrade(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or f"req_{uuid.uuid4().hex[:24]}"
    request.state.request_id = request_id

    # `service_latency_ms` and `service_error_rate` are the generic per-service
    # knobs. They are not applied to the probes: a chaos flag that fails a health
    # check would restart the container instead of degrading it.
    if request.url.path not in _PROBES:
        chaos = getattr(app.state, "chaos", None)
        if chaos is not None:
            await chaos.refresh()
            await chaos.maybe_service_delay(settings.dd_service)
            if chaos.maybe_service_fail(settings.dd_service):
                error = DependencyError(
                    "The service is temporarily unavailable.",
                    injectedBy="service_error_rate",
                )
                return JSONResponse(
                    status_code=500, content=envelope(error, request_id)
                )

    started = time.monotonic()
    response = await call_next(request)
    response.headers["x-request-id"] = request_id

    # One request log per request, at completion, as the schema requires. For a
    # streamed response this is the time to first byte -- the stream is still open.
    if request.url.path != "/health":
        logger.info(
            "Request completed",
            http={
                "method": request.method,
                "url_details": {"path": request.url.path},
                "status_code": response.status_code,
                "request_id": request_id,
            },
            duration=int((time.monotonic() - started) * 1_000_000_000),
        )
    return response


@app.exception_handler(VoyagerError)
async def voyager_error_handler(request: Request, exc: VoyagerError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", "unknown")
    if exc.status >= 500:
        logger.error(
            "Request failed",
            http={"method": request.method, "url_details": {"path": request.url.path}},
            error={"kind": type(exc).__name__, "message": exc.message},
        )
    return JSONResponse(status_code=exc.status, content=envelope(exc, request_id))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    request_id = getattr(request.state, "request_id", "unknown")
    error = ValidationError("That request is not valid.", fields=_fields(exc))
    return JSONResponse(status_code=error.status, content=envelope(error, request_id))


def _fields(exc: RequestValidationError) -> list[str]:
    """Field names only. The raw pydantic detail can echo the request body back,
    and the body of a support message is user content."""
    return [".".join(str(part) for part in error.get("loc", ())) for error in exc.errors()]
