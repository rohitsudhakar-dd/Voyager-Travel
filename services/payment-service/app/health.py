"""Liveness and readiness, shaped exactly as 05-FUNCTIONALITY.md § 16.

The split matters. /health checks nothing external, so a Postgres blip cannot
restart every container at once; /ready checks dependencies and is what the
gateway's /admin/status aggregates.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.dd_service,
        "version": settings.dd_version,
    }


async def _check_postgres() -> str:
    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=False)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return "ok"
    finally:
        await engine.dispose()


async def _check_redis() -> str:
    import redis.asyncio as aioredis

    settings = get_settings()
    client = aioredis.from_url(settings.redis_url)
    try:
        await client.ping()
        return "ok"
    finally:
        await client.aclose()


async def _check_kafka() -> str:
    from aiokafka.admin import AIOKafkaAdminClient

    settings = get_settings()
    admin = AIOKafkaAdminClient(bootstrap_servers=settings.kafka_brokers)
    try:
        await admin.start()
        return "ok"
    finally:
        await admin.close()


async def _run_check(name: str, coro_factory) -> tuple[str, str]:
    settings = get_settings()
    try:
        result = await asyncio.wait_for(
            coro_factory(), timeout=settings.readiness_timeout_seconds
        )
        return name, result
    except asyncio.TimeoutError:
        return name, f"error: timed out after {settings.readiness_timeout_seconds}s"
    except Exception as exc:  # noqa: BLE001 - the reason is the useful part
        return name, f"error: {type(exc).__name__}: {exc}"


@router.get("/ready")
async def ready(response: Response) -> dict:
    results = await asyncio.gather(
        _run_check("postgres", _check_postgres),
        _run_check("redis", _check_redis),
        _run_check("kafka", _check_kafka),
    )
    checks = dict(results)
    healthy = all(value == "ok" for value in checks.values())
    if not healthy:
        response.status_code = 503
    return {"status": "ready" if healthy else "not_ready", "checks": checks}
