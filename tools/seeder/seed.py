#!/usr/bin/env python3
"""Voyager seeder.

Truncate-then-load, deterministic from SEED_RANDOM_SEED, streamed through
COPY FROM STDIN. Target volumes and the reasons behind them are in
01-PRD.md § 9; the budget is under five minutes on the target instance.

    python seed.py --yes          load everything
    python seed.py --verify-only  re-run the exit-criteria checks
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time

from voyager_seed import accounts, bookings, db, inventory, reference, support
from voyager_seed.config import DEMO_PASSWORD, load_config


def stage_rng(base_seed: int, label: str) -> random.Random:
    """One RNG per stage, so adding a table never shifts another's output."""
    return random.Random(f"{base_seed}:{label}")


def load(config, connection) -> None:
    volumes = config.volumes
    print(
        f"seeding with SEED_RANDOM_SEED={config.random_seed} "
        f"anchor={config.anchor_date.isoformat()}"
    )

    print("\ntruncating...")
    db.truncate_all(connection)

    # ---------------------------------------------------------- reference --
    print("\nreference data")
    airports = reference.select_airports(config)
    cities = reference.build_cities(config, airports)

    with db.Stage("cities") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.cities", reference.CITY_COLUMNS,
            reference.city_rows(cities),
        )
    with db.Stage("airports") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.airports", reference.AIRPORT_COLUMNS,
            reference.airport_rows(airports, cities),
        )
    with db.Stage("airlines") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.airlines", reference.AIRLINE_COLUMNS,
            reference.airline_rows(stage_rng(config.random_seed, "airlines")),
        )
    with db.Stage("fare_classes") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.fare_classes", reference.FARE_CLASS_COLUMNS,
            reference.fare_class_rows(),
        )
    with db.Stage("fare_rules") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.fare_rules", reference.FARE_RULE_COLUMNS,
            reference.fare_rule_rows(
                config,
                stage_rng(config.random_seed, "fare_rules"),
                [a["iata"] for a in airports],
            ),
        )
    connection.commit()

    # ---------------------------------------------------------- inventory --
    print("\ninventory")
    routes = inventory.build_routes(
        config, stage_rng(config.random_seed, "routes"), airports
    )
    flights = inventory.FlightGenerator(
        config=config,
        rng=stage_rng(config.random_seed, "flights"),
        routes=routes,
    )
    with db.Stage("flights") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.flights", inventory.FLIGHT_COLUMNS, flights.rows()
        )

    hotels = inventory.HotelGenerator(
        config=config,
        rng=stage_rng(config.random_seed, "hotels"),
        cities=cities,
    )
    with db.Stage("hotels") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.hotels", inventory.HOTEL_COLUMNS, hotels.hotel_rows()
        )
    with db.Stage("room_types") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.room_types", inventory.ROOM_TYPE_COLUMNS,
            hotels.room_type_rows(),
        )
    with db.Stage("rate_plans") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.rate_plans", inventory.RATE_PLAN_COLUMNS,
            hotels.rate_plan_rows(),
        )
    connection.commit()

    # ----------------------------------------------------------- accounts --
    print("\naccounts")
    users = accounts.build_users(config, stage_rng(config.random_seed, "users"))
    with db.Stage("users") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.users", accounts.USER_COLUMNS,
            accounts.user_rows(config, stage_rng(config.random_seed, "user_rows"), users),
        )
    with db.Stage("loyalty_accounts") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.loyalty_accounts", accounts.LOYALTY_ACCOUNT_COLUMNS,
            accounts.loyalty_account_rows(
                config, stage_rng(config.random_seed, "loyalty"), users
            ),
        )
    connection.commit()

    # ----------------------------------------------------------- bookings --
    print("\nbookings")
    ownership = bookings.build_ownership(
        config, stage_rng(config.random_seed, "ownership"), users
    )
    factory = bookings.BookingFactory(
        config=config,
        users=users,
        routes=routes,
        upcoming_flight_ids=flights.upcoming_flight_ids,
        rate_plan_count=hotels.total_rate_plans,
        ownership=ownership,
    )

    for label, table, columns, rows in (
        ("bookings", "voyager.bookings", bookings.BOOKING_COLUMNS,
         bookings.booking_rows),
        ("booking_items", "voyager.booking_items", bookings.BOOKING_ITEM_COLUMNS,
         bookings.booking_item_rows),
        ("passengers", "voyager.passengers", bookings.PASSENGER_COLUMNS,
         bookings.passenger_rows),
        ("inventory_holds", "voyager.inventory_holds", bookings.HOLD_COLUMNS,
         bookings.hold_rows),
        ("payments", "voyager.payments", bookings.PAYMENT_COLUMNS,
         bookings.payment_rows),
        ("payment_events", "voyager.payment_events", bookings.PAYMENT_EVENT_COLUMNS,
         bookings.payment_event_rows),
        ("loyalty_transactions", "voyager.loyalty_transactions",
         bookings.LOYALTY_TRANSACTION_COLUMNS, bookings.loyalty_transaction_rows),
    ):
        with db.Stage(label) as stage:
            stage.rows = db.copy_rows(connection, table, columns, rows(factory))
        connection.commit()

    # An active hold means a seat is genuinely spoken for, so the seeded
    # inventory has to reflect that. Without this the world is inconsistent
    # the moment the sweeper runs: it hands back seats that were never taken
    # and trips ck_flights_seats.
    with db.Stage("apply_active_holds") as stage:
        stage.rows = _apply_active_holds(connection)
    connection.commit()

    # ------------------------------------------------------------ support --
    print("\nsupport")
    conversations = support.pick_conversation_bookings(
        factory, volumes.support_conversations
    )
    with db.Stage("support_conversations") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.support_conversations", support.CONVERSATION_COLUMNS,
            support.conversation_rows(
                conversations, stage_rng(config.random_seed, "conversations")
            ),
        )
    with db.Stage("support_messages") as stage:
        stage.rows = db.copy_rows(
            connection, "voyager.support_messages", support.MESSAGE_COLUMNS,
            support.message_rows(
                conversations, stage_rng(config.random_seed, "messages")
            ),
        )
    connection.commit()

    # ------------------------------------------------------------- finish --
    print("\nfinalising")
    with db.Stage("sequences") as stage:
        for table in (
            "voyager.cities", "voyager.flights", "voyager.fare_rules",
            "voyager.hotels", "voyager.room_types", "voyager.rate_plans",
            "voyager.booking_items", "voyager.passengers",
            "voyager.payment_events", "voyager.loyalty_transactions",
            "voyager.support_messages",
        ):
            db.resync_sequence(connection, table)
        stage.rows = 0
    connection.commit()

    # Without fresh statistics the planner has no idea the tables are large,
    # and the S3 explain-plan comparison is meaningless.
    with db.Stage("analyze") as stage:
        connection.rollback()
        previous = connection.autocommit
        connection.autocommit = True
        with connection.cursor() as cur:
            cur.execute("ANALYZE")
        connection.autocommit = previous
        stage.rows = 0


# ------------------------------------------------------------ verification --

EXPECTED = {
    "voyager.bookings": 400_000,
    "voyager.flights": 150_000,
    "voyager.fare_rules": 2_000,
}


def _apply_active_holds(connection) -> int:
    """Debit seeded inventory for every hold that is still active.

    Clamped with GREATEST so a flight that is heavily held cannot go
    negative; the alternative is a check-constraint failure in the middle of
    a seed, which is far harder to read than a flight that simply sells out.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH held AS (
                SELECT resource_id, SUM(quantity) AS seats
                FROM voyager.inventory_holds
                WHERE state = 'active' AND resource_type = 'flight_seat'
                GROUP BY resource_id
            )
            UPDATE voyager.flights f
            SET seats_available = GREATEST(f.seats_available - held.seats, 0)
            FROM held WHERE f.id = held.resource_id
            """
        )
        flights = cursor.rowcount or 0

        cursor.execute(
            """
            WITH held AS (
                SELECT resource_id, SUM(quantity) AS rooms
                FROM voyager.inventory_holds
                WHERE state = 'active' AND resource_type = 'hotel_room'
                GROUP BY resource_id
            )
            UPDATE voyager.rate_plans r
            SET rooms_available = GREATEST(r.rooms_available - held.rooms, 0)
            FROM held WHERE r.id = held.resource_id
            """
        )
        rooms = cursor.rowcount or 0
    return flights + rooms


def verify(config, connection) -> bool:
    print("\nverification (03-EXECUTION-ORDER.md phase 1 exit criteria)")
    ok = True

    with connection.cursor() as cur:
        for table in db.TABLES_IN_LOAD_ORDER:
            cur.execute(f"SELECT count(*) FROM {table}")
            count = cur.fetchone()[0]
            minimum = EXPECTED.get(table)
            flag = ""
            if minimum is not None:
                good = count >= minimum
                ok = ok and good
                flag = f"  (>= {minimum:,} required: {'PASS' if good else 'FAIL'})"
            print(f"  {table:<34} {count:>9,}{flag}")

        # Flight schedules must reach the end of the 360-day search window.
        cur.execute(
            "SELECT min(depart_at)::date, max(depart_at)::date FROM voyager.flights"
        )
        first, last = cur.fetchone()
        horizon = (last - config.anchor_date).days if last else 0
        good = horizon >= 360
        ok = ok and good
        print(
            f"\n  schedule window  {first} -> {last}  "
            f"({horizon} days forward: {'PASS' if good else 'FAIL'})"
        )

        # The 20 power users are what make scenario S3 demonstrable.
        cur.execute(
            """
            SELECT u.email, count(b.id) AS bookings
            FROM voyager.users u
            JOIN voyager.bookings b ON b.user_id = u.id
            WHERE u.email LIKE 'power%@voyager.demo'
            GROUP BY u.email
            ORDER BY u.email
            """
        )
        rows = cur.fetchall()
        in_range = [r for r in rows if 300 <= r[1] <= 800]
        good = len(rows) == 20 and len(in_range) == 20
        ok = ok and good
        counts = sorted(r[1] for r in rows)
        print(
            f"  power users      {len(rows)} accounts, "
            f"{counts[0] if counts else 0}-{counts[-1] if counts else 0} bookings each "
            f"(300-800 required: {'PASS' if good else 'FAIL'})"
        )
        print(f"                   password for every seeded account: {DEMO_PASSWORD}")

        # The /account page query. Phase 10 compares this plan against the one
        # produced with db_drop_index=true.
        cur.execute(
            """
            SELECT u.id FROM voyager.users u
            WHERE u.email = 'power1@voyager.demo'
            """
        )
        power_user = cur.fetchone()[0]
        cur.execute(
            """
            EXPLAIN (ANALYZE, BUFFERS)
            SELECT * FROM voyager.bookings
            WHERE user_id = %s
            ORDER BY created_at DESC
            LIMIT 20
            """,
            (power_user,),
        )
        plan = "\n".join(line[0] for line in cur.fetchall())
        uses_index = "idx_bookings_user_id_created_at" in plan
        ok = ok and uses_index
        print(
            f"\n  GET /bookings/mine plan "
            f"({'Index Scan: PASS' if uses_index else 'NOT using the index: FAIL'})"
        )
        for line in plan.splitlines():
            print(f"    {line}")

        # Money has to add up (05-FUNCTIONALITY.md § 15).
        cur.execute(
            """
            SELECT count(*) FROM (
                SELECT b.id
                FROM voyager.bookings b
                JOIN voyager.booking_items i ON i.booking_id = b.id
                GROUP BY b.id, b.subtotal_cents, b.ancillaries_cents, b.total_cents,
                         b.taxes_cents
                HAVING sum(i.total_price_cents)
                       <> b.subtotal_cents + b.ancillaries_cents
                    OR b.total_cents
                       <> b.subtotal_cents + b.taxes_cents + b.ancillaries_cents
                LIMIT 5
            ) AS mismatched
            """
        )
        mismatched = cur.fetchone()[0]
        good = mismatched == 0
        ok = ok and good
        print(
            f"\n  booking totals reconcile with booking_items "
            f"({'PASS' if good else f'{mismatched} mismatched: FAIL'})"
        )

    print(f"\n  overall: {'PASS' if ok else 'FAIL'}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the Voyager database.")
    parser.add_argument(
        "--yes", "-y", action="store_true",
        help="confirm the destructive truncate-then-load",
    )
    parser.add_argument(
        "--verify-only", action="store_true",
        help="re-run the phase 1 exit-criteria checks against existing data",
    )
    args = parser.parse_args()

    config = load_config()
    connection = db.connect(config.dsn)

    try:
        if not args.verify_only:
            if not args.yes and os.environ.get("SEED_CONFIRM") != "yes":
                print(
                    "refusing to run: seeding truncates every table.\n"
                    "pass --yes, or set SEED_CONFIRM=yes.",
                    file=sys.stderr,
                )
                return 2
            started = time.perf_counter()
            load(config, connection)
            print(f"\nload completed in {time.perf_counter() - started:.1f}s")

        return 0 if verify(config, connection) else 1
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
