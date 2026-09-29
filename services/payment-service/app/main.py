"""payment-service ASGI entrypoint.

Authorizations, captures, refunds, 3DS step-up, and the provider webhook that
carries the asynchronous result.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import clients, db, errors, logging as log_setup
from app.chaos import ChaosReader
from app.config import get_settings
from app.health import router as health_router
from app.kafka.producer import Producer
from app.middleware import RequestContextMiddleware
from app.routers.payments import router as payments_router
from app.routers.payments import webhooks as webhooks_router
from app.state import runtime

settings = get_settings()
log_setup.configure(settings.dd_service, settings.dd_env, settings.dd_version)
log = log_setup.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime.chaos = ChaosReader(settings.redis_url)
    runtime.producer = Producer(settings.kafka_brokers, runtime.chaos)
    await runtime.producer.start()
    await runtime.chaos.refresh(force=True)

    stop = asyncio.Event()
    watcher = asyncio.create_task(_watch_pool_chaos(stop))

    log.info(
        "Service started",
        config={
            "port": settings.port,
            "payments_base_url": settings.payments_base_url,
            "booking_base_url": settings.booking_base_url,
            "idempotency_ttl_hours": settings.idempotency_ttl_hours,
        },
    )
    try:
        yield
    finally:
        stop.set()
        await asyncio.gather(watcher, return_exceptions=True)
        await runtime.producer.stop()
        await runtime.chaos.close()
        await clients.close()
        await db.dispose()
        log.info("Service stopped")


async def _watch_pool_chaos(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await runtime.chaos.refresh()
            await db.apply_pool_chaos(runtime.chaos.is_enabled("db_pool_starvation"))
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Pool resize skipped",
                error={"kind": type(exc).__name__, "message": str(exc)},
            )
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except asyncio.TimeoutError:
            continue


app = FastAPI(
    title="Voyager payment-service",
    version=settings.dd_version,
    docs_url="/docs",
    lifespan=lifespan,
)

app.add_middleware(RequestContextMiddleware)
app.include_router(health_router)
app.include_router(payments_router)
app.include_router(webhooks_router)
errors.install(app, log)
