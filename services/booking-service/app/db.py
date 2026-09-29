"""The async SQLAlchemy engine and session factory.

The pool is created lazily and rebuilt when `db_pool_starvation` flips, which
is what makes that flag produce real connection waits rather than a simulated
error.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings

NORMAL_POOL_SIZE = 10
STARVED_POOL_SIZE = 2

_engine: AsyncEngine | None = None
_sessions: async_sessionmaker[AsyncSession] | None = None
_pool_size = NORMAL_POOL_SIZE


def _build(pool_size: int) -> None:
    global _engine, _sessions, _pool_size
    settings = get_settings()
    _engine = create_async_engine(
        settings.database_url,
        pool_size=pool_size,
        max_overflow=0,
        pool_pre_ping=True,
        pool_timeout=5,
        # The search path keeps every query off `public` without each one
        # having to spell out the schema.
        connect_args={"server_settings": {"search_path": "voyager,public"}},
    )
    _sessions = async_sessionmaker(_engine, expire_on_commit=False)
    _pool_size = pool_size


async def apply_pool_chaos(starved: bool) -> None:
    """Resize the pool when `db_pool_starvation` changes.

    Two connections against a service serving concurrent checkouts produces
    genuine queueing, which is the point: the waits are real, not faked.
    """
    target = STARVED_POOL_SIZE if starved else NORMAL_POOL_SIZE
    if target == _pool_size:
        return
    old = _engine
    _build(target)
    if old is not None:
        await old.dispose()


def engine() -> AsyncEngine:
    if _engine is None:
        _build(NORMAL_POOL_SIZE)
    assert _engine is not None
    return _engine


@asynccontextmanager
async def session() -> AsyncIterator[AsyncSession]:
    if _sessions is None:
        _build(NORMAL_POOL_SIZE)
    assert _sessions is not None
    async with _sessions() as active:
        yield active


@asynccontextmanager
async def transaction() -> AsyncIterator[AsyncSession]:
    async with session() as active:
        async with active.begin():
            yield active


async def dispose() -> None:
    global _engine, _sessions
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessions = None
