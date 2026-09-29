"""The `db_lock_storm` background task (05-FUNCTIONALITY.md § 11, scenario S10).

Several workers take a row lock on the same `inventory_holds` rows and hold it
for five seconds at a time. Whoever gets there first wins; everyone else --
the other workers, the hold sweeper, and any checkout that reaches one of
those rows -- queues behind them on a real Postgres lock. That queue is the
whole point: Database Monitoring reports blocking sessions by reading
`pg_blocking_pids()` out of `pg_stat_activity`, so a lock nobody is waiting on
produces no blocking sessions at all and the scenario shows nothing.

The rows are chosen by primary key rather than at random precisely so that the
workers converge on the same ones. Random rows across a thousand active holds
would almost never collide, and the flag would look enabled while the database
stayed perfectly healthy.
"""

from __future__ import annotations

import asyncio

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import get_settings
from app.state import runtime

WORKERS = 3
ROWS_LOCKED = 5
HOLD_SECONDS = 5.0
IDLE_POLL_SECONDS = 2.0

# Long enough that a worker still waits behind a full five-second hold and is
# sampled while waiting, short enough that a pile-up unwinds instead of
# growing. Without it a worker that arrives third waits fifteen seconds, then
# thirty, and the storm stops being reversible on the two-second cadence the
# chaos framework promises.
LOCK_TIMEOUT = "15s"

log = structlog.get_logger()

_engine: AsyncEngine | None = None


def _storm_engine() -> AsyncEngine:
    """Connections of its own, deliberately not the application pool.

    Scenario S10 turns this flag on alongside `db_pool_starvation`, which
    clamps that pool to two connections. Three workers sharing it would take
    every one and the service would stop answering -- a chaos flag is allowed
    to make Voyager slow, never to make it wrong.
    """
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            get_settings().database_url,
            pool_size=WORKERS,
            max_overflow=0,
            pool_pre_ping=True,
            connect_args={
                "server_settings": {
                    "search_path": "voyager,public",
                    "lock_timeout": LOCK_TIMEOUT,
                    # A worker cancelled mid-hold must not leave the lock
                    # behind. The connection normally closes and Postgres
                    # rolls back, but this is the backstop for the case where
                    # it does not.
                    "idle_in_transaction_session_timeout": "30s",
                    "application_name": "voyager-booking-lockstorm",
                }
            },
        )
    return _engine


async def run(stop: asyncio.Event) -> None:
    workers = [asyncio.create_task(_worker(stop, index)) for index in range(WORKERS)]
    try:
        await stop.wait()
    finally:
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        await dispose()


async def _worker(stop: asyncio.Event, index: int) -> None:
    while not stop.is_set():
        try:
            await runtime.chaos.refresh()
            enabled = runtime.chaos.is_enabled("db_lock_storm")
        except Exception:  # noqa: BLE001 - an unreachable Redis means chaos off
            enabled = False

        if not enabled:
            await _sleep_or_stop(stop, IDLE_POLL_SECONDS)
            continue

        try:
            await _hold_once(index)
        except Exception as exc:  # noqa: BLE001 - one failed hold, not the end
            log.warning(
                "Lock storm hold failed",
                chaos={"flag": "db_lock_storm", "worker": index},
                error={"kind": type(exc).__name__, "message": str(exc)},
            )
            await _sleep_or_stop(stop, IDLE_POLL_SECONDS)


async def _hold_once(index: int) -> None:
    async with _storm_engine().begin() as connection:
        locked = (
            await connection.execute(
                text(
                    """
                    SELECT id FROM inventory_holds
                    WHERE state = 'active'
                    ORDER BY id
                    LIMIT :rows
                    FOR UPDATE
                    """
                ),
                {"rows": ROWS_LOCKED},
            )
        ).all()

        if not locked:
            # Reported rather than swallowed: an empty table makes every
            # downstream assertion about blocking sessions pass by absence,
            # and that reads identically to a storm that is working.
            log.warning(
                "Lock storm found no active holds to lock",
                chaos={"flag": "db_lock_storm", "worker": index},
            )
            return

        log.info(
            "Lock storm holding rows",
            chaos={"flag": "db_lock_storm", "worker": index},
            db={"table": "inventory_holds", "rows_locked": len(locked)},
        )
        await asyncio.sleep(HOLD_SECONDS)


async def _sleep_or_stop(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        return


async def dispose() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None
