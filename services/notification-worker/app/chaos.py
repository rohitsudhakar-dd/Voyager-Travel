"""Chaos flag reader.

All state lives in the single Redis hash `voyager:chaos`
(05-FUNCTIONALITY.md § 10). This module is the only place in the service that
reads it, and it is deliberately small enough to read on a slide.

Three rules it must obey:
 - fail open: if Redis is unreachable, chaos is off. A demo must never break
   because Redis hiccuped.
 - no restarts: a flag takes effect on the next message.
 - 2 second cache: long enough not to hammer Redis, short enough that a toggle
   feels instant on stage.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
from typing import TypeVar

import redis.asyncio as aioredis

CHAOS_HASH = "voyager:chaos"
CACHE_TTL_SECONDS = 2.0

T = TypeVar("T", bound=float | int | str)

_SERVICE_PREFIX = re.compile(r"^voyager-")


class Chaos:
    def __init__(self, redis_url: str) -> None:
        self._client = aioredis.from_url(redis_url, decode_responses=True)
        self._snapshot: dict[str, str] = {}
        self._loaded_at = 0.0
        self._lock = asyncio.Lock()

    async def refresh(self) -> None:
        """Reload the snapshot if it is older than the cache TTL."""
        if time.monotonic() - self._loaded_at < CACHE_TTL_SECONDS:
            return
        async with self._lock:
            if time.monotonic() - self._loaded_at < CACHE_TTL_SECONDS:
                return
            try:
                self._snapshot = await self._client.hgetall(CHAOS_HASH)
            except Exception:  # noqa: BLE001 - any Redis failure means chaos off
                self._snapshot = {}
            finally:
                self._loaded_at = time.monotonic()

    def is_enabled(self, flag: str) -> bool:
        raw = self._snapshot.get(flag)
        return raw in {"true", "1", '"true"'}

    def get_value(self, flag: str, default: T) -> T:
        raw = self._snapshot.get(flag)
        if raw is None or raw == "":
            return default
        # Values are JSON-encoded scalars, but a bare value set by hand with
        # redis-cli should work too -- an operator mid-demo should not have to
        # remember to quote things.
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = raw
        if isinstance(default, bool):
            return parsed in {True, "true", 1}  # type: ignore[return-value]
        if isinstance(default, (int, float)):
            try:
                return type(default)(parsed)  # type: ignore[return-value]
            except (TypeError, ValueError):
                return default
        return str(parsed)  # type: ignore[return-value]

    async def maybe_delay(self, flag: str, mode_flag: str | None = None) -> float:
        """Apply the latency configured by `flag`, in `fixed`, `jitter` or
        `p99_tail` mode. Real waiting: this stands in for a slow network hop,
        which is what a network delay actually is."""
        base = self.get_value(flag, 0.0)
        if base <= 0:
            return 0.0

        mode = self.get_value(mode_flag, "jitter") if mode_flag else "jitter"
        delay = base
        if mode == "jitter":
            delay = base * (0.5 + random.random())
        elif mode == "p99_tail":
            roll = random.random()
            if roll < 0.01:
                delay = base
            elif roll < 0.05:
                delay = base * 0.5
            else:
                delay = 0.0

        if delay > 0:
            await asyncio.sleep(delay / 1000)
        return delay

    def maybe_fail(self, flag: str) -> bool:
        """Probabilistic failure. True when the caller should fail."""
        rate = self.get_value(flag, 0.0)
        return rate > 0 and random.random() < rate

    def service_value(self, flag: str, service: str) -> float:
        """`service_error_rate` and `service_latency_ms` are maps keyed by
        service rather than scalars. Both the full DD_SERVICE and the bare name
        are accepted, because `{"notifications": 0.5}` is what an operator will
        type."""
        raw = self._snapshot.get(flag)
        if not raw:
            return 0.0
        try:
            table = json.loads(raw)
        except ValueError:
            return 0.0
        if not isinstance(table, dict):
            return 0.0
        candidate = (
            table.get(service)
            or table.get(_SERVICE_PREFIX.sub("", service))
            or table.get("*")
        )
        try:
            return float(candidate)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return 0.0

    async def maybe_service_delay(self, service: str) -> float:
        delay = self.service_value("service_latency_ms", service)
        if delay <= 0:
            return 0.0
        await asyncio.sleep(delay / 1000)
        return delay

    def maybe_service_fail(self, service: str) -> bool:
        rate = self.service_value("service_error_rate", service)
        return rate > 0 and random.random() < rate

    def active_flags(self) -> list[str]:
        """Sorted, for the `chaos.active_flags` span tag added in Phase 8."""
        return sorted(
            flag
            for flag, value in self._snapshot.items()
            if value not in {"", "false", "0"}
        )

    async def ping(self) -> None:
        """Readiness probe. Unlike everything else here it is allowed to raise:
        failing open is right for chaos, wrong for reporting dependency state."""
        await self._client.ping()

    async def close(self) -> None:
        await self._client.aclose()


_chaos: Chaos | None = None


def get_chaos(redis_url: str | None = None) -> Chaos:
    global _chaos
    if _chaos is None:
        if redis_url is None:
            raise RuntimeError("Chaos has not been initialised.")
        _chaos = Chaos(redis_url)
    return _chaos


async def close_chaos() -> None:
    global _chaos
    if _chaos is not None:
        await _chaos.close()
        _chaos = None
