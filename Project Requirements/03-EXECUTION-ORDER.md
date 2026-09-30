# 03 — Execution Order

**This is the build plan. Cursor: work through it in order, top to bottom. Do not skip ahead.**

Each phase has **inputs** (what must already exist), **deliverables** (what you build), and **exit criteria** (how we know the phase is done). Do not start phase N+1 until every exit criterion of phase N passes. Commit at the end of every phase with the message format `phase(N): <short summary>`.

**Estimated total: 14 phases (0 through 13).** Phases 0–7 produce a working app with **no Datadog code at all**. Phases 8–12 layer observability on. Phase 13 deploys. This order is deliberate — instrumenting a broken app wastes time, and a working app makes every instrumentation step immediately verifiable.

---

## Phase 0 — Repository scaffold

**Inputs:** the six markdown docs.

**Deliverables**
1. Directory tree exactly as `02-TECH-STACK.md § 10`. Create empty dirs with `.gitkeep`.
2. `.gitignore` covering `node_modules`, `dist`, `.env`, `__pycache__`, `*.pyc`, `.venv`, `venv`, Go build output, `playwright-report`, `.DS_Store`.
3. `.env.example` — every variable from `02-TECH-STACK.md § 7.1`, with safe placeholder values and a one-line comment each.
4. `Makefile` with all targets from `02-TECH-STACK.md § 11`. Targets not yet implementable should `@echo "not yet implemented (phase N)"` — this keeps the interface stable from day one.
5. Root `README.md` — copy the provided one in.
6. `docker-compose.yml` with **only** `postgres`, `redis`, `kafka` and the `voyager` network + named volumes.
7. `infra/postgres/postgresql.conf`, `infra/postgres/init/01-schema-owner.sql`, `infra/redis/redis.conf`.
8. Editor config: `.editorconfig`, `.nvmrc` (20.17), `.tool-versions` or equivalent.

**Exit criteria**
- `make up` starts Postgres, Redis, Kafka; all three report healthy.
- `psql` connects; `redis-cli PING` returns `PONG`; `kafka-topics --list` succeeds.
- `git status` is clean apart from the intended files.

---

## Phase 1 — Data model, migrations, and seed data

**Inputs:** Phase 0. Data model spec from `05-FUNCTIONALITY.md § 3`.

**Deliverables**
1. `services/booking-service/alembic/` — Alembic is the single owner of schema migrations for the whole database. No other service runs DDL.
2. Full schema per `05-FUNCTIONALITY.md § 3` — all 21 tables: `users`, `airports`, `cities`, `airlines`, `flights`, `fare_classes`, `fare_rules`, `hotels`, `room_types`, `rate_plans`, `bookings`, `booking_items`, `passengers`, `inventory_holds`, `payments`, `payment_events`, `loyalty_accounts`, `loyalty_transactions`, `support_conversations`, `support_messages`, `idempotency_records`.
3. All indexes from `05-FUNCTIONALITY.md § 3.3`, **including** `idx_bookings_user_id_created_at` — this is the index chaos scenario S3 drops.
4. `tools/seeder/` — Python job that generates the volumes in `01-PRD.md § 9`, deterministically from `SEED_RANDOM_SEED`. Uses `COPY FROM STDIN` for the large tables. Idempotent: truncate-then-load, guarded by a confirmation flag.
5. `make seed` and `make migrate` wired up.

**Exit criteria**
- `make migrate && make seed` completes in under 5 minutes.
- `SELECT count(*) FROM bookings` ≥ 400,000; `flights` ≥ 150,000 covering 365 days forward; `fare_rules` ≥ 2,000.
- The 20 power users (`power1@voyager.demo` … `power20@voyager.demo`, per `01-PRD.md § 9`) each have 300–800 bookings. **Verify this explicitly** — scenario S3 has no demo subject without it.
- Running `make seed` twice produces byte-identical row counts and identical checksums on a sample query.
- `EXPLAIN` on the `GET /bookings/mine` query (the `/account` page query, filtering by `user_id` and ordering by `created_at DESC`) shows an **Index Scan** using `idx_bookings_user_id_created_at`. Save this plan output — Phase 10 compares against it.

---

## Phase 2 — Mock third parties

Built early and deliberately, because every real service depends on them. Doing this first means no service is ever blocked on a stub.

**Inputs:** Phase 0.

**Deliverables**
1. `mocks/mock-gds` — flight and hotel inventory search. Reads from Postgres (read-only role) so results are consistent with seeded data, but *behaves* like a remote API: configurable base latency, log-normal jitter, a p99 tail, a rate limit returning `429`, and random `503`s. Endpoints per `05-FUNCTIONALITY.md § 5`.
2. `mocks/mock-payments` — authorize / capture / refund with idempotency keys, the full test-card table and the five decline codes from `05-FUNCTIONALITY.md § 5.2` (`card_declined`, `insufficient_funds`, `expired_card`, `do_not_honor`, `fraud_suspected`), a 3DS step-up path, and a webhook callback to `payment-service`.
3. `mocks/mock-email` — accepts send requests, stores the last 200 in memory, exposes `GET /outbox` so demos can show the confirmation email actually arrived.
4. `mocks/mock-llm` — OpenAI-compatible `/v1/chat/completions`, streaming and non-streaming, with tool-calling support, realistic token counts, and realistic time-to-first-token. Canned-but-varied responses for the support-chat intents.
5. All four read their behavior knobs from the Redis chaos hash `voyager:chaos` (see Phase 6 and `05-FUNCTIONALITY.md § 10.1`) with a 2-second local cache, so they respond to toggles without restart.
6. `docker-compose.yml` extended with all four.

**Exit criteria**
- Each mock responds correctly to its documented endpoints, verified by a committed `curl` script or REST collection.
- `redis-cli HSET voyager:chaos gds_latency_ms 2000` makes `mock-gds` slow within 3 seconds, with no restart.
- `mock-llm` streams a tool call that `ai-support-service` will later be able to parse.
- Latency distribution check: 1,000 requests to `mock-gds` at default settings yield p50 ≈ 180 ms, p95 ≈ 600 ms, p99 ≈ 1800 ms.

---

## Phase 3 — Go services: search and pricing

Go first among the real services, because search is the shallowest dependency chain and the easiest to verify by hand.

**Inputs:** Phases 1, 2.

**Deliverables**
1. `services/pricing-service` — fare computation. `POST /v1/price/flight`, `POST /v1/price/hotel`, `POST /v1/price/batch`. Loads fare rules from Postgres into memory at boot, refreshed every 60 s. Contains the fare-rule evaluation loop that Phase 10 will make the profiler's target — **write it as a clean nested loop now**, not as artificially slow code.
2. `services/search-service` — `POST /v1/search/flights`, `POST /v1/search/hotels`, `GET /v1/search/{id}/results` (paginated) and `GET /v1/search/{id}/results/{resultId}` (full detail). Fans out to `mock-gds`, calls `pricing-service` for batch pricing, caches results in Redis keyed by a normalized search hash with a 120 s TTL. Expired result sets return `410 Gone`.
3. Structured JSON logging with `zerolog` in both, using the shared log schema (`05-FUNCTIONALITY.md § 12`).
4. Typed error hierarchy per `05-FUNCTIONALITY.md § 13`.
5. `go test` unit tests: search-hash normalization, cache key generation, fare-rule evaluation correctness, GDS response mapping.
6. Both added to Compose with healthchecks and memory limits.

**Exit criteria**
- `POST /v1/search/flights` with `{"origin":"LHR","destination":"JFK","departDate":"<+14d>","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}` returns ≥ 10 priced results in under 2 s cold, under 100 ms warm. Repeat with `<+300d>` to confirm the seed covers the full search window.
- Second identical request is served from Redis — verify with `redis-cli MONITOR` or a `cache_hit` field in the response.
- `go test ./...` passes in both services.
- Both containers report healthy and stay under their memory limits under 10 concurrent requests.

---

## Phase 4 — Python services: booking and payment

The heart of the app, and the source of the deepest traces.

**Inputs:** Phases 1, 2, 3.

**Deliverables**
1. `services/booking-service`
   - Booking state machine exactly as `05-FUNCTIONALITY.md § 4.1`: `DRAFT → HELD → PENDING_PAYMENT → CONFIRMED`, plus `FAILED`, `EXPIRED`, `CANCELLED`, `REFUNDED`. **Only `EXPIRED` and `REFUNDED` are terminal** — `FAILED` can return to `PENDING_PAYMENT` on retry, and `CANCELLED` can advance to `REFUNDED`. Illegal transitions raise `InvalidBookingTransitionError`.
   - `POST /v1/bookings` (create draft from a search result), `POST /v1/bookings/{id}/hold` (reserve inventory, 15-min TTL, Postgres advisory lock), **`PUT`** `/v1/bookings/{id}/passengers`, **`PUT` `/v1/bookings/{id}/ancillaries`** (seats / baggage / upgrades, re-prices via `pricing-service`), `POST /v1/bookings/{id}/confirm`, `GET /v1/bookings/{id}`, `GET /v1/bookings?user_id=`, **`GET /v1/bookings?pnr=&lastName=`** (guest lookup, also used by the AI support `lookup_booking` tool), `POST /v1/bookings/{id}/cancel`.
   - Background hold-expiry sweeper, every 30 s.
   - Kafka producer to `voyager.bookings.events` **and `voyager.notifications.outbound`**.
   - Consumer of `voyager.payments.events` on consumer group **`voyager-booking-payments-v1`**, driving `PENDING_PAYMENT → CONFIRMED | FAILED`.
2. `services/payment-service`
   - `POST /v1/payments/authorize`, `POST /v1/payments/{id}/capture`, `POST /v1/payments/{id}/refund`, **`POST /v1/payments/{id}/3ds/complete`**, `GET /v1/payments/{id}`, `POST /v1/webhooks/provider`.
   - Idempotency keys stored in Postgres (`idempotency_records` + the unique constraint on `payments.idempotency_key`); replays return the original response and increment `voyager.payment.idempotency_replays`.
   - Append-only `payment_events` ledger.
   - Kafka producer to `voyager.payments.events` **and `voyager.notifications.outbound`**.
3. Kafka topic creation as an init job: all topics from `05-FUNCTIONALITY.md § 6`, 3 partitions each, replication factor 1.
4. `structlog` JSON logging, shared schema.
5. `pytest` suites: state machine transitions (including every illegal transition), hold expiry, idempotency replay, decline handling.

**Exit criteria**
- Full happy path completes via `curl`: search → create → hold → passengers → authorize → confirm, ending in a `CONFIRMED` booking with a PNR.
- A hold left unpaid transitions to `EXPIRED` within 16 minutes and releases its inventory (test with a shortened TTL override).
- Replaying an authorize call with the same idempotency key returns the identical payment ID and does not create a second row.
- Every illegal state transition raises `InvalidBookingTransitionError` and returns HTTP 409.
- `pytest` passes in both services.

---

## Phase 5 — Event consumers: loyalty, notifications, AI support

**Inputs:** Phase 4.

**Deliverables**
1. `services/loyalty-service` (Node) — consumes `voyager.bookings.events`, accrues points by fare class and user tier, writes `loyalty_transactions`, recomputes tier, **produces to `voyager.loyalty.accruals`** (`points.accrued`, `tier.upgraded`), exposes `GET /v1/loyalty/{userId}`. Independent consumer group so it can be degraded separately.
2. `services/notification-worker` (Python) — consumes `voyager.bookings.events`, `voyager.payments.events`, **`voyager.notifications.outbound`**, and `voyager.loyalty.accruals`; renders the itinerary and calls `mock-email`. Retries with backoff; poison messages go to `voyager.notifications.dlq` after 3 attempts. Exposes `GET /health` **and `GET /ready`** (no business API) — `/ready` is required because `/admin/status` aggregates it.
3. `services/ai-support-service` (Python) — support chat. `POST /v1/support/conversations`, `POST /v1/support/conversations/{id}/messages` (SSE streaming). All five tools from `05-FUNCTIONALITY.md § 9`: `lookup_booking`, `get_cancellation_policy`, `initiate_cancellation`, **`get_loyalty_balance`**, `escalate_to_human`. Tools call `booking-service` and `loyalty-service` over HTTP. `initiate_cancellation` is gated in the tool handler on explicit in-conversation user confirmation — **not** in the prompt. Conversation history persisted to `support_conversations` / `support_messages`.
4. Consumer groups named explicitly: `voyager-loyalty-v1`, `voyager-notifications-v1`, `voyager-booking-payments-v1`.

**Exit criteria**
- Confirming a booking results, within 5 seconds, in: a loyalty transaction row, a tier recomputation, and an email visible in `mock-email`'s `GET /outbox`.
- A deliberately malformed message lands in the DLQ after exactly 3 attempts and does not block the partition.
- Support chat answers "where is my booking PNR K8M2QR?" by actually invoking `lookup_booking` and quoting real data from the database. (Use a PNR from a booking you just created — the alphabet excludes `0`, `1`, `I`, and `O`.)
- Killing `notification-worker` for 2 minutes and restarting it results in it catching up with zero message loss.

---

## Phase 6 — Chaos framework and API gateway

The gateway comes late on purpose: every downstream contract is now settled, so the gateway is assembly rather than guesswork.

**Inputs:** Phases 2–5.

**Deliverables**
1. **Chaos framework** — a tiny library implemented once per language (`chaos.ts`, `chaos.go`, `chaos.py`), each ~100 lines, with an identical interface:
   - `isEnabled(flag) -> bool`
   - `getValue(flag, default) -> number | string`
   - `maybeDelay(flag)` — applies latency, supporting `fixed`, `jitter`, and `p99_tail` modes
   - `maybeFail(flag, errorFactory)` — probabilistic failure
   - `activeFlags() -> string[]` — for the `chaos.active_flags` span tag added in Phase 8
   - Reads from Redis hash `voyager:chaos`, local cache TTL 2 s, fails open (chaos off) if Redis is unreachable.
2. All 38 flags from `05-FUNCTIONALITY.md § 11` implemented at their correct injection points.
3. `services/api-gateway` (Node/Fastify)
   - Auth: `POST /api/v1/auth/signup`, `/login`, `/refresh`, `/logout`, `GET /api/v1/auth/me`. JWT, bcrypt cost 12.
   - BFF endpoints per `05-FUNCTIONALITY.md § 2` — these aggregate multiple downstream calls so a single frontend request produces a genuinely wide trace.
   - Admin API exactly as `05-FUNCTIONALITY.md § 2.8`: `GET`/`PUT /admin/chaos`, `POST /admin/chaos/reset`, `GET /admin/scenarios`, `POST /admin/scenarios/{id}/apply`, `POST /admin/scenarios/{id}/revert`, `GET /admin/status`, `POST /admin/loadgen`, `POST /admin/seed/reset`, **`POST /admin/version`** (runtime `DD_VERSION` override — required by scenario S6). Gated by the `X-Voyager-Admin` header matching `ADMIN_SECRET`.
   - Rate limiting, CORS, helmet, request-ID propagation.
   - A traced HTTP client wrapper used for **all** downstream calls — one file, so the propagation story is one file.
4. `tools/scenarios/` — the 10 composite scenarios from `01-PRD.md § 8` as JSON, applied by the admin API.
5. `make chaos-reset` and `make scenario s=<ID>` wired up.

**Exit criteria**
- `PUT /api/v1/admin/chaos` with `{"gds_latency_ms": 3000}` slows search within 3 seconds, no restart, in all languages.
- `POST /api/v1/admin/chaos/reset` returns the system to healthy within 60 seconds.
- Each of the 10 scenarios applies its documented flag set and is visible in `GET /api/v1/admin/chaos`.
- Admin endpoints return 401 without the header.
- One gateway BFF call to the checkout-init endpoint results in ≥ 5 downstream service calls.

---

## Phase 7 — Frontend application

**Inputs:** Phase 6. Design system from `04-STYLING.md`. Flows from `06-USER-FLOWS.md`.

**Deliverables**
1. Vite + React + TS + Tailwind project, with the full token set from `04-STYLING.md § 2` in `tailwind.config.ts`.
2. **All** UI primitives from `04-STYLING.md § 6` — that table is the authoritative list: `Button`, `IconButton`, `Input`, `Select`, `Combobox`, `DateRangePicker`, `QuantityStepper`, `CheckoutStepper`, `Card`, `Badge`, `Tabs`, `Modal`, `Drawer`, `Toast`, `Skeleton`, `EmptyState`, `Alert`, `Tooltip`, `Toggle`, `Slider`, `Table`, `PriceTag`, `CountdownTimer`, `CopyChip`, `StatusDot`.
3. Routes and screens exactly as `06-USER-FLOWS.md § 2`.
4. `@tanstack/react-query` for all server state, with the retry and stale-time policy in `05-FUNCTIONALITY.md § 2.4`.
5. Auth context, token refresh, protected routes.
6. Admin chaos panel at `/admin` — grouped toggles, sliders for numeric flags, the 10 scenario buttons, a live status grid, loadgen controls, and a prominent **Reset all chaos** button.
7. `data-testid` on every interactive element and `data-dd-action-name` on every element that matters to RUM, using the exact Title-Case names from `06-USER-FLOWS.md § 7` — added now, not retrofitted in Phase 9.
8. Vitest component tests + a Playwright happy-path e2e test.

**Exit criteria**
- A human can complete flight search → checkout → confirmation entirely in the browser, and the booking appears in Postgres.
- Hotel search → checkout → confirmation likewise.
- Manage-booking lookup, cancellation, and support chat all work in the browser.
- The admin panel toggles chaos and the effect is observable in the UI (slower search, failed payments).
- Responsive at 375 px, 768 px, and 1440 px. No horizontal scroll on the body at any width.
- Lighthouse performance ≥ 85 with chaos off.

---

> ## Checkpoint
> **You now have a complete, working, production-shaped travel booking application with zero Datadog code in it.** Verify the entire app works end-to-end before proceeding. Everything from here on is observability — and every step of it is independently verifiable, which is only true because the app already works.

---

## Phase 8 — Datadog Agent + core APM tracing

**Inputs:** Phase 7. A valid `DD_API_KEY`.

**Deliverables**
1. `datadog-agent` container in Compose with the full configuration from `02-TECH-STACK.md § 6`, including all volume mounts.
2. The `x-datadog-env` Compose anchor, merged into every first-party service.
3. Tracer initialization, one dedicated file per service:
   - Node: `src/tracer.ts`, loaded via `node --require ./dist/tracer.js`. Verify it loads before `fastify` and `pg`.
   - Go: `tracer.Start()` / `defer tracer.Stop()` in `main()`, plus `chitrace`, `pgxtrace`, and `redistrace` contrib wiring.
   - Python: `ddtrace-run uvicorn` in the Dockerfile CMD.
4. `DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext` everywhere. Verify, don't assume.
5. Traced HTTP clients in all services so context crosses every hop.
6. **Custom spans** — the ones that make the demo worth watching:
   - `search.fanout`, `search.cache_lookup`, `search.normalize_results`
   - `pricing.load_rules`, `pricing.evaluate_fare_rules`, `pricing.apply_taxes`
   - `booking.validate_availability`, `booking.acquire_hold_lock`, `booking.hold_inventory`, `booking.state_transition`
   - `payment.build_request`, `payment.authorize`, `payment.idempotency_check`, `payment.persist_ledger`
   - `loyalty.compute_points`, `notification.render_itinerary`
7. **Span tags**, applied consistently: `booking.id`, `booking.pnr`, `booking.state`, `usr.id`, `usr.tier`, `search.route`, `search.cabin`, `search.cache_hit`, `payment.provider`, `payment.decline_code`, `product.type`, `chaos.active_flags`.
8. Error Tracking: set span errors from the typed exception hierarchy, with stable `error.type` values.
9. Source Code Integration: `DD_GIT_REPOSITORY_URL` and `DD_GIT_COMMIT_SHA` baked in at build time.

**Exit criteria**
- The Service Map shows all 13 instrumented services (9 first-party + 4 mocks) plus Postgres, Redis, and Kafka, with correct edges and no unexpected `unnamed-service` nodes.
- **The critical test:** one browser checkout produces **one** trace with ≥ 40 spans spanning `voyager-web` → `voyager-api-gateway` → `voyager-search` → `voyager-pricing` → `mock-gds` → `voyager-booking` → `voyager-payment` → `mock-payments`, with no broken or orphaned context.
- Kafka-triggered work (`voyager-loyalty`, `voyager-notifications`) appears as linked spans with Data Streams context.
- Every custom span from item 6 is present and correctly nested.
- Error Tracking shows exactly the expected issue groups — no string-interpolated messages creating one issue per request.
- Clicking a stack frame in an error opens the correct file and line in GitHub.

---

## Phase 9 — RUM, logs, and correlation

**Inputs:** Phase 8. A RUM application created in Datadog (application ID + client token).

**Deliverables**
1. `apps/web-ui/src/datadog/rum.ts` — all RUM configuration in one file:
   - `datadogRum.init()` with `service: 'voyager-web'`, `env`, `version`, `sessionSampleRate`, `sessionReplaySampleRate`, `trackUserInteractions: true`, `trackResources: true`, `trackLongTasks: true`, `defaultPrivacyLevel: 'mask-user-input'`.
   - `allowedTracingUrls` pointing at the gateway origin, with `propagatorTypes: ['datadog', 'tracecontext']`.
   - React Router integration for SPA view names — the **exact** set from `06-USER-FLOWS.md § 2`: `/home`, `/search/flights`, `/search/hotels`, `/results/flights`, `/results/hotels`, `/detail`, `/checkout/review`, `/checkout/passengers`, `/checkout/payment`, `/confirmation`, `/manage`, `/manage/detail`, `/account`, `/login`, `/signup`, `/admin`. Use route *patterns*, never instantiated paths.
2. `datadogLogs.init()` with the same service/env/version, forwarding errors and console output.
3. `setUser()` on login with `id`, `email`, `name`, `tier`, `signup_cohort`; `clearUser()` on logout.
4. Custom RUM actions from `06-USER-FLOWS.md § 7` (Title Case, under ~40 distinct names), with `data-dd-action-name` on the corresponding elements and all variable detail in action *attributes*.
5. All five custom timings from `06-USER-FLOWS.md § 7.1`: `time_to_first_result`, `time_to_interactive_results`, `checkout_step_duration`, `time_to_confirmation`, `support_first_token`.
6. Structured JSON logging finalized in all services against the shared schema (`05-FUNCTIONALITY.md § 12`), with `dd.trace_id` / `dd.span_id` injection verified in all four languages.
7. Log pipeline configuration committed as code: status remapper, service remapper, trace-ID remapper, `usr.id` remapper, and a message remapper.
8. One log-based metric: `voyager.logs.payment_declines`.
9. `make dd-sourcemaps` uploading Vite sourcemaps via `datadog-ci`, wired into `make deploy`.
10. Frontend chaos toggles: `frontend_heavy_assets`, `frontend_blocking_js`, `frontend_js_error_rate`.

**Exit criteria**
- RUM sessions appear with correct view names for every funnel step.
- Session Replay records and plays back a full checkout, with the card number field masked.
- **The correlation test:** from a RUM session, click into the APM trace, then into the logs for that trace, then into the Postgres query. All four views agree on the same request.
- Core Web Vitals are reported per view; `frontend_heavy_assets=true` visibly degrades LCP within one session.
- A deliberate JS error appears in RUM Error Tracking with an un-minified stack trace resolved via sourcemaps.
- Logs are searchable by `@usr.id`, `@booking.id`, and `service`, and every log line in a request carries the same `dd.trace_id`.

---

## Phase 10 — Profiling, DBM, and Data Streams

**Inputs:** Phases 8, 9.

**Deliverables**
1. **Continuous Profiler** enabled in all Go, Python, and Node services. For Go, confirm the build keeps symbols.
2. `pricing-service`: the `evaluateFareRules` path made genuinely expensive when `pricing_hot_path=true` — it evaluates the full rule set against every fare combination instead of using the pre-built index. Real work, real CPU, real flame graph. **No `sleep`, no busy-wait.**
3. `booking-service`: `booking_memory_leak=true` retains rendered itinerary objects in a module-level dict keyed by booking ID, never evicted. Observable as RSS growth and allocation-profile change over ~20 minutes.
4. `booking-service`: `hold_lock_contention=true` widens the advisory-lock critical section around `booking.hold_inventory`, producing real lock waits under load.
5. **DBM** enabled: `pg_stat_statements`, the `datadog` role, the explain function, and the Agent's Postgres check with `dbm: true`.
6. DBM chaos paths, all producing *real* database pathology:
   - `db_n_plus_one=true` — the `GET /bookings/mine` query loops per-booking to fetch items instead of joining.
   - `db_drop_index=true` — drops `idx_bookings_user_id_created_at` (and recreates it on reset). Verify the plan flips to Seq Scan.
   - `db_lock_storm=true` — a background task holds a row lock on `inventory_holds` for 5 s at a time.
   - `db_pool_starvation=true` — shrinks the SQLAlchemy pool to 2 connections.
7. **Data Streams Monitoring** — `DD_DATA_STREAMS_ENABLED=true` on all producers and consumers; verify Kafka headers carry the context.
8. Data Streams chaos: `kafka_consumer_pause=<consumer group name>` pauses that group to build lag; `kafka_slow_consumer_ms` adds per-message processing delay; `kafka_poison_rate` generates DLQ traffic.
9. **LLM Observability** in `ai-support-service`: `LLMObs.enable()`, decorated `workflow` / `llm` / `tool` / `retrieval` spans, token and cost annotation, and `llm_degrade_tools` / `llm_latency_ms` / `llm_hallucinate` chaos flags.
10. DogStatsD business metrics from `05-FUNCTIONALITY.md § 14`, emitted from all relevant services.

**Exit criteria**
- Profiler shows flame graphs for every Go/Python/Node service, with real function names.
- With `pricing_hot_path=true`, `evaluateFareRules` is unambiguously the top CPU consumer, and Code Hotspots links the trace to the line.
- With `booking_memory_leak=true`, RSS grows monotonically and the allocation profile identifies the retaining structure.
- DBM lists top queries with normalized text, execution counts, and explain plans.
- `db_drop_index=true` flips the `GET /bookings/mine` plan from Index Scan to Seq Scan, visible in DBM, with p95 on that endpoint rising by ≥ 10× when loaded as one of the seeded power users.
- DBM shows blocking sessions during `db_lock_storm`.
- Data Streams Monitoring renders the full pipeline topology with end-to-end latency.
- `kafka_consumer_pause=voyager-notifications-v1` produces visible, growing consumer lag, and clearing it drains the backlog.
- LLM Observability shows traced chains with tool calls, token counts, and cost; `llm_degrade_tools=true` shows tool-call failures.
- All business metrics from § 14 are queryable in the metrics explorer.

---

## Phase 11 — Load generation

**Inputs:** Phase 9 (RUM must exist for browser load to be useful).

**Deliverables**
1. `tools/loadgen-api` — k6, with weighted scenarios that mirror real OTA traffic:
   - 52% browse: search only, never converts
   - 20% deep browse: search → view detail → abandon
   - 17% checkout: full conversion — **must match the 17% bottom-of-funnel rate in `06-USER-FLOWS.md § 8`**
   - 5% manage: look up an existing booking
   - 3% cancel: look up → cancel
   - 3% support: open a support chat
   Plus a realistic diurnal pattern (a sine-shaped VU curve over 24 h) so dashboards have shape, not a flat line.
2. `tools/loadgen-browser` — Playwright/Chromium, 2 concurrent headless sessions running the full funnel with real RUM SDK execution, randomized think time, and a deliberate abandonment rate so the RUM funnel shows realistic drop-off.
3. `docker-compose.loadgen.yml` overlay; `make up-full`.
4. Runtime control via the admin API: start, stop, and set intensity (`1x` / `2x` / `5x`).
5. Loadgen containers excluded from log collection, and health-check requests excluded from trace sampling.

**Exit criteria**
- With `make up-full`, all dashboards populate continuously with no human interaction.
- RUM sessions arrive continuously from `loadgen-browser`, and the funnel shows realistic step-by-step drop-off.
- Traffic shows a visible diurnal pattern over 24 hours.
- Host CPU stays below 60% at `1x` intensity, leaving headroom for chaos demos.
- Admin intensity controls take effect within 30 seconds.

---

## Phase 12 — Observability as code: dashboards, monitors, SLOs, synthetics

**Inputs:** Phases 8–11. At least 24 hours of accumulated data, so baselines and anomaly monitors are meaningful.

**Deliverables**
1. All 6 dashboards from `01-PRD.md § 7` as JSON in `datadog/dashboards/`, with `env` / `service` / `route` / `user.tier` template variables.
2. All monitors from `01-PRD.md § 6.2` as JSON in `datadog/monitors/`, including the composite "Checkout degraded" monitor.
3. Three SLOs in `datadog/slos/`: booking success rate (metric-based, 99.0% / 30 d), search p95 (monitor-based, 7 d), checkout availability (time-slice, from the browser synthetic). Plus fast-burn and slow-burn error-budget alerts on the booking SLO.
4. Five synthetic tests in `datadog/synthetics/`: health API, search API with latency assertion, multistep booking API, browser checkout funnel, and a manage-booking browser test.
5. The incident postmortem notebook template in `datadog/notebooks/`.
6. `datadog/apply.sh` + `make dd-apply` — idempotent, creates or updates everything from the committed JSON using `DD_API_KEY` + `DD_APP_KEY`.
7. Every monitor message written for a live demo: what broke, the likely cause, which dashboard to open, and which chaos flag reverses it.

**Exit criteria**
- `make dd-apply` on a clean Datadog org recreates all dashboards, monitors, SLOs, and synthetics with no manual steps.
- No dashboard widget shows "no data".
- Running scenario S2 fires the composite checkout monitor within 5 minutes.
- The browser synthetic passes reliably with chaos off, and fails with chaos on.
- SLO error budgets show real, non-zero burn history.

---

## Phase 13 — CI, EC2 deployment, and demo hardening

**Inputs:** Phase 12.

**Deliverables**
1. `.github/workflows/ci.yml`:
   - **Four matrix jobs**, matching the "all four test suites" claim elsewhere: `vitest` (web-ui), `vitest` (Node services), `pytest --ddtrace` (Python services), `gotestsum` (Go services).
   - Test Optimization reporting for all three, plus Pipeline Visibility via `datadog-ci`.
   - One intentionally flaky test, clearly commented as such, so flaky-test detection has something to find.
   - Docker build validation for every service.
   - Sourcemap upload on merges to `main`.
2. `infra/ec2/userdata.sh` — Docker Engine, Compose plugin, `make`, `git`, container log rotation, clone, print next steps.
3. `infra/ec2/deploy.sh` and `make deploy` — pull, set `DD_VERSION` and `DD_GIT_COMMIT_SHA` from the git SHA, build, rolling restart, run migrations, then `make healthcheck`.
4. `infra/edge/Caddyfile` — TLS via Let's Encrypt, reverse proxy to `web-ui` and `/api` to `api-gateway`, security headers, and gzip/brotli.
5. `make healthcheck` — asserts every container healthy, every `/ready` green, chaos flags all clear, seed data present, and Datadog receiving traces. Exits non-zero on any failure. **Run this before every demo.**
6. Demo scripts from `06-USER-FLOWS.md § 9` as committed markdown runbooks.
7. Troubleshooting guide appended to `README.md § 9`.
8. `make demo-mode` / `make idle-mode`.

**Exit criteria**
- A fresh EC2 instance goes from launch to fully-working demo in ≤ 30 minutes following `README.md` alone.
- CI is green; Test Optimization shows results from all four suites; the flaky test is flagged as flaky.
- HTTPS works, with a valid certificate; RUM and Session Replay function over it.
- `make healthcheck` correctly passes on a healthy system and fails on a broken one (verify both).
- Both demo narratives from `06-USER-FLOWS.md § 9` run end-to-end without touching a terminal.
- `make reset` returns the system to clean and healthy in under 5 minutes.

---

## Cross-cutting rules for every phase

1. **Never mock a dependency that already exists.** By the time you need it, it's built — that's the point of this order.
2. **Instrumentation code is isolated.** One tracer file, one logging file, one metrics file, one chaos file per service. A customer should be able to read those four files and understand the whole integration.
3. **Chaos must never alter correctness.** A slow payment is still a correct payment. The only flags allowed to produce wrong output are the explicitly-named LLM quality flags.
4. **Every chaos flag needs a reset path**, verified in the same commit that adds the flag.
5. **Tests run before every phase exit.** No phase is complete with a red suite.
6. **Commit at every phase boundary** as `phase(N): <summary>`, and tag phase 13 as `v1.0.0`.
7. **If a phase's exit criteria can't be met, stop and report** — do not proceed with a partial phase. A broken foundation costs more than a delay.
8. **Do not add Datadog code before phase 8.** The temptation will be strong in phases 3–7. Resist it; verifying instrumentation against a working app is dramatically faster.
