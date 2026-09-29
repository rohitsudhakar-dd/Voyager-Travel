"""Alembic environment.

booking-service is the single owner of schema migrations for the whole Voyager
database (05-FUNCTIONALITY.md § 1). No other service runs DDL.
"""

from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool, text
from sqlalchemy.ext.asyncio import async_engine_from_config

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Every table is defined in raw DDL inside the migrations so the committed SQL
# matches 05-FUNCTIONALITY.md § 3 line for line. There is no declarative
# metadata to autogenerate from, and that is deliberate.
target_metadata = None

SCHEMA = "voyager"


def database_url() -> str:
    user = os.environ.get("POSTGRES_USER", "voyager")
    password = os.environ.get("POSTGRES_PASSWORD", "")
    host = os.environ.get("POSTGRES_HOST", "postgres")
    port = os.environ.get("POSTGRES_PORT", "5432")
    database = os.environ.get("POSTGRES_DB", "voyager")
    return f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{database}"


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        version_table_schema=SCHEMA,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema=SCHEMA,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = database_url()

    engine = async_engine_from_config(
        section, prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    # engine.begin(), not engine.connect(): SQLAlchemy 2.0 is commit-as-you-go,
    # and alembic's own begin_transaction() is a no-op once a transaction is
    # already open. With connect() the whole migration rolls back on close,
    # silently and with a successful-looking log.
    async with engine.begin() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
