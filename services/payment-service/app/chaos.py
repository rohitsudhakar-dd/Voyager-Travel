"""The chaos reader, per 05-FUNCTIONALITY.md § 10.

Same contract as the TypeScript and Go readers: one Redis hash, a two-second
local cache, and a reader that fails open. A service that cannot reach Redis
behaves as though every flag were off, which is the only safe default -- the
alternative is an observability tool that takes production down with it.
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Any, TypeVar

import redis.asyncio as aioredis

CHAOS_HASH = "voyager:chaos"
_CACHE_TTL_SECONDS = 2.0

T = TypeVar("T")


class ChaosReader:
    def __init__(self, redis_url: str) -> None:
        self._client = aioredis.from_url(redis_url, decode_responses=True)
        self._values: dict[str, str] = {}
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()

    async def refresh(self, *, force: bool = False) -> None:
        """Reload the hash if the local copy is older than the TTL.

        The lock collapses a burst of concurrent requests into one Redis round
        trip rather than one per request.
        """
        if not force and time.monotonic() - self._fetched_at < _CACHE_TTL_SECONDS:
            return
        async with self._lock:
            if not force and time.monotonic() - self._fetched_at < _CACHE_TTL_SECONDS:
                return
            try:
                self._values = await self._client.hgetall(CHAOS_HASH) or {}
            except Exception:  # noqa: BLE001 - failing open is the whole point
                self._values = {}
            self._fetched_at = time.monotonic()

    def is_enabled(self, flag: str) -> bool:
        raw = self._values.get(flag)
        return raw is not None and raw.strip().lower() in {"1", "true", "yes", "on"}

    def get_value(self, flag: str, default: T) -> T:
        raw = self._values.get(flag)
        if raw is None or raw == "":
            return default
        try:
            if isinstance(default, bool):
                return raw.strip().lower() in {"1", "true", "yes", "on"}  # type: ignore[return-value]
            if isinstance(default, int):
                return int(float(raw))  # type: ignore[return-value]
            if isinstance(default, float):
                return float(raw)  # type: ignore[return-value]
        except ValueError:
            return default
        return raw  # type: ignore[return-value]

    async def maybe_delay(self, flag: str, *, mode_flag: str | None = None) -> None:
        """Sleep for the configured delay, shaped by the delay mode.

        This is the one sanctioned use of sleep in the codebase: it emulates a
        slow dependency, it is never on a path that produces a business result.
        """
        milliseconds = self.get_value(flag, 0)
        if milliseconds <= 0:
            return

        mode = self.get_value(mode_flag, "fixed") if mode_flag else "fixed"
        if mode == "jitter":
            milliseconds = int(milliseconds * random.uniform(0.5, 1.5))
        elif mode == "p99_tail":
            # A long tail on a small slice, rather than everything being a
            # bit slower. That shape is what makes a p99 alert fire while the
            # p50 stays flat.
            roll = random.random()
            if roll < 0.01:
                pass
            elif roll < 0.05:
                milliseconds //= 2
            else:
                return

        await asyncio.sleep(milliseconds / 1000)

    def maybe_fail(self, flag: str) -> bool:
        """True with the probability stored in `flag` (a float from 0 to 1)."""
        rate = self.get_value(flag, 0.0)
        return rate > 0 and random.random() < rate

    def service_rate(self, flag: str, service: str) -> float:
        """Read one service's entry out of a `service->number` map flag.

        `service_error_rate` and `service_latency_ms` are stored as JSON
        objects so one flag can target one service without needing a flag per
        service.
        """
        import json

        raw = self._values.get(flag)
        if not raw:
            return 0.0
        try:
            mapping = json.loads(raw)
        except ValueError:
            return 0.0
        if not isinstance(mapping, dict):
            return 0.0
        try:
            return float(mapping.get(service, 0))
        except (TypeError, ValueError):
            return 0.0

    def active_flags(self) -> str:
        """Sorted, comma-joined, for the `chaos.active_flags` log field."""
        return ",".join(sorted(key for key, value in self._values.items() if value))

    async def close(self) -> None:
        await self._client.aclose()
