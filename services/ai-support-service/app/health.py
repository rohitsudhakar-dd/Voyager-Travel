"""Liveness and readiness, shaped exactly as 05-FUNCTIONALITY.md § 16.

The split matters. /health checks nothing external, so a Postgres blip cannot
restart every container at once; /ready checks dependencies and is what the
gateway's /admin/status aggregates.

booking-service and loyalty-service are deliberately *not* checked here. They are
tool targets, not dependencies of this service being able to serve: a support
chat that can still answer a baggage question should not report itself unready
because a cancellation would fail.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from fastapi import APIRouter, Request, Response

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


async def _run_check(name: str, coro_factory: Callable[[], Awaitable[None]]) -> tuple[str, str]:
    settings = get_settings()
    try:
        await asyncio.wait_for(
            coro_factory(), timeout=settings.readiness_timeout_seconds
        )
        return name, "ok"
    except asyncio.TimeoutError:
        return name, f"error: timed out after {settings.readiness_timeout_seconds}s"
    except Exception as exc:  # noqa: BLE001 - the reason is the useful part
        return name, f"error: {type(exc).__name__}: {exc}"


@router.get("/ready")
async def ready(request: Request, response: Response) -> dict:
    state = request.app.state
    results = await asyncio.gather(
        _run_check("postgres", state.repo.ping),
        _run_check("redis", state.chaos.ping),
        _run_check("llm", state.llm.ping),
    )
    checks = dict(results)
    healthy = all(value == "ok" for value in checks.values())
    if not healthy:
        response.status_code = 503
    return {"status": "ready" if healthy else "not_ready", "checks": checks}
