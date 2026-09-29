"""Initial Voyager schema: 21 tables and their indexes.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-09-29

The DDL is written out longhand rather than generated from declarative models
so that the committed migration reads the same as 05-FUNCTIONALITY.md § 3.
Anyone can diff the two.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

from sqlsplit import split_statements

revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# --------------------------------------------------------------- reference --

REFERENCE_TABLES = """
CREATE TABLE voyager.cities (
    id              SERIAL PRIMARY KEY,
    name            TEXT        NOT NULL,
    country_code    CHAR(2)     NOT NULL,
    region          TEXT,
    latitude        NUMERIC(9,6),
    longitude       NUMERIC(9,6),
    popularity_rank INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE voyager.airports (
    iata_code    CHAR(3) PRIMARY KEY,
    icao_code    CHAR(4),
    name         TEXT        NOT NULL,
    city_id      INT         REFERENCES voyager.cities (id),
    country_code CHAR(2)     NOT NULL,
    latitude     NUMERIC(9,6),
    longitude    NUMERIC(9,6),
    timezone     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE voyager.airlines (
    iata_code  CHAR(2) PRIMARY KEY,
    name       TEXT        NOT NULL,
    alliance   TEXT,
    logo_seed  INT         NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE voyager.flights (
    id               BIGSERIAL PRIMARY KEY,
    flight_number    TEXT        NOT NULL,
    airline_code     CHAR(2)     NOT NULL REFERENCES voyager.airlines (iata_code),
    origin           CHAR(3)     NOT NULL REFERENCES voyager.airports (iata_code),
    destination      CHAR(3)     NOT NULL REFERENCES voyager.airports (iata_code),
    depart_at        TIMESTAMPTZ NOT NULL,
    arrive_at        TIMESTAMPTZ NOT NULL,
    aircraft_type    TEXT,
    duration_minutes INT         NOT NULL,
    base_price_cents INT         NOT NULL,
    currency         CHAR(3)     NOT NULL DEFAULT 'GBP',
    seats_total      INT         NOT NULL,
    seats_available  INT         NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_flights_route       CHECK (origin <> destination),
    CONSTRAINT ck_flights_seats       CHECK (seats_available BETWEEN 0 AND seats_total)
);

CREATE TABLE voyager.fare_classes (
    code              TEXT PRIMARY KEY,
    cabin             TEXT        NOT NULL,
    name              TEXT        NOT NULL,
    refundable        BOOLEAN     NOT NULL DEFAULT false,
    changeable        BOOLEAN     NOT NULL DEFAULT false,
    baggage_included  INT         NOT NULL DEFAULT 0,
    points_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_fare_classes_cabin
        CHECK (cabin IN ('economy','economy_plus','business','first'))
);

-- ~2,000 rows. pricing-service loops over these; the volume is the point
-- (05-FUNCTIONALITY.md § 7.1).
CREATE TABLE voyager.fare_rules (
    id                    SERIAL PRIMARY KEY,
    fare_class_code       TEXT        NOT NULL REFERENCES voyager.fare_classes (code),
    route_pattern         TEXT        NOT NULL,
    applies_from          DATE        NOT NULL,
    applies_to            DATE        NOT NULL,
    day_of_week_mask      INT         NOT NULL DEFAULT 127,
    advance_purchase_days INT         NOT NULL DEFAULT 0,
    min_stay_days         INT,
    max_stay_days         INT,
    adjustment_type       TEXT        NOT NULL,
    adjustment_value      NUMERIC(10,2) NOT NULL,
    priority              INT         NOT NULL DEFAULT 0,
    conditions            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_fare_rules_adjustment_type
        CHECK (adjustment_type IN ('percent','fixed'))
);

CREATE TABLE voyager.hotels (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT        NOT NULL,
    city_id      INT         NOT NULL REFERENCES voyager.cities (id),
    address      TEXT,
    star_rating  SMALLINT    NOT NULL,
    review_score NUMERIC(3,1),
    review_count INT         NOT NULL DEFAULT 0,
    latitude     NUMERIC(9,6),
    longitude    NUMERIC(9,6),
    amenities    TEXT[]      NOT NULL DEFAULT '{}',
    image_seed   INT         NOT NULL,
    neighborhood TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_hotels_star_rating CHECK (star_rating BETWEEN 1 AND 5)
);

CREATE TABLE voyager.room_types (
    id            SERIAL PRIMARY KEY,
    hotel_id      BIGINT      NOT NULL REFERENCES voyager.hotels (id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    max_occupancy SMALLINT    NOT NULL,
    bed_config    TEXT,
    size_sqm      INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE voyager.rate_plans (
    id                  BIGSERIAL PRIMARY KEY,
    room_type_id        INT         NOT NULL REFERENCES voyager.room_types (id) ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    breakfast_included  BOOLEAN     NOT NULL DEFAULT false,
    refundable          BOOLEAN     NOT NULL DEFAULT true,
    cancellation_hours  INT         NOT NULL DEFAULT 24,
    nightly_price_cents INT         NOT NULL,
    currency            CHAR(3)     NOT NULL DEFAULT 'GBP',
    rooms_available     SMALLINT    NOT NULL,
    valid_from          DATE        NOT NULL,
    valid_to            DATE        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


# ----------------------------------------------------------- transactional --

TRANSACTIONAL_TABLES = """
CREATE TABLE voyager.users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    first_name    TEXT        NOT NULL,
    last_name     TEXT        NOT NULL,
    phone         TEXT,
    tier          TEXT        NOT NULL DEFAULT 'standard',
    signup_cohort TEXT,
    locale        TEXT        NOT NULL DEFAULT 'en-GB',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_users_tier
        CHECK (tier IN ('standard','silver','gold','platinum'))
);

-- user_id NULL means a guest booking.
CREATE TABLE voyager.bookings (
    id                  UUID PRIMARY KEY,
    -- Uniqueness comes from idx_bookings_pnr below rather than an inline
    -- UNIQUE, so there is exactly one index on this column.
    pnr                 CHAR(6),
    user_id             UUID        REFERENCES voyager.users (id),
    product_type        TEXT        NOT NULL,
    state               TEXT        NOT NULL,
    currency            CHAR(3)     NOT NULL DEFAULT 'GBP',
    subtotal_cents      INT         NOT NULL DEFAULT 0,
    taxes_cents         INT         NOT NULL DEFAULT 0,
    ancillaries_cents   INT         NOT NULL DEFAULT 0,
    total_cents         INT         NOT NULL DEFAULT 0,
    search_id           TEXT,
    result_id           TEXT,
    contact_email       TEXT,
    contact_phone       TEXT,
    hold_expires_at     TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    cancellation_reason TEXT,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_bookings_product_type
        CHECK (product_type IN ('flight','hotel')),
    -- The eight states of § 4.1. EXPIRED and REFUNDED are the only terminal
    -- ones; the transition rules themselves live in the domain layer.
    CONSTRAINT ck_bookings_state
        CHECK (state IN ('DRAFT','HELD','PENDING_PAYMENT','CONFIRMED',
                         'FAILED','EXPIRED','CANCELLED','REFUNDED')),
    -- A PNR is issued only on CONFIRMED, and survives cancellation/refund.
    CONSTRAINT ck_bookings_pnr_requires_confirmation
        CHECK (pnr IS NULL OR state IN ('CONFIRMED','CANCELLED','REFUNDED'))
);

CREATE TABLE voyager.booking_items (
    id                BIGSERIAL PRIMARY KEY,
    booking_id        UUID        NOT NULL REFERENCES voyager.bookings (id) ON DELETE CASCADE,
    item_type         TEXT        NOT NULL,
    flight_id         BIGINT      REFERENCES voyager.flights (id),
    rate_plan_id      BIGINT      REFERENCES voyager.rate_plans (id),
    fare_class_code   TEXT        REFERENCES voyager.fare_classes (code),
    description       TEXT        NOT NULL,
    quantity          SMALLINT    NOT NULL DEFAULT 1,
    unit_price_cents  INT         NOT NULL,
    total_price_cents INT         NOT NULL,
    item_metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_booking_items_item_type
        CHECK (item_type IN ('flight_segment','room_night','seat',
                             'baggage','upgrade','insurance'))
);

CREATE TABLE voyager.passengers (
    id                    BIGSERIAL PRIMARY KEY,
    booking_id            UUID        NOT NULL REFERENCES voyager.bookings (id) ON DELETE CASCADE,
    passenger_type        TEXT        NOT NULL,
    title                 TEXT,
    first_name            TEXT        NOT NULL,
    last_name             TEXT        NOT NULL,
    date_of_birth         DATE        NOT NULL,
    nationality           CHAR(2),
    passport_number       TEXT,
    seat_assignment       TEXT,
    frequent_flyer_number TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_passengers_type
        CHECK (passenger_type IN ('adult','child','infant'))
);

CREATE TABLE voyager.inventory_holds (
    id            UUID PRIMARY KEY,
    booking_id    UUID        NOT NULL REFERENCES voyager.bookings (id) ON DELETE CASCADE,
    resource_type TEXT        NOT NULL,
    resource_id   BIGINT      NOT NULL,
    quantity      SMALLINT    NOT NULL DEFAULT 1,
    state         TEXT        NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    released_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_inventory_holds_resource_type
        CHECK (resource_type IN ('flight_seat','hotel_room')),
    CONSTRAINT ck_inventory_holds_state
        CHECK (state IN ('active','released','consumed','expired'))
);

CREATE TABLE voyager.payments (
    id                     UUID PRIMARY KEY,
    booking_id             UUID        NOT NULL REFERENCES voyager.bookings (id) ON DELETE CASCADE,
    provider               TEXT        NOT NULL DEFAULT 'mockpay',
    provider_reference     TEXT,
    idempotency_key        TEXT        NOT NULL,
    amount_cents           INT         NOT NULL,
    currency               CHAR(3)     NOT NULL DEFAULT 'GBP',
    state                  TEXT        NOT NULL,
    card_last4             CHAR(4),
    card_brand             TEXT,
    decline_code           TEXT,
    failure_message        TEXT,
    requires_3ds           BOOLEAN     NOT NULL DEFAULT false,
    authorized_at          TIMESTAMPTZ,
    captured_at            TIMESTAMPTZ,
    refunded_at            TIMESTAMPTZ,
    refunded_amount_cents  INT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_payments_idem UNIQUE (idempotency_key),
    -- DECLINED is a business outcome, ERROR is an infrastructure failure.
    -- Keeping them distinct is what keeps the error rate honest (§ 4.2).
    CONSTRAINT ck_payments_state
        CHECK (state IN ('CREATED','AUTHORIZING','AUTHORIZED','CAPTURED',
                         'REFUNDED','PARTIALLY_REFUNDED','DECLINED',
                         'REQUIRES_3DS','ERROR'))
);

CREATE TABLE voyager.payment_events (
    id               BIGSERIAL PRIMARY KEY,
    payment_id       UUID        NOT NULL REFERENCES voyager.payments (id) ON DELETE CASCADE,
    event_type       TEXT        NOT NULL,
    from_state       TEXT,
    to_state         TEXT,
    provider_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
    trace_id         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE voyager.loyalty_accounts (
    user_id           UUID PRIMARY KEY REFERENCES voyager.users (id) ON DELETE CASCADE,
    points_balance    INT         NOT NULL DEFAULT 0,
    lifetime_points   INT         NOT NULL DEFAULT 0,
    tier              TEXT        NOT NULL DEFAULT 'standard',
    tier_qualified_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_loyalty_accounts_tier
        CHECK (tier IN ('standard','silver','gold','platinum'))
);

CREATE TABLE voyager.loyalty_transactions (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID        NOT NULL REFERENCES voyager.users (id) ON DELETE CASCADE,
    booking_id       UUID        REFERENCES voyager.bookings (id) ON DELETE SET NULL,
    transaction_type TEXT        NOT NULL,
    points           INT         NOT NULL,
    balance_after    INT         NOT NULL,
    description      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_loyalty_transactions_type
        CHECK (transaction_type IN ('accrual','redemption','adjustment','expiry'))
);

CREATE TABLE voyager.support_conversations (
    id         UUID PRIMARY KEY,
    user_id    UUID        REFERENCES voyager.users (id) ON DELETE SET NULL,
    booking_id UUID        REFERENCES voyager.bookings (id) ON DELETE SET NULL,
    state      TEXT        NOT NULL DEFAULT 'open',
    intent     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_support_conversations_state
        CHECK (state IN ('open','resolved','escalated'))
);

CREATE TABLE voyager.support_messages (
    id                BIGSERIAL PRIMARY KEY,
    conversation_id   UUID        NOT NULL REFERENCES voyager.support_conversations (id) ON DELETE CASCADE,
    role              TEXT        NOT NULL,
    content           TEXT,
    tool_name         TEXT,
    tool_args         JSONB,
    tool_result       JSONB,
    tokens_prompt     INT,
    tokens_completion INT,
    latency_ms        INT,
    trace_id          TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_support_messages_role
        CHECK (role IN ('user','assistant','tool','system'))
);

CREATE TABLE voyager.idempotency_records (
    key             TEXT PRIMARY KEY,
    endpoint        TEXT        NOT NULL,
    request_hash    TEXT        NOT NULL,
    response_status INT,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
"""


# ------------------------------------------------------------------ indexes --

INDEXES = """
-- Search path
CREATE INDEX idx_flights_route_date ON voyager.flights (origin, destination, depart_at);
CREATE INDEX idx_flights_airline ON voyager.flights (airline_code);
CREATE INDEX idx_hotels_city ON voyager.hotels (city_id, review_score DESC);
CREATE INDEX idx_rate_plans_room_valid ON voyager.rate_plans (room_type_id, valid_from, valid_to);
CREATE INDEX idx_fare_rules_class_priority ON voyager.fare_rules (fare_class_code, priority DESC);

-- The star of scenario S3. Chaos flag db_drop_index drops this index; with
-- 400k bookings its absence turns a millisecond seek into a full scan.
-- chaos reset recreates it with exactly this definition.
CREATE INDEX idx_bookings_user_id_created_at ON voyager.bookings (user_id, created_at DESC);

CREATE UNIQUE INDEX idx_bookings_pnr ON voyager.bookings (pnr);
CREATE INDEX idx_bookings_state_hold ON voyager.bookings (state, hold_expires_at)
  WHERE state IN ('HELD','PENDING_PAYMENT');
CREATE INDEX idx_booking_items_booking ON voyager.booking_items (booking_id);
CREATE INDEX idx_passengers_booking ON voyager.passengers (booking_id);
CREATE INDEX idx_holds_expiry ON voyager.inventory_holds (state, expires_at) WHERE state = 'active';
CREATE INDEX idx_payments_booking ON voyager.payments (booking_id);
CREATE INDEX idx_payment_events_payment ON voyager.payment_events (payment_id, created_at);
CREATE INDEX idx_loyalty_tx_user ON voyager.loyalty_transactions (user_id, created_at DESC);
CREATE INDEX idx_support_msgs_conv ON voyager.support_messages (conversation_id, created_at);
"""


DROP_ALL = """
DROP TABLE IF EXISTS voyager.idempotency_records,
                     voyager.support_messages,
                     voyager.support_conversations,
                     voyager.loyalty_transactions,
                     voyager.loyalty_accounts,
                     voyager.payment_events,
                     voyager.payments,
                     voyager.inventory_holds,
                     voyager.passengers,
                     voyager.booking_items,
                     voyager.bookings,
                     voyager.users,
                     voyager.rate_plans,
                     voyager.room_types,
                     voyager.hotels,
                     voyager.fare_rules,
                     voyager.fare_classes,
                     voyager.flights,
                     voyager.airlines,
                     voyager.airports,
                     voyager.cities
CASCADE;
"""


def run_script(script: str) -> None:
    for statement in split_statements(script):
        op.execute(statement)


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS voyager")
    run_script(REFERENCE_TABLES)
    run_script(TRANSACTIONAL_TABLES)
    run_script(INDEXES)


def downgrade() -> None:
    run_script(DROP_ALL)
