# 05 — Functionality Specification

The implementation contract. Every API, table, topic, flag, metric, log field, and error type. **Cursor: this is the document you will refer back to most often. When you need to know what something is called, look here.**

---

## 1. Service responsibilities

| Service | Owns | Never does |
|---|---|---|
| `api-gateway` | Auth, BFF aggregation, rate limiting, admin API | Business logic, direct DB writes to domain tables |
| `search-service` | Search orchestration, GDS fan-out, result caching | Pricing math, booking state |
| `pricing-service` | Fare and rate computation, tax rules, ancillary pricing | Any I/O beyond reading fare rules from Postgres |
| `booking-service` | Booking lifecycle, inventory holds, PNR issuance, schema migrations | Talking to the payment provider directly |
| `payment-service` | Authorization, capture, refund, idempotency, the payment ledger | Deciding whether a booking is confirmed |
| `loyalty-service` | Points accrual, tier calculation | Blocking the booking path |
| `notification-worker` | Rendering and sending itineraries | Anything synchronous with checkout |
| `ai-support-service` | Support conversations, LLM orchestration, tool execution | Mutating bookings directly — it calls `booking-service` |

**Hard rule:** only `booking-service` runs migrations. Only the service that owns a table writes to it. Cross-service reads go over HTTP. This is what keeps the service map honest.

---

## 2. API Gateway — public API

Base path `/api/v1`. All responses JSON. All errors use the envelope in § 13.2.

### 2.1 Auth

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/auth/signup` | `{email, password, firstName, lastName}` → `{user, accessToken, refreshToken}` |
| `POST` | `/auth/login` | `{email, password}` → same |
| `POST` | `/auth/refresh` | `{refreshToken}` → `{accessToken}` |
| `POST` | `/auth/logout` | Invalidates the refresh token |
| `GET` | `/auth/me` | → `{id, email, firstName, lastName, tier, loyaltyPoints}` |

Access token: JWT, 15-minute expiry, claims `sub`, `email`, `tier`. Refresh token: opaque, 30 days, stored in Redis. Passwords: bcrypt, cost 12.

### 2.2 Reference data

| Method | Path | Notes |
|---|---|---|
| `GET` | `/ref/airports?q=lon&limit=8` | Autocomplete. 250 ms debounce client-side, 1 h Redis cache. |
| `GET` | `/ref/cities?q=bar&limit=8` | Same, for hotels |
| `GET` | `/ref/airlines` | Full list, 24 h cache |

### 2.3 Search

```http
POST /api/v1/search/flights
{
  "origin": "LHR", "destination": "JFK",
  "departDate": "2026-10-20", "returnDate": "2026-10-27",
  "passengers": { "adults": 1, "children": 0, "infants": 0 },
  "cabin": "economy",
  "sort": "price_asc",
  "filters": { "maxStops": 1, "airlines": ["VY","AT"], "departWindow": ["06:00","12:00"] }
}
→ 200
{
  "searchId": "srch_01J8...",
  "cacheHit": false,
  "providersQueried": 4, "providersResponded": 4,
  "resultCount": 34,
  "results": [ { "id":"fr_...", "segments":[…], "fare":{…}, "airline":{…}, "durationMinutes":400 } ],
  "requestId": "<trace id>"
}
```

`POST /search/hotels` is structurally identical (`city`, `checkIn`, `checkOut`, `guests`, `rooms`).

`GET /search/{searchId}/results?page=1&size=20&sort=price_asc` — paginated retrieval from the cached result set. Returns `410 Gone` if the cached set has expired.

`GET /search/{searchId}/results/{resultId}` — full detail: all segments, fare rules, baggage allowance, seat map availability, cancellation policy.

### 2.4 BFF aggregation endpoints

These exist specifically to make a single frontend request fan out widely — which is both realistic BFF design and what produces genuinely interesting traces.

| Method | Path | Fans out to |
|---|---|---|
| `GET` | `/bff/home` | `ref/airports` (popular), `search-service` (deal cache), `loyalty-service` (user tier), `booking-service` (upcoming trips) — 4 services |
| `POST` | `/bff/checkout/init` | `search-service` (validate result), `pricing-service` (re-price), `booking-service` (create draft + hold), `loyalty-service` (points preview) — 4 services, 6+ calls |
| `GET` | `/bff/booking/{idOrPnr}` | `booking-service` (booking + items + passengers), `payment-service` (payment status), `loyalty-service` (accrual) — 3 services. **Accepts either a booking UUID or a PNR** — the checkout poll uses the UUID, because the PNR does not exist until `CONFIRMED`. |
| `GET` | `/bff/account` | `booking-service` (booking history), `loyalty-service` (balance + transactions), `payment-service` (saved methods) — 3 services |

**Client policy (react-query):** `staleTime` 30 s for search results, 5 min for reference data, 0 for booking state. Retries: 2 with exponential backoff for `GET`, **0 for any `POST` that mutates** — retrying a booking creation is how you get duplicate bookings, and getting this right is itself a good talking point.

### 2.5 Booking

| Method | Path | Notes |
|---|---|---|
| `POST` | `/bookings` | `{searchId, resultId, productType}` → creates `DRAFT` |
| `POST` | `/bookings/{id}/hold` | Reserves inventory, 15-min TTL → `HELD`, returns `holdExpiresAt` |
| `PUT` | `/bookings/{id}/passengers` | Array of passenger objects, validated |
| `PUT` | `/bookings/{id}/ancillaries` | `{seats:[…], baggage:[…], roomUpgrade:…}` — re-prices |
| `POST` | `/bookings/{id}/authorizing` | Internal. `payment-service` calls this before charging a card: `HELD → PENDING_PAYMENT`, or `FAILED → PENDING_PAYMENT` on a retry. Booking state is owned by `booking-service`, so this is the only place that decides whether a booking may enter payment, and a lapsed hold is refused here rather than after the money has moved. |
| `POST` | `/bookings/{id}/confirm` | `{paymentId}` → `CONFIRMED`, issues PNR |
| `GET` | `/bookings/{id}` | Full booking |
| `GET` | `/bookings?pnr=K8M2QR&lastName=Smith` | Guest lookup — no auth required |
| `GET` | `/bookings/mine?page=1&size=20` | Authenticated history. **This is the query that scenario S3 wrecks.** |
| `POST` | `/bookings/{id}/cancel` | `{reason}` → `CANCELLED`, triggers refund |

### 2.6 Payment

| Method | Path | Notes |
|---|---|---|
| `POST` | `/payments/authorize` | `{bookingId, amount, currency, card:{…}, idempotencyKey}`. Requires `Idempotency-Key` header too; body and header must match. |
| `POST` | `/payments/{id}/3ds/complete` | `{challengeResponse}` — the step-up path |
| `GET` | `/payments/{id}` | Status + event history |

### 2.7 Loyalty & support

| Method | Path | Notes |
|---|---|---|
| `GET` | `/loyalty/me` | Balance, tier, progress to next tier, recent transactions |
| `POST` | `/support/conversations` | → `{conversationId}` |
| `POST` | `/support/conversations/{id}/messages` | `{content}` → SSE stream of tokens, tool-call events, and a final message |
| `GET` | `/support/conversations/{id}` | Full history |

### 2.8 Admin

All require header `X-Voyager-Admin: ${ADMIN_SECRET}`. Return `401` otherwise, with no hint about the correct value.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/chaos` | All flags with current values, defaults, types, and descriptions |
| `PUT` | `/admin/chaos` | Partial update: `{"gds_latency_ms": 3000, "db_drop_index": true}` |
| `POST` | `/admin/chaos/reset` | Clear everything, including recreating dropped indexes |
| `GET` | `/admin/scenarios` | The 10 scenario definitions + which is active |
| `POST` | `/admin/scenarios/{id}/apply` | Apply a scenario (resets first, then applies) |
| `POST` | `/admin/scenarios/{id}/revert` | Revert just that scenario's flags |
| `GET` | `/admin/status` | Per-service health, p95, error rate, version; plus DB/Redis/Kafka vitals |
| `POST` | `/admin/loadgen` | `{api:{enabled,intensity}, browser:{enabled,concurrency}}` |
| `POST` | `/admin/seed/reset` | Re-seed (async job, returns a job ID) |
| `POST` | `/admin/version` | `{version}` — override `DD_VERSION` at runtime to fake a deploy for scenario S6 |

---

## 3. Data model

PostgreSQL 16, schema `voyager`. `snake_case` everywhere. All tables have `created_at timestamptz NOT NULL DEFAULT now()` and, where mutable, `updated_at`.

### 3.1 Reference tables

```sql
airports(iata_code CHAR(3) PK, icao_code CHAR(4), name TEXT, city_id INT FK,
         country_code CHAR(2), latitude NUMERIC(9,6), longitude NUMERIC(9,6),
         timezone TEXT)

cities(id SERIAL PK, name TEXT, country_code CHAR(2), region TEXT,
       latitude NUMERIC(9,6), longitude NUMERIC(9,6), popularity_rank INT)

airlines(iata_code CHAR(2) PK, name TEXT, alliance TEXT, logo_seed INT)

flights(id BIGSERIAL PK, flight_number TEXT, airline_code CHAR(2) FK,
        origin CHAR(3) FK, destination CHAR(3) FK,
        depart_at TIMESTAMPTZ, arrive_at TIMESTAMPTZ,
        aircraft_type TEXT, duration_minutes INT,
        base_price_cents INT, currency CHAR(3),
        seats_total INT, seats_available INT)

fare_classes(code TEXT PK, cabin TEXT, name TEXT,
             refundable BOOL, changeable BOOL,
             baggage_included INT, points_multiplier NUMERIC(3,2))

-- ~2,000 rows. pricing-service loops over these; the volume is the point.
fare_rules(id SERIAL PK, fare_class_code TEXT FK, route_pattern TEXT,
           applies_from DATE, applies_to DATE,
           day_of_week_mask INT, advance_purchase_days INT,
           min_stay_days INT, max_stay_days INT,
           adjustment_type TEXT,          -- 'percent' | 'fixed'
           adjustment_value NUMERIC(10,2),
           priority INT, conditions JSONB)

hotels(id BIGSERIAL PK, name TEXT, city_id INT FK, address TEXT,
       star_rating SMALLINT, review_score NUMERIC(3,1), review_count INT,
       latitude NUMERIC(9,6), longitude NUMERIC(9,6),
       amenities TEXT[], image_seed INT, neighborhood TEXT)

room_types(id SERIAL PK, hotel_id BIGINT FK, name TEXT,
           max_occupancy SMALLINT, bed_config TEXT, size_sqm INT)

rate_plans(id BIGSERIAL PK, room_type_id INT FK, name TEXT,
           breakfast_included BOOL, refundable BOOL,
           cancellation_hours INT, nightly_price_cents INT,
           currency CHAR(3), rooms_available SMALLINT,
           valid_from DATE, valid_to DATE)
```

### 3.2 Transactional tables

```sql
users(id UUID PK DEFAULT gen_random_uuid(), email TEXT UNIQUE,
      password_hash TEXT, first_name TEXT, last_name TEXT,
      phone TEXT, tier TEXT DEFAULT 'standard',   -- standard|silver|gold|platinum
      signup_cohort TEXT, locale TEXT DEFAULT 'en-GB', created_at)

bookings(id UUID PK, pnr CHAR(6) UNIQUE, user_id UUID FK NULL,  -- NULL = guest
         product_type TEXT,                 -- 'flight' | 'hotel'
         state TEXT NOT NULL,               -- see § 4.1
         currency CHAR(3),
         subtotal_cents INT, taxes_cents INT, ancillaries_cents INT,
         total_cents INT,
         search_id TEXT, result_id TEXT,
         contact_email TEXT, contact_phone TEXT,
         hold_expires_at TIMESTAMPTZ,
         confirmed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
         cancellation_reason TEXT,
         metadata JSONB,
         created_at, updated_at)

booking_items(id BIGSERIAL PK, booking_id UUID FK,
              item_type TEXT,               -- flight_segment|room_night|seat|baggage|upgrade|insurance
              flight_id BIGINT NULL FK, rate_plan_id BIGINT NULL FK,
              fare_class_code TEXT NULL FK,
              description TEXT, quantity SMALLINT,
              unit_price_cents INT, total_price_cents INT,
              item_metadata JSONB)

passengers(id BIGSERIAL PK, booking_id UUID FK,
           passenger_type TEXT,             -- adult|child|infant
           title TEXT, first_name TEXT, last_name TEXT,
           date_of_birth DATE, nationality CHAR(2),
           passport_number TEXT NULL,       -- seeded as obvious fakes; never real PII
           seat_assignment TEXT NULL, frequent_flyer_number TEXT NULL)

inventory_holds(id UUID PK, booking_id UUID FK,
                resource_type TEXT,         -- 'flight_seat' | 'hotel_room'
                resource_id BIGINT, quantity SMALLINT,
                state TEXT,                 -- active|released|consumed|expired
                expires_at TIMESTAMPTZ, released_at TIMESTAMPTZ,
                created_at)

payments(id UUID PK, booking_id UUID FK,
         provider TEXT DEFAULT 'mockpay',
         provider_reference TEXT,
         idempotency_key TEXT NOT NULL,
         amount_cents INT, currency CHAR(3),
         state TEXT,                        -- see § 4.2
         card_last4 CHAR(4), card_brand TEXT,
         decline_code TEXT NULL, failure_message TEXT NULL,
         requires_3ds BOOL DEFAULT false,
         authorized_at TIMESTAMPTZ, captured_at TIMESTAMPTZ,
         refunded_at TIMESTAMPTZ, refunded_amount_cents INT,
         created_at, updated_at,
         CONSTRAINT uq_payments_idem UNIQUE (idempotency_key))

payment_events(id BIGSERIAL PK, payment_id UUID FK,
               event_type TEXT, from_state TEXT, to_state TEXT,
               provider_payload JSONB, trace_id TEXT, created_at)

loyalty_accounts(user_id UUID PK FK, points_balance INT DEFAULT 0,
                 lifetime_points INT DEFAULT 0, tier TEXT DEFAULT 'standard',
                 tier_qualified_at TIMESTAMPTZ, updated_at)

loyalty_transactions(id BIGSERIAL PK, user_id UUID FK,
                     booking_id UUID NULL FK,
                     transaction_type TEXT,   -- accrual|redemption|adjustment|expiry
                     points INT, balance_after INT,
                     description TEXT, created_at)

support_conversations(id UUID PK, user_id UUID NULL FK,
                      booking_id UUID NULL FK,
                      state TEXT,              -- open|resolved|escalated
                      intent TEXT NULL, created_at, updated_at)

support_messages(id BIGSERIAL PK, conversation_id UUID FK,
                 role TEXT,                    -- user|assistant|tool|system
                 content TEXT,
                 tool_name TEXT NULL, tool_args JSONB NULL, tool_result JSONB NULL,
                 tokens_prompt INT NULL, tokens_completion INT NULL,
                 latency_ms INT NULL, trace_id TEXT NULL, created_at)

idempotency_records(key TEXT PK, endpoint TEXT, request_hash TEXT,
                    response_status INT, response_body JSONB,
                    created_at, expires_at)
```

### 3.3 Indexes

```sql
-- Search path
CREATE INDEX idx_flights_route_date ON flights (origin, destination, depart_at);
CREATE INDEX idx_flights_airline ON flights (airline_code);
CREATE INDEX idx_hotels_city ON hotels (city_id, review_score DESC);
CREATE INDEX idx_rate_plans_room_valid ON rate_plans (room_type_id, valid_from, valid_to);
CREATE INDEX idx_fare_rules_class_priority ON fare_rules (fare_class_code, priority DESC);

-- ★ THE STAR OF SCENARIO S3. Chaos flag db_drop_index drops this.
--   With 400k bookings, its absence turns a millisecond seek into a full scan.
CREATE INDEX idx_bookings_user_id_created_at ON bookings (user_id, created_at DESC);

CREATE UNIQUE INDEX idx_bookings_pnr ON bookings (pnr);
CREATE INDEX idx_bookings_state_hold ON bookings (state, hold_expires_at)
  WHERE state IN ('HELD','PENDING_PAYMENT');
CREATE INDEX idx_booking_items_booking ON booking_items (booking_id);
CREATE INDEX idx_passengers_booking ON passengers (booking_id);
CREATE INDEX idx_holds_expiry ON inventory_holds (state, expires_at) WHERE state = 'active';
CREATE INDEX idx_payments_booking ON payments (booking_id);
CREATE INDEX idx_payment_events_payment ON payment_events (payment_id, created_at);
CREATE INDEX idx_loyalty_tx_user ON loyalty_transactions (user_id, created_at DESC);
CREATE INDEX idx_support_msgs_conv ON support_messages (conversation_id, created_at);
```

---

## 4. State machines

### 4.1 Booking

```
                   ┌──────────────── EXPIRED ◄──────── (hold TTL elapsed, from
                   │                                    HELD or PENDING_PAYMENT)
DRAFT ──hold──► HELD ──passengers+authorize──► PENDING_PAYMENT
                   │                                 │
                   └──user abandons──► CANCELLED     ├──payment.authorized──► CONFIRMED
                                                     └──payment.failed────► FAILED
                                                                               │
CONFIRMED ──cancel──► CANCELLED ──refund.completed──► REFUNDED   FAILED ──retry──► PENDING_PAYMENT
```

**Terminal states are `EXPIRED` and `REFUNDED` only.** `FAILED` can return to `PENDING_PAYMENT` on retry (while the hold lives), and `CANCELLED` can advance to `REFUNDED`.

Legal transitions, exhaustively:

| From | To | Trigger |
|---|---|---|
| `DRAFT` | `HELD` | `POST /hold` succeeds |
| `DRAFT` | `CANCELLED` | user abandons |
| `HELD` | `PENDING_PAYMENT` | payment authorization initiated |
| `HELD` | `EXPIRED` | sweeper finds `hold_expires_at < now()` |
| `HELD` | `CANCELLED` | user abandons |
| `PENDING_PAYMENT` | `CONFIRMED` | `payment.authorized` consumed |
| `PENDING_PAYMENT` | `FAILED` | `payment.failed` consumed |
| `PENDING_PAYMENT` | `EXPIRED` | hold elapsed before payment resolved |
| `FAILED` | `PENDING_PAYMENT` | user retries with a different card (only while the hold is still alive) |
| `CONFIRMED` | `CANCELLED` | `POST /cancel` |
| `CANCELLED` | `REFUNDED` | refund completes |

Everything else raises `InvalidBookingTransitionError` → HTTP 409. There must be a unit test per illegal transition; that test file is a genuinely good artifact to show a developer audience.

**PNR** is issued only on `CONFIRMED`: 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous glyphs), retried on unique-constraint collision.

### 4.2 Payment

```
CREATED ──► AUTHORIZING ──► AUTHORIZED ──► CAPTURED ──► REFUNDED
                │                              │
                ├──► DECLINED                  └──► PARTIALLY_REFUNDED
                ├──► REQUIRES_3DS ──► AUTHORIZING
                └──► ERROR  (provider unreachable / timeout)
```

`DECLINED` is a business outcome (a 200 with a decline code). `ERROR` is an infrastructure failure (a 5xx or timeout). **Keep them distinct** — conflating them is the single most common modelling mistake in payment systems, and separating them makes the Error Tracking demo much sharper.

### 4.3 Inventory hold

`active → consumed` (booking confirmed) | `→ released` (user cancels) | `→ expired` (TTL). The sweeper runs every 30 s, batches 500 at a time, and decrements `flights.seats_available` / `rate_plans.rooms_available` back.

Holds are acquired under a Postgres advisory lock keyed by `hashtext(resource_type || resource_id)` so concurrent holds on the same seat serialize. That lock is what `hold_lock_contention` widens.

---

## 5. Mock third-party contracts

### 5.1 `mock-gds` (port 4900)

```http
POST /gds/v2/flights/availability   → {provider, requestId, offers:[…], searchLatencyMs}
POST /gds/v2/hotels/availability    → {provider, requestId, properties:[…]}
POST /gds/v2/flights/verify         → re-verifies an offer is still bookable
GET  /gds/v2/seatmap/{flightId}
GET  /health
```

Behavior requirements:
- Four simulated providers (`AMDS`, `SABR`, `TRVP`, `DRCT`), each with its own latency profile. `search-service` queries all four in parallel; the slowest determines the response time, which makes the trace waterfall genuinely interesting.
- Latency: log-normal, default p50 180 ms / p95 600 ms / p99 1800 ms.
- Rate limit: 60 req/min per provider → `429` with `Retry-After`. Cache-disabled chaos blows straight through this, which is what makes S4 cascade.
- Baseline failure rate 0.5% → `503`.
- One provider (`TRVP`) returns results ~8% of the time in a *different* schema, so the mapping layer has real work to do — and a real place for a bug to live.

### 5.2 `mock-payments` (port 4910)

```http
POST /v1/charges                    {amount, currency, card, idempotency_key}
POST /v1/charges/{id}/capture
POST /v1/charges/{id}/refund        {amount}
POST /v1/charges/{id}/3ds/complete
GET  /v1/charges/{id}
GET  /health
```

- Honors idempotency keys for 24 h.
- Test card behavior, so demos are deterministic:
  - `4242 4242 4242 4242` → always succeeds
  - `4000 0000 0000 0002` → `card_declined`
  - `4000 0000 0000 9995` → `insufficient_funds`
  - `4000 0000 0000 0069` → `expired_card`
  - `4000 0000 0000 0127` → `do_not_honor`
  - `4100 0000 0000 0019` → `fraud_suspected`
  - `4000 0000 0000 3220` → requires 3DS
  - `4000 0000 0000 0119` → provider `ERROR` (500)
- Default decline rate 2%; overridable by chaos with a configurable decline-code mix drawn from exactly these five codes: `card_declined`, `insufficient_funds`, `expired_card`, `do_not_honor`, `fraud_suspected`.
- Fires a webhook to `payment-service` 1–3 s after authorization, so the async path is real.

### 5.3 `mock-email` (port 4920)

`POST /v1/send`, `GET /outbox?limit=50`, `DELETE /outbox`. Keeps the last 200 messages in memory. Rejects malformed payloads with a 422 — which is how you generate DLQ traffic on demand.

### 5.4 `mock-llm` (port 4930)

OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming), plus `GET /v1/models`.

- Supports `tools` / `tool_choice` and emits well-formed `tool_calls`.
- Returns realistic `usage`: `prompt_tokens` proportional to actual input length, `completion_tokens` proportional to output.
- Time-to-first-token 200–600 ms; then ~25 tokens/sec streamed.
- Intent classification over the incoming message picks from canned-but-varied response families: booking lookup, cancellation policy, change request, baggage query, refund status, general.
- Chaos: `llm_degrade_tools` makes it return prose instead of a tool call; `llm_hallucinate` makes it invent a plausible-but-wrong PNR and itinerary; `llm_latency_ms` slows TTFT.

---

## 6. Kafka topics

Cluster: single broker, KRaft. 3 partitions per topic, RF 1, 7-day retention.

| Topic | Producer | Consumers | Key | Payload |
|---|---|---|---|---|
| `voyager.bookings.events` | `booking-service` | `loyalty-service` (`voyager-loyalty-v1`), `notification-worker` (`voyager-notifications-v1`) | `booking_id` | `booking.created`, `booking.held`, `booking.confirmed`, `booking.cancelled`, `booking.expired` |
| `voyager.payments.events` | `payment-service` | `booking-service` (`voyager-booking-payments-v1`), `notification-worker` | `booking_id` | `payment.authorized`, `payment.captured`, `payment.declined`, `payment.failed`, `payment.refunded` |
| `voyager.notifications.outbound` | `booking-service`, `payment-service` | `notification-worker` (`voyager-notifications-v1`) | `booking_id` | `{template, recipient, variables}` |
| `voyager.notifications.dlq` | `notification-worker` | none (inspected manually) | original key | Original message + `failureReason`, `attemptCount` |
| `voyager.loyalty.accruals` | `loyalty-service` | `notification-worker` | `user_id` | `points.accrued`, `tier.upgraded` |
| `voyager.search.analytics` | `search-service` | none in v1 (deliberate — a high-volume topic with no consumer shows up as a distinct Data Streams shape) | `search_id` | Search event with route, cabin, result count, cache hit |

Partitioning by `booking_id` guarantees per-booking ordering, which matters because `booking.confirmed` must never be processed before `booking.created`.

### 6.1 Envelope (all topics)

```json
{
  "eventId": "evt_01J8...",
  "eventType": "booking.confirmed",
  "eventVersion": 1,
  "occurredAt": "2026-09-29T10:14:22.481Z",
  "producer": "voyager-booking",
  "traceId": "<dd trace id>",
  "correlationId": "<request id>",
  "payload": { }
}
```

Datadog trace context is carried in **Kafka message headers** by the tracers (via `DD_DATA_STREAMS_ENABLED=true`), not in the body. The `traceId` in the body is for human debugging and log correlation only — do not use it to reconstruct traces.

---

## 7. Search flow — implementation detail

This is the app's highest-volume path and the one you'll demo most, so it's specified tightly.

1. Gateway validates the request with zod, resolves the user (optional), and forwards to `search-service`.
2. `search-service` normalizes the request into a canonical form (sorted filters, dates to UTC, uppercase codes) and hashes it → `search:flights:<sha256[:16]>`.
3. **Cache lookup** (span `search.cache_lookup`). Hit → return with `cacheHit: true`, TTL 120 s. This is why the second identical search is 20× faster, and it makes the `redis_disabled` flag dramatic.
4. **Miss** → `search.fanout` span: four parallel calls to `mock-gds`, one child span each, tagged `gds.provider`. 3-second per-provider timeout; partial results are acceptable and reported in `providersResponded`.
5. **Normalize** (span `search.normalize_results`) — map all four provider schemas, including `TRVP`'s alternate shape, into the canonical offer model.
6. **Batch price** (span `search.price_results`) — one call to `pricing-service` `POST /v1/price/batch` with up to 50 offers. Inside pricing: `pricing.load_rules` (from memory), `pricing.evaluate_fare_rules`, `pricing.apply_taxes`.
7. Sort, store the full result set in Redis, return the first page.
8. Emit to `voyager.search.analytics` and increment `voyager.search.requests` with tags `origin`, `destination`, `cabin`, `cache_hit`, `provider_count`.

**Trace shape target for a cold flight search: ~22 spans.** A checkout builds on this and reaches 40+.

### 7.1 The pricing hot path (the profiler's target)

Normal mode: fare rules are pre-indexed at load time into `map[routePattern][]Rule`, so evaluating an offer touches ~5 rules.

`pricing_hot_path=true`: the index is bypassed and every offer is evaluated against **all ~2,000 rules**, with route-pattern matching done by regex compilation *inside* the loop. For a 50-offer batch that is 100,000 regex compilations — genuine, attributable CPU work that the profiler will attribute to `evaluateFareRules` and `regexp.MustCompile`.

This is the correct way to build a profiling demo: real inefficient code of a kind that actually appears in production, not an artificial spin loop. The audience recognizes it.

---

## 8. Checkout flow — implementation detail

1. `POST /bff/checkout/init` — gateway calls:
   - `search-service` `GET /v1/search/{id}/results/{resultId}` (validate the offer still exists)
   - `mock-gds` `POST /gds/v2/flights/verify` via `search-service` (still bookable?)
   - `pricing-service` re-price (prices can move — a realistic source of a "price changed" UX state)
   - `booking-service` `POST /v1/bookings` → `DRAFT`
   - `booking-service` `POST /v1/bookings/{id}/hold` → `HELD` + `holdExpiresAt`
   - `loyalty-service` points preview
2. `PUT /bookings/{id}/passengers` — validated; infants need an adult, DOB must match passenger type, etc.
3. `PUT /bookings/{id}/ancillaries` — seats/baggage/upgrade; re-prices via `pricing-service`.
4. `POST /payments/authorize` — gateway → `payment-service`:
   - `payment.idempotency_check` (Postgres unique constraint)
   - `payment.build_request`
   - `payment.authorize` → `mock-payments`
   - `payment.persist_ledger` → `payments` + `payment_events`
   - Booking moves to `PENDING_PAYMENT`
   - Emit `payment.authorized` or `payment.declined`
5. `booking-service` consumes `payment.authorized` → `booking.state_transition` → `CONFIRMED`, issues the PNR, consumes the hold, decrements inventory, emits `booking.confirmed`.
6. `loyalty-service` and `notification-worker` consume `booking.confirmed` independently.
7. The frontend polls `GET /bff/booking/{bookingId}` (the UUID — the PNR doesn't exist yet) every 1 s, max 30 s, until `CONFIRMED`, then routes to the confirmation page.

**The polling loop is intentional.** It's how real OTAs handle async confirmation, and during scenario S2 the audience watches the poll spin while the payment provider is brown-out — which is a far better demo than an instant failure.

---

## 9. AI support — implementation detail

Tools available to the model:

| Tool | Args | Calls |
|---|---|---|
| `lookup_booking` | `{pnr, lastName}` | `booking-service` `GET /v1/bookings?pnr=` |
| `get_cancellation_policy` | `{bookingId}` | `booking-service` + `pricing-service` |
| `initiate_cancellation` | `{bookingId, reason}` | `booking-service` `POST /cancel` — **requires explicit user confirmation in the conversation first** |
| `get_loyalty_balance` | `{userId}` | `loyalty-service` |
| `escalate_to_human` | `{conversationId, summary}` | Sets state `escalated`, emits an event |

Span structure for one user message (LLM Observability):

```
workflow: support.handle_message
├── retrieval: support.load_history          (Postgres)
├── llm: chat.completion #1                  (→ mock-llm; tool_calls returned)
├── tool: lookup_booking                     (→ booking-service; a full APM subtree)
├── llm: chat.completion #2                  (final answer with the tool result)
└── task: support.persist_message            (Postgres)
```

Annotate the `llm` spans with `input`, `output`, `model`, `prompt_tokens`, `completion_tokens`, and an estimated cost. Annotate `tool` spans with args and result, plus an error on failure.

`initiate_cancellation` must be gated: the model may only call it after the user has said yes in the conversation. Enforce this in the tool handler, not in the prompt — a prompt-only guard is a demo waiting to embarrass you.

---

## 10. Chaos framework

### 10.1 Storage and semantics

All state lives in a single Redis hash, `voyager:chaos`. Values are JSON-encoded scalars. Every service reads it through its local `chaos` module with a **2-second cache** — long enough to avoid hammering Redis, short enough that a toggle feels instant on stage.

Required behavior:
- **Fails open.** Redis unreachable → all chaos off. A demo must never break because Redis hiccuped.
- **No restarts.** Every flag takes effect on the next request.
- **Reversible.** `POST /admin/chaos/reset` clears the hash and runs any needed compensating action (recreating dropped indexes, resizing pools, resuming consumers, clearing leak caches).
- **Self-describing.** `GET /admin/chaos` returns each flag's type, default, current value, description, and the scenarios that use it — so the admin UI needs no hardcoded flag list.
- **Observable.** Active flags are attached to every trace as span tag `chaos.active_flags` (a sorted, comma-joined string). This is genuinely valuable: six months later you can tell whether a weird trace was a chaos artifact.

### 10.2 Common interface (all three languages)

```
isEnabled(flag: string) -> bool
getValue(flag: string, default: T) -> T
maybeDelay(flag: string) -> void            # fixed | jitter | p99_tail modes
maybeFail(flag: string, errFactory) -> void # probabilistic raise/return
activeFlags() -> string[]                   # for the span tag
```

---

## 11. Chaos flag catalogue

| Flag | Type | Default | Injection point | Scenarios |
|---|---|---|---|---|
| **Third parties** | | | | |
| `gds_latency_ms` | int | 0 | `mock-gds` before responding; additive to the baseline distribution | S1, S4 |
| `gds_latency_mode` | enum `fixed\|jitter\|p99_tail` | `jitter` | How the delay is applied | S1 |
| `gds_error_rate` | float 0–1 | 0 | `mock-gds` → 503 | S1, S4 |
| `gds_provider_down` | string (provider code) | `""` | One provider always times out → partial results | S1 |
| `gds_rate_limit_aggressive` | bool | false | Rate limit drops to 10 req/min | S4 |
| `payment_latency_ms` | int | 0 | `mock-payments` before responding | S2 |
| `payment_error_rate` | float | 0 | `mock-payments` → 500 (`ERROR`, not decline) | S2 |
| `payment_decline_rate` | float | 0.02 | Decline rate (business outcome) | S2 |
| `payment_decline_mix` | enum | `mixed` | Which decline code dominates | S2 |
| `payment_webhook_delay_ms` | int | 2000 | Webhook callback delay | S2 |
| `email_failure_rate` | float | 0 | `mock-email` → 422, generating DLQ traffic | S5 |
| **Database** | | | | |
| `db_n_plus_one` | bool | false | `booking-service` booking-list query loops instead of joining | S3 |
| `db_drop_index` | bool | false | Drops `idx_bookings_user_id_created_at`; reset recreates it | S3 |
| `db_lock_storm` | bool | false | Background task holds a row lock on `inventory_holds`, 5 s at a time | S10 |
| `db_pool_starvation` | bool | false | SQLAlchemy pool → 2 connections | S10 |
| `db_slow_query_ms` | int | 0 | Adds `pg_sleep()` to one reporting query (the one honest use of sleep — it emulates a genuinely expensive analytical query) | — |
| **Cache** | | | | |
| `redis_disabled` | bool | false | All cache reads miss, writes are skipped | S4 |
| `redis_latency_ms` | int | 0 | Delay before every Redis op | S4 |
| `cache_ttl_seconds` | int | 120 | Search-result TTL; set to 1 for near-constant misses | S4 |
| **Queue** | | | | |
| `kafka_consumer_pause` | string (consumer group) | `""` | Pauses that consumer group → real, growing lag | S5 |
| `kafka_slow_consumer_ms` | int | 0 | Per-message processing delay | S5 |
| `kafka_producer_error_rate` | float | 0 | Producer send failures | — |
| `kafka_poison_rate` | float | 0 | Emits malformed messages → DLQ | S5 |
| **Compute** | | | | |
| `pricing_hot_path` | bool | false | Bypasses the fare-rule index (§ 7.1) | S6 |
| `booking_memory_leak` | bool | false | Module-level dict retains itinerary objects, never evicted | S7 |
| `hold_lock_contention` | bool | false | Widens the advisory-lock critical section | S10 |
| `service_error_rate` | map service→float | `{}` | Per-service synthetic 500s | — |
| `service_latency_ms` | map service→int | `{}` | Per-service added latency | — |
| **Frontend** | | | | |
| `frontend_heavy_assets` | bool | false | Serves `lg` images everywhere, disables lazy loading → LCP collapse | S8 |
| `frontend_blocking_js` | bool | false | A synchronous 400 ms main-thread task on results render → INP collapse | S8 |
| `frontend_js_error_rate` | float | 0 | Random client-side exceptions | S8 |
| `frontend_layout_shift` | bool | false | Delayed-insert banner → CLS regression | S8 |
| **LLM** | | | | |
| `llm_latency_ms` | int | 0 | Added time-to-first-token | S9 |
| `llm_degrade_tools` | bool | false | Model returns prose instead of tool calls | S9 |
| `llm_hallucinate` | bool | false | Model invents a plausible-but-wrong PNR and itinerary | S9 |
| `llm_error_rate` | float | 0 | `mock-llm` → 500 | S9 |
| `llm_token_bloat` | bool | false | Verbose responses → visible token/cost spike | S9 |
| **Meta** | | | | |
| `version_override` | string | `""` | Overrides the reported `DD_VERSION` to fake a deploy | S6 |

**Integrity rule:** no flag may produce an incorrect *business* result. A slow payment is still a correct payment; a declined payment is correctly recorded as declined. The only exceptions are `llm_hallucinate` and `llm_degrade_tools`, which exist precisely to demonstrate output-quality monitoring, and which must never touch the booking record.

---

## 12. Logging schema

One JSON schema, all four languages, no exceptions. This is what makes the log-correlation demo work.

```json
{
  "timestamp": "2026-09-29T10:14:22.481Z",
  "status": "info",
  "message": "Booking confirmed",
  "service": "voyager-booking",
  "env": "demo",
  "version": "a3f9c21",
  "logger": { "name": "app.domain.booking", "thread_name": "asyncio-3" },
  "dd": { "trace_id": "…", "span_id": "…" },
  "http": { "method": "POST", "url_details": { "path": "/v1/bookings/…/confirm" },
            "status_code": 200, "request_id": "req_01J8…" },
  "duration": 142000000,
  "usr": { "id": "uuid", "email": "…", "tier": "gold" },
  "booking": { "id": "uuid", "pnr": "K8M2QR", "state": "CONFIRMED",
               "product_type": "flight", "total_cents": 41200 },
  "chaos": { "active_flags": "gds_latency_ms,payment_decline_rate" },
  "error": { "kind": "PaymentDeclinedError", "message": "…", "stack": "…" }
}
```

Rules:
1. `status` uses Datadog's canonical levels: `debug`, `info`, `warn`, `error`, `critical`.
2. `message` is a **constant string** per log site. All variability goes into structured fields. `logger.info("Booking confirmed", booking_id=x)`, never `logger.info(f"Booking {x} confirmed")` — interpolated messages destroy log aggregation and Error Tracking grouping.
3. `dd.trace_id` and `dd.span_id` come from tracer log injection. Verify in each language rather than assuming.
4. `duration` is nanoseconds, on request-completion logs only.
5. Never log card numbers, CVCs, passwords, tokens, or full passport numbers. Log `card_last4` and `card_brand` only.
6. Request logs are emitted once per request, at completion, by middleware — not scattered through handlers.
7. Every service logs a structured startup line with its resolved config (secrets redacted). During a demo this is the fastest way to prove which version is running.

### 12.1 Pipeline configuration (committed as code)

Status remapper (`status`), service remapper (`service`), trace-ID remapper (`dd.trace_id`), message remapper (`message`), user attribute remapper (`usr.id`, `usr.email`), and a duration remapper. Facets on `booking.state`, `booking.product_type`, `usr.tier`, `error.kind`, `chaos.active_flags`, `http.status_code`.

---

## 13. Error model

### 13.1 Typed hierarchy

Mirror this in all three backend languages. Stable, low-cardinality type names are what make Error Tracking group correctly.

```
VoyagerError (base)
├── ValidationError                    400
│   ├── InvalidSearchCriteriaError
│   └── InvalidPassengerDataError
├── AuthenticationError                401
├── AuthorizationError                 403
├── NotFoundError                      404
│   ├── BookingNotFoundError
│   └── SearchResultExpiredError       410
├── ConflictError                      409
│   ├── InvalidBookingTransitionError
│   └── DuplicateIdempotencyKeyError
├── BusinessRuleError                  422
│   ├── InventoryUnavailableError
│   ├── HoldExpiredError
│   ├── PaymentDeclinedError
│   └── PriceChangedError
├── RateLimitError                     429
└── DependencyError                    502 / 503 / 504
    ├── GdsUnavailableError
    ├── GdsTimeoutError
    ├── PaymentProviderError
    ├── DatabaseError
    ├── CacheError
    └── LlmProviderError
```

### 13.2 HTTP error envelope

```json
{
  "error": {
    "type": "PaymentDeclinedError",
    "code": "payment_declined",
    "message": "Your card was declined. Please try another payment method.",
    "details": { "declineCode": "insufficient_funds" },
    "requestId": "req_01J8…",
    "traceId": "5678901234567890"
  }
}
```

`message` is user-safe and human-readable. Internal detail goes in the span and the log, never in the response. `traceId` **is** returned — it's what lets you read an ID off a demo screen and paste it into Datadog.

### 13.3 Span error rules

- Set `span.error = 1` only for genuine errors. A business decline is **not** a span error — it's a tagged outcome (`payment.decline_code`). Marking declines as errors inflates your error rate and makes the SLO demo meaningless.
- `error.type` = the class name. `error.message` = the constant message. `error.stack` = the stack trace.
- `DependencyError` subclasses are set on the client span *and* the server span, so both sides of the hop show the failure.

---

## 14. Custom metrics (DogStatsD)

All metrics prefixed `voyager.`. Global tags come from `DD_TAGS` + `DD_SERVICE` + `DD_ENV` + `DD_VERSION`.

| Metric | Type | Tags | Emitted by |
|---|---|---|---|
| `voyager.search.requests` | count | `product`, `origin`, `destination`, `cabin`, `cache_hit` | `search-service` |
| `voyager.search.results_count` | distribution | `product`, `cache_hit` | `search-service` |
| `voyager.search.provider_latency` | distribution | `provider` | `search-service` |
| `voyager.search.provider_errors` | count | `provider`, `error_kind` | `search-service` |
| `voyager.search.partial_results` | count | `providers_responded` | `search-service` |
| `voyager.pricing.rules_evaluated` | distribution | `hot_path` | `pricing-service` |
| `voyager.booking.created` | count | `product`, `tier` | `booking-service` |
| `voyager.booking.confirmed` | count | `product`, `tier`, `currency` | `booking-service` |
| `voyager.booking.failed` | count | `product`, `failure_reason` | `booking-service` |
| `voyager.booking.revenue_cents` | distribution | `product`, `currency`, `tier` | `booking-service` |
| `voyager.booking.time_to_confirm_ms` | distribution | `product` | `booking-service` |
| `voyager.hold.created` | count | `resource_type` | `booking-service` |
| `voyager.hold.expired` | count | `resource_type` | `booking-service` |
| `voyager.hold.lock_wait_ms` | distribution | `resource_type` | `booking-service` |
| `voyager.payment.authorized` | count | `provider`, `card_brand` | `payment-service` |
| `voyager.payment.declined` | count | `provider`, `decline_code` | `payment-service` |
| `voyager.payment.errors` | count | `provider`, `error_kind` | `payment-service` |
| `voyager.payment.idempotency_replays` | count | `endpoint` | `payment-service` |
| `voyager.payment.provider_latency_ms` | distribution | `provider`, `operation` | `payment-service` |
| `voyager.loyalty.points_accrued` | count | `tier`, `product` | `loyalty-service` |
| `voyager.loyalty.tier_upgrades` | count | `from_tier`, `to_tier` | `loyalty-service` |
| `voyager.notifications.sent` | count | `template` | `notification-worker` |
| `voyager.notifications.dlq` | count | `template`, `failure_reason` | `notification-worker` |
| `voyager.notifications.lag_seconds` | gauge | `consumer_group` | `notification-worker` |
| `voyager.support.conversations` | count | `intent` | `ai-support-service` |
| `voyager.support.tool_calls` | count | `tool`, `outcome` | `ai-support-service` |
| `voyager.support.tokens` | distribution | `direction`, `model` | `ai-support-service` |
| `voyager.support.escalations` | count | `intent` | `ai-support-service` |
| `voyager.cart.abandoned` | count | `step`, `product` | `api-gateway` |
| `voyager.chaos.flags_active` | gauge | — | `api-gateway` |

**Cardinality discipline:** never tag with a booking ID, user ID, PNR, trace ID, or raw price. `origin` and `destination` are acceptable (~500 values each) but must not be combined into a single `route` tag — that's 250,000 combinations. Put high-cardinality identifiers on spans and in logs, where they belong.

---

## 15. Validation and business rules

Enforce server-side; mirror in the UI for usability but never trust the client.

**Search**
- Depart date ≥ today, ≤ today + 360 days. (The seeder generates 365 days of schedules — see `01-PRD.md § 9` — so the whole window returns results.)
- Return date > depart date, ≤ depart + 90 days.
- Passengers: 1–9 total; infants ≤ adults; children 2–11; infants < 2.
- Origin ≠ destination.
- Hotel stay: 1–30 nights, check-in ≥ today.

**Booking**
- Passenger count must match the search.
- Each passenger needs first name, last name, DOB, nationality.
- DOB must be consistent with the declared passenger type at the travel date.
- Seat selection only for `economy_plus` and above, or as a paid ancillary.
- Hold TTL 15 minutes, non-extendable.
- Total must equal the sum of `booking_items` — assert it, and return a `500` with a distinct error type if it doesn't. A silent money bug is worse than a loud one.

**Payment**
- Amount must equal `bookings.total_cents`.
- Idempotency key required; reuse with a *different* request body → `409 DuplicateIdempotencyKeyError`.
- Authorization only permitted from `HELD` or `FAILED`.
- Refunds capped at the captured amount.

**Cancellation**
- Only from `CONFIRMED`.
- Refund amount computed from the fare's cancellation policy (`pricing-service`).
- Non-refundable fares → `CANCELLED` with a zero refund, not an error.

---

## 16. Health and readiness

Uniform across every service:

```http
GET /health   → 200 {"status":"ok","service":"voyager-booking","version":"a3f9c21"}
              # Liveness. Checks nothing external. Never fails while the process is up.
              # Excluded from trace sampling.

GET /ready    → 200 {"status":"ready","checks":{"postgres":"ok","redis":"ok","kafka":"ok"}}
              → 503 {"status":"not_ready","checks":{"postgres":"error: …", …}}
              # Readiness. Checks dependencies with a 2s timeout each.
```

Compose healthchecks use `/health`. The gateway's `/admin/status` aggregates every service's `/ready`. Keeping these distinct matters: a `/health` that checks the database makes every service restart when Postgres blips, which is exactly the kind of cascade you don't want mid-demo.
