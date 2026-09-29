"""Database plumbing for the seeder.

Everything large goes in through COPY FROM STDIN. Row-by-row inserts do not
finish 3M rows inside the 5-minute budget, and the ORM is not involved at all.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Iterable, Iterator, Sequence

import psycopg

# Truncated in reverse dependency order. TRUNCATE ... CASCADE would do the same
# job, but naming the tables makes it obvious what the seeder owns.
TABLES_IN_LOAD_ORDER: tuple[str, ...] = (
    "voyager.cities",
    "voyager.airports",
    "voyager.airlines",
    "voyager.flights",
    "voyager.fare_classes",
    "voyager.fare_rules",
    "voyager.hotels",
    "voyager.room_types",
    "voyager.rate_plans",
    "voyager.users",
    "voyager.loyalty_accounts",
    "voyager.bookings",
    "voyager.booking_items",
    "voyager.passengers",
    "voyager.inventory_holds",
    "voyager.payments",
    "voyager.payment_events",
    "voyager.loyalty_transactions",
    "voyager.support_conversations",
    "voyager.support_messages",
    "voyager.idempotency_records",
)


def connect(dsn: str) -> psycopg.Connection:
    conn = psycopg.connect(dsn, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("SET search_path TO voyager, public")
        # The seeder is a single-shot bulk loader; durability during the load
        # buys nothing because a failed run is re-run from scratch.
        cur.execute("SET synchronous_commit TO off")
    return conn


def truncate_all(conn: psycopg.Connection) -> None:
    """Truncate every seeded table, resetting identity sequences.

    This is what makes the seeder idempotent: re-running it produces the same
    row counts and the same generated identifiers.
    """
    tables = ", ".join(TABLES_IN_LOAD_ORDER)
    with conn.cursor() as cur:
        cur.execute(f"TRUNCATE {tables} RESTART IDENTITY CASCADE")
    conn.commit()


@contextmanager
def copy_into(
    conn: psycopg.Connection, table: str, columns: Sequence[str]
) -> Iterator[psycopg.Copy]:
    column_list = ", ".join(columns)
    with conn.cursor() as cur:
        with cur.copy(f"COPY {table} ({column_list}) FROM STDIN") as copy:
            yield copy


def copy_rows(
    conn: psycopg.Connection,
    table: str,
    columns: Sequence[str],
    rows: Iterable[tuple],
) -> int:
    count = 0
    with copy_into(conn, table, columns) as copy:
        for row in rows:
            copy.write_row(row)
            count += 1
    return count


def resync_sequence(conn: psycopg.Connection, table: str, column: str = "id") -> None:
    """Point a serial sequence past the highest seeded value.

    COPY supplies explicit ids for the large tables, which leaves the sequence
    at 1. Without this, the first row the application inserts collides.
    """
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT setval(
                pg_get_serial_sequence('{table}', '{column}'),
                COALESCE((SELECT MAX({column}) FROM {table}), 1)
            )
            """
        )


class Stage:
    """Times one load stage and prints a single progress line."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.started = 0.0

    def __enter__(self) -> "Stage":
        self.started = time.perf_counter()
        print(f"  {self.label:<28} ...", end="", flush=True)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        elapsed = time.perf_counter() - self.started
        if exc_type is None:
            print(f"\r  {self.label:<28} {self.rows:>9,} rows  {elapsed:6.1f}s")
        else:
            print(f"\r  {self.label:<28} FAILED after {elapsed:6.1f}s")

    rows: int = 0
