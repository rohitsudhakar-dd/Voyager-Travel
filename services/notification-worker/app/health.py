"""Liveness and readiness, shaped exactly as 05-FUNCTIONALITY.md § 16.

The split matters. /health checks nothing external, so a Kafka blip cannot
restart every container at once; /ready checks dependencies and is what the
gateway's /admin/status aggregates.

notification-worker has no business API, so these two endpoints are the entire
HTTP surface -- and /ready has to exist precisely because /admin/status
aggregates it.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from fastapi import APIRouter, Response

from app.chaos import get_chaos
from app.config import get_settings
from app.email_client import EmailClient

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.dd_service,
        "version": settings.dd_version,
    }


async def _check_redis() -> str:
    await get_chaos().ping()
    return "ok"


async def _check_kafka() -> str:
    from aiokafka.admin import AIOKafkaAdminClient

    settings = get_settings()
    admin = AIOKafkaAdminClient(bootstrap_servers=settings.kafka_bootstrap_servers)
    try:
        await admin.start()
        return "ok"
    finally:
        await admin.close()


async def _check_email() -> str:
    settings = get_settings()
    client = EmailClient(settings)
    try:
        await client.ping()
        return "ok"
    finally:
        await client.close()


async def _run_check(name: str, coro_factory: Callable[[], Awaitable[str]]) -> tuple[str, str]:
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
        _run_check("redis", _check_redis),
        _run_check("kafka", _check_kafka),
        _run_check("email", _check_email),
    )
    checks = dict(results)
    healthy = all(value == "ok" for value in checks.values())
    if not healthy:
        response.status_code = 503
    return {"status": "ready" if healthy else "not_ready", "checks": checks}
