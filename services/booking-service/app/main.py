"""booking-service ASGI entrypoint.

The service owns the booking lifecycle, the schema migrations, and two
background loops: the payment-events consumer and the hold-expiry sweeper.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import clients, db, errors, logging as log_setup
from app.chaos import ChaosReader
from app.config import get_settings
from app.consumers import payments as payments_consumer
from app.health import router as health_router
from app.kafka.producer import Producer
from app.lockstorm import run as run_lock_storm
from app.middleware import RequestContextMiddleware
from app.routers.bookings import router as bookings_router
from app.state import runtime
from app.sweeper import run as run_sweeper

settings = get_settings()
log_setup.configure(settings.dd_service, settings.dd_env, settings.dd_version)
log = log_setup.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime.chaos = ChaosReader(settings.redis_url)
    runtime.hold_ttl_minutes = settings.hold_ttl_minutes
    runtime.producer = Producer(settings.kafka_brokers, runtime.chaos)
    await runtime.producer.start()
    await runtime.chaos.refresh(force=True)

    stop = asyncio.Event()
    tasks = [
        asyncio.create_task(payments_consumer.run(settings.kafka_brokers, stop)),
        asyncio.create_task(run_sweeper(stop)),
        asyncio.create_task(_watch_pool_chaos(stop)),
        asyncio.create_task(run_lock_storm(stop)),
    ]

    log.info(
        "Service started",
        config={
            "port": settings.port,
            "hold_ttl_minutes": settings.hold_ttl_minutes,
            "kafka_brokers": settings.kafka_brokers,
            "search_base_url": settings.search_base_url,
            "pricing_base_url": settings.pricing_base_url,
        },
    )
    try:
        yield
    finally:
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await runtime.producer.stop()
        await runtime.chaos.close()
        await clients.close()
        await db.dispose()
        log.info("Service stopped")


async def _watch_pool_chaos(stop: asyncio.Event) -> None:
    """Resize the connection pool when `db_pool_starvation` flips.

    Polled rather than checked per request because rebuilding the engine on a
    request path would make the first request after the flip pay for it.
    """
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
    title="Voyager booking-service",
    version=settings.dd_version,
    docs_url="/docs",
    lifespan=lifespan,
)

app.add_middleware(RequestContextMiddleware)
app.include_router(health_router)
app.include_router(bookings_router)
errors.install(app, log)
