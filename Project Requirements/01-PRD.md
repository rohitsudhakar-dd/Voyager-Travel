# 01 — Project Requirements Document

**Project codename:** Voyager
**Product:** A multi-product online travel agency (OTA) — flight and hotel search, booking, payment, loyalty, and AI support.
**Purpose:** A production-shaped reference application whose primary job is to make every major Datadog product observable, demonstrable, and breakable on demand.

> **Read this first, Cursor.** This document defines *what* and *why*. It does not define *how* — that lives in `02-TECH-STACK.md` and `05-FUNCTIONALITY.md`. Do not begin writing code from this document alone. Follow `03-EXECUTION-ORDER.md`.

---

## 1. Problem statement

Datadog demos usually fail for one of two reasons:

1. **The app is too small.** A two-service to-do app produces a trace with three spans. Nothing interesting appears in the service map, there is no database contention, no queue lag, no cold cache, no tail latency. Customers correctly conclude "that's not my system."
2. **The app is too fragile.** A realistic app that breaks unpredictably during a live demo is worse than no demo.

Voyager solves both. It is deliberately architected like a real OTA — polyglot, event-driven, dependent on slow third parties — and every failure mode is a toggle, not an accident.

---

## 2. Goals

| # | Goal | How we know we hit it |
|---|---|---|
| G1 | Produce distributed traces that cross 4 language runtimes and at least 7 services in a single user action | A checkout trace has ≥ 40 spans spanning JS → Node → Go → Python → Kafka → Python |
| G2 | Every Datadog product in scope has at least one *natural* story, not a contrived one | Section 6 coverage matrix fully populated, each row citing a real code path |
| G3 | Any failure mode can be triggered in under 10 seconds mid-demo, and reverted just as fast | Admin chaos panel with ≤ 2 clicks per scenario, effective within one request |
| G4 | Dashboards are never empty, even if nobody has touched the app in a week | Background load generator produces continuous API + browser traffic |
| G5 | A colleague can stand the whole thing up on a fresh EC2 instance in under 30 minutes | Single `make deploy` path documented in `README.md` |
| G6 | Instrumentation is *visible and explainable* — you can open a file and show a customer the exact lines | Manual tracer setup, explicit custom spans, no auto-magic |

---

## 3. Non-goals

- **Not a real booking system.** No real inventory, no real money, no PCI scope. All third parties are in-repo mocks.
- **Not multi-tenant or horizontally scalable.** Single EC2 instance, single Postgres, single Kafka broker.
- **Not hardened.** The admin chaos panel is protected by a shared secret, not a real auth system. Do not expose this to the public internet without the header gate described in `05-FUNCTIONALITY.md § 2.8`.
- **Not Kubernetes.** Docker Compose on one host. (A k3s variant is a future option, noted in § 11.)
- **Not a security demo — yet.** App & API Protection, Sensitive Data Scanner, and CSM are explicitly out of scope for v1 and tracked as future work in § 11. Do not build them now.

---

## 4. Audiences and what each one needs

The build must serve two demo shapes. Everything in the app should be traceable back to one of them.

### A. SRE / Platform engineer deep dive (30–60 min)
They want to *debug something*. Requirements this imposes:
- Traces must have real depth and realistic span naming, with resource names that are low-cardinality and useful.
- Slow database queries must be real slow queries with real execution plans, not `sleep()`.
- Queue lag must be real consumer lag on a real Kafka consumer group.
- The profiler must have a genuinely hot code path to find — a real O(n²) loop, not a busy-wait.
- Host and container metrics must move when load moves.

### B. Developer / APM-focused walkthrough (20–30 min)
They want to see *code-to-signal*. Requirements this imposes:
- Every custom span, span tag, and metric must live in a small number of clearly named files.
- `git.commit.sha` and `DD_VERSION` must be wired so Deployment Tracking works.
- Error Tracking must group cleanly — exceptions must be typed and consistent, not string-formatted.
- CI Visibility must run the real test suite in GitHub Actions.
- Source Code Integration must link a stack frame back to GitHub.

---

## 5. The application — functional scope

Voyager is an OTA with two bookable products (flights, hotels) and a shared checkout.

### 5.1 Customer-facing capabilities

| ID | Capability | Notes |
|---|---|---|
| C1 | Search flights (origin, destination, dates, pax, cabin) | Fans out to mock GDS providers; Redis-cached |
| C2 | Search hotels (city, dates, guests, rooms) | Same shape, different provider |
| C3 | View fare/rate detail with dynamic pricing | Dedicated pricing service, deliberately CPU-heavy |
| C4 | Ancillaries — seat selection, baggage, room upgrade | Creates additional booking line items |
| C5 | Create a booking with a time-limited inventory hold | 15-minute hold, expires via background sweeper |
| C6 | Passenger / guest details capture | Multi-passenger, validation |
| C7 | Payment authorization + capture | Mock provider, idempotency keys, 3DS-style step-up |
| C8 | Booking confirmation + itinerary | Emitted async via Kafka |
| C9 | Manage booking — look up, view, cancel, refund | Second entry point into the same services |
| C10 | Loyalty points accrual and tier status | Kafka consumer, eventual consistency |
| C11 | AI support chat ("where is my booking?", "can I change my flight?") | LLM-backed, tool-calling against booking service |
| C12 | Sign in / sign up (email + password, JWT) | Deliberately simple; enables RUM user attribution |

### 5.2 Operator-facing capabilities

| ID | Capability | Notes |
|---|---|---|
| O1 | Chaos control panel | All failure toggles, live, Redis-backed |
| O2 | Load generator control | Start/stop/scale API + browser traffic |
| O3 | Scenario runner | One-click composite scenarios (see § 8) |
| O4 | Seed/reset | Re-seed database, clear caches, reset chaos state |

---

## 6. Datadog coverage matrix

This is the contract of the project. Every row must be demonstrably true on the deployed instance.

### 6.1 Core — APM, RUM, Logs, Infrastructure, Dashboards

| Product | Feature | Where it comes from in Voyager |
|---|---|---|
| APM | Distributed tracing across runtimes | Browser → `api-gateway` (Node) → `search-service` (Go) → `pricing-service` (Go) → `mock-gds` (Node); checkout adds `booking-service` and `payment-service` (Python) |
| APM | Service Map with meaningful topology | **13 instrumented services** (9 first-party: `voyager-web`, `-api-gateway`, `-search`, `-pricing`, `-booking`, `-payment`, `-loyalty`, `-notifications`, `-ai-support`; plus 4 mocks) + Postgres, Redis, Kafka as downstream nodes |
| APM | Custom spans and span tags | `booking.hold_inventory`, `pricing.evaluate_fare_rules`, `payment.authorize` with tags `booking.id`, `usr.tier`, `search.route`, `payment.provider` (canonical list: `03-EXECUTION-ORDER.md` Phase 8 item 7) |
| APM | Trace metrics + custom trace-based metrics | `trace.voyager.booking.create` used for SLOs |
| APM | Inferred / external service dependencies | HTTP calls to `mock-gds` and `mock-payments` |
| APM | Error Tracking with clean issue grouping | Typed exception hierarchy per service (`InventoryUnavailableError`, `PaymentDeclinedError`, …) |
| APM | Deployment Tracking | `DD_VERSION` from git SHA; chaos panel can deploy a "bad version" flag to show a regression across versions |
| APM | Source Code Integration | `DD_GIT_REPOSITORY_URL` + `DD_GIT_COMMIT_SHA` injected at build |
| APM | Trace → Log correlation | `dd.trace_id` / `dd.span_id` injected into every structured log line in all 4 languages |
| APM | Runtime metrics | Enabled in all tracers (JVM-free, but Node/Python/Go runtime metrics on) |
| RUM | Browser RUM with SPA view tracking | React Router integration, named views per funnel step |
| RUM | Session Replay | Enabled at 100% in `demo` env, with privacy masking on payment inputs |
| RUM | Core Web Vitals | Search results page deliberately ships a large image grid; chaos toggle degrades LCP/INP |
| RUM | Custom actions | `Submit flight search`, `Select flight result`, `Select seat`, `Submit payment`, `Booking confirmed`, `Open support chat` — full taxonomy in `06-USER-FLOWS.md § 7` |
| RUM | Custom user attributes | `usr.id`, `usr.email`, `usr.tier`, `usr.signup_cohort` |
| RUM | RUM → APM correlation | `allowedTracingUrls` on the gateway origin; end-to-end from click to SQL |
| RUM | Frontend error tracking + source maps | Vite sourcemaps uploaded via `datadog-ci` |
| RUM | Browser Logs SDK | Console + custom logs forwarded, correlated with RUM session |
| Logs | Structured JSON logging everywhere | One shared log schema across all 4 languages (see `05-FUNCTIONALITY.md § 12`) |
| Logs | Log pipelines, processors, facets | Grok-free — JSON native; remappers for `status`, `service`, `trace_id`, `usr.id` |
| Logs | Log-based metrics | Generate `voyager.logs.payment_declines` from the declined-payment log |
| Logs | Archives / rehydration (optional) | S3 bucket; needs the optional IAM permission noted in `02-TECH-STACK.md § 9` |
| Infra | Host metrics + Host Map | Single EC2 host, agent on host network |
| Infra | Container metrics + Container Map | All services containerized; `com.datadoghq.ad.*` labels set |
| Infra | Integrations | Postgres, Redis, Kafka, Nginx/Caddy, Docker |
| Infra | Custom business metrics via DogStatsD | `voyager.booking.revenue_cents`, `voyager.booking.confirmed`, `voyager.search.requests`, … (full catalogue: `05-FUNCTIONALITY.md § 14`) |
| Infra | Process monitoring + live processes | Agent process collection enabled |
| Infra | Network Performance Monitoring (optional) | System-probe enabled; noted as optional due to kernel requirements |
| Dashboards | 6 curated dashboards | See § 7 |
| Dashboards | Template variables + saved views | `env`, `service`, `origin`, `usr.tier` (deliberately **not** a combined `route` tag — see the cardinality rule in `05-FUNCTIONALITY.md § 14`) |

### 6.2 Reliability — Synthetics, Monitors, SLOs, Incidents, Watchdog

| Product | Feature | Where it comes from |
|---|---|---|
| Synthetics | API test — health | `GET /health` on the gateway, 1-min interval, multi-location |
| Synthetics | API test — search latency assertion | `POST /api/v1/search/flights`, assert p95 < 1500 ms and `results.length > 0` |
| Synthetics | Multistep API test — full booking | search → hold → pay → confirm, chaining `booking_id` between steps |
| Synthetics | Browser test — checkout funnel | Recorded against the real UI; uses stable `data-dd-action-name` + `data-testid` hooks |
| Synthetics | Browser test — manage booking | PNR lookup → booking detail → cancellation policy. The 5th of the 5 committed tests. |
| Synthetics | Private location (optional) | Container on the same EC2 host, to show internal-only monitoring. **Optional — not one of the 5 committed tests.** |
| Monitors | Latency, error-rate, throughput anomaly | Per-service APM monitors on p95 and error rate |
| Monitors | Composite monitor | "Checkout degraded" = high payment error rate AND falling booking throughput |
| Monitors | DBM monitor | Alert on `postgresql.queries.duration` regression |
| Monitors | Data Streams monitor | Alert on consumer lag > 1000 on `voyager.notifications.outbound` |
| Monitors | Log monitor | Spike in `payment.declined` log events |
| Monitors | Synthetic + integration monitors | Kafka broker down, Redis evictions |
| SLOs | Metric-based SLO | Booking success rate ≥ 99.0%, 30-day rolling |
| SLOs | Monitor-based SLO | Search p95 < 800 ms, 7-day rolling |
| SLOs | Time-slice SLO | Checkout availability from the browser synthetic |
| SLOs | Error budget burn alerts | Fast-burn + slow-burn on the booking SLO |
| Incidents | Incident from a monitor | Scenario S4 (§ 8) is designed to be declared as an incident live |
| Incidents | Timeline, impact, postmortem | Notebook template committed in `/datadog/notebooks/` |
| Watchdog | Automatic anomaly detection | Long-running background load gives Watchdog a baseline to deviate from |
| Watchdog | Watchdog Insights in APM/RUM/Logs | Emerges naturally once chaos scenarios run |

### 6.3 Deep — Profiling, DBM, Data Streams, LLM Observability, CI Visibility

| Product | Feature | Where it comes from |
|---|---|---|
| Profiling | CPU flame graph with an obvious culprit | `pricing-service` fare-rule evaluation is intentionally O(n²) over fare rules; chaos toggle `pricing_hot_path` makes it dominant |
| Profiling | Allocation / heap growth | `booking-service` chaos toggle `booking_memory_leak` retains itinerary objects in a module-level cache |
| Profiling | Lock / wait profile | `booking-service` chaos toggle `hold_lock_contention` narrows an advisory-lock window |
| Profiling | Code Hotspots in traces | Profiler + APM linked via same `DD_SERVICE`/`DD_ENV`/`DD_VERSION` |
| DBM | Query metrics + explain plans | `pg_stat_statements` + `datadog` read-only role; the booking list query is a real N+1 when `db_n_plus_one` is on |
| DBM | Missing-index demonstration | `db_drop_index` chaos toggle drops `idx_bookings_user_id_created_at`, turning a seek into a 400k-row scan |
| DBM | Lock waits and blocking sessions | `db_lock_storm` toggle opens a transaction holding a row lock on `inventory_holds` |
| DBM | Connection pool saturation | `db_pool_starvation` toggle shrinks the pool to 2 |
| Data Streams | Producer/consumer topology + end-to-end latency | Kafka path: `booking-service` → `voyager.bookings.events` → `notification-worker` + `loyalty-service` |
| Data Streams | Consumer lag and throughput | `kafka_consumer_pause` toggle pauses `notification-worker` to build lag |
| Data Streams | Fan-out with a slow consumer | `loyalty-service` has an independent, separately-degradable consumer |
| Data Streams | DLQ path | Poison messages routed to `voyager.notifications.dlq` |
| LLM Obs | Traced LLM chains with tool calls | `ai-support-service` support chat; spans for `workflow`, `llm`, `tool`, `retrieval` |
| LLM Obs | Token usage, cost, latency | Emitted from the LLM span; mock LLM returns realistic usage payloads |
| LLM Obs | Quality signals | Hallucination-bait prompts + a toggle that degrades the model's tool use |
| LLM Obs | LLM → APM correlation | Support chat spans are children of the same gateway trace |
| CI Visibility | Test Optimization across 4 suites | GitHub Actions matrix: Vitest (web-ui), Vitest (Node services), pytest (Python services), `go test` (Go services) |
| CI Visibility | Pipeline Visibility | `datadog-ci` in the Actions workflow |
| CI Visibility | Flaky test detection | One intentionally flaky test, tagged and documented |
| CI Visibility | Static Analysis / Code Quality (optional) | `datadog-ci` SAST step, optional |

---

## 7. Dashboards to ship

Committed as JSON in `/datadog/dashboards/` and importable via `datadog-ci` or the API.

| # | Dashboard | Primary audience | Key widgets |
|---|---|---|---|
| D1 | **Voyager — Business Health** | Exec / anyone | Bookings/min, revenue booked, conversion funnel from RUM, SLO status tiles, top routes |
| D2 | **Voyager — Service Overview** | SRE | Per-service RED metrics, service map embed, error-rate heatmap, deployment markers |
| D3 | **Voyager — Checkout Deep Dive** | SRE / dev | Trace-metric latency breakdown per checkout stage, hold expiry rate, payment decline codes, idempotency replays |
| D4 | **Voyager — Data Layer** | SRE | DBM top queries, connection pool, Redis hit ratio and evictions, Kafka lag by consumer group |
| D5 | **Voyager — Frontend Experience** | Dev / product | Core Web Vitals by view, JS error rate, session replay shortlist, funnel drop-off by step |
| D6 | **Voyager — AI Support** | Dev / product | LLM latency, tokens, cost, tool-call success rate, escalation rate |

Plus one **Notebook**: `Voyager — Incident Postmortem Template`.

---

## 8. Chaos scenarios (the demo repertoire)

Individual toggles are listed in `05-FUNCTIONALITY.md § 11`. These are the *composite* scenarios the admin panel exposes as one-click buttons, each written to tell a complete story.

Flag names below are exactly as defined in `05-FUNCTIONALITY.md § 11`. These flag sets are canonical — the committed JSON in `tools/scenarios/` must match them exactly.

| ID | Scenario | Flags it sets | The story you tell |
|---|---|---|---|
| S1 | **Third-party degradation** | `gds_latency_ms=1500`, `gds_latency_mode=p99_tail`, `gds_error_rate=0.05`, `gds_provider_down=TRVP` | Search gets slow, but only sometimes. The trace shows the time is *not* ours. One provider is the whole tail. Watchdog flags it. |
| S2 | **Payment provider brownout** | `payment_latency_ms=3000`, `payment_error_rate=0.30`, `payment_decline_rate=0.25`, `payment_decline_mix=insufficient_funds`, `payment_webhook_delay_ms=15000` | Bookings stall at `PENDING_PAYMENT`. Error Tracking groups declines cleanly. Composite monitor fires. Revenue widget dives. |
| S3 | **The missing index** | `db_drop_index=true`, `db_n_plus_one=true` | `/account` (`GET /bookings/mine`) times out. DBM shows the plan flip from Index Scan to Seq Scan. Fix is one toggle away. |
| S4 | **Cache stampede → cascade** | `redis_disabled=true`, `cache_ttl_seconds=1`, `gds_rate_limit_aggressive=true`, `gds_latency_ms=800`, `gds_error_rate=0.10`, load at 2× | Cold cache drives GDS fan-out 20×, GDS rate-limits, search errors, holds expire, bookings fail. Full incident narrative — declare it live. |
| S5 | **Slow consumer** | `kafka_consumer_pause=voyager-notifications-v1`, `kafka_slow_consumer_ms=2000`, `kafka_poison_rate=0.05`, `email_failure_rate=0.10` | Bookings confirm but confirmation emails never arrive. Data Streams Monitoring shows exactly which hop is the problem, and the DLQ fills. |
| S6 | **The hot deploy** | `version_override=v2-bad`, `pricing_hot_path=true` | p95 regresses right at a deployment marker. Profiler flame graph finds the O(n²) loop. Code Hotspots links to the line. |
| S7 | **Memory leak** | `booking_memory_leak=true` | RSS climbs over 20 minutes, GC pressure rises, then OOM restarts. Live Processes + allocation profile tell the story. |
| S8 | **Frontend-only regression** | `frontend_heavy_assets=true`, `frontend_blocking_js=true`, `frontend_layout_shift=true`, `frontend_js_error_rate=0.03` | Backend is perfectly healthy; users complain anyway. RUM Core Web Vitals + Session Replay make the invisible visible. |
| S9 | **AI support goes off the rails** | `llm_degrade_tools=true`, `llm_latency_ms=4000`, `llm_hallucinate=true`, `llm_token_bloat=true`, `llm_error_rate=0.05` | Support chat stops calling the booking tool and starts making things up. LLM Obs shows tool-call failure and token blowup. |
| S10 | **Lock contention** | `hold_lock_contention=true`, `db_lock_storm=true`, `db_pool_starvation=true`, load at 2× | Seat holds serialize. Wait profile and DBM blocking sessions converge on the same advisory lock. |

**Hard requirement:** every scenario must be fully reversible by pressing **Reset all chaos**, and the system must return to healthy within 60 seconds without a container restart. The one exception is S7 (memory leak), which requires a documented single-service restart.

---

## 9. Data volume and realism requirements

Empty-looking data ruins demos faster than bugs. Seed targets:

| Entity | Seed volume | Notes |
|---|---|---|
| Airports | ~500 | Real IATA codes, real city/country names |
| Cities | ~300 | For hotel search |
| Airlines | ~40 | Fictional names, realistic two-letter codes |
| Flight schedules | ~150,000 | **365 days forward** — must cover the full search window allowed by `05-FUNCTIONALITY.md § 15`, or long-dated searches return nothing |
| Hotels | ~5,000 | With rate plans and room types |
| Fare rules | ~2,000 | This is what `pricing-service` loops over — the volume is what makes the hot path hot |
| Users | ~10,000 | Spread across `standard` / `silver` / `gold` / `platinum` tiers |
| Historical bookings | ~400,000 | **Required** — this is what makes the missing-index demo (S3) real |
| …of which: power users | **20 users with 300–800 bookings each** | **Required.** The S3 demo needs a signed-in user whose `/account` page is genuinely expensive to load. Without deliberate skew, the average user has ~40 bookings and the demo has no subject. Seed these with fixed, documented email addresses (`power1@voyager.demo` … `power20@voyager.demo`, password `demo1234`). |
| Payments | ~400,000 | One per booking, mixed statuses |

Seeding must be deterministic (fixed RNG seed) so demos are reproducible, and must complete in under 5 minutes on the target instance.

---

## 10. Success criteria (definition of done)

The project is done when all of the following are true on a deployed EC2 instance:

1. **Trace depth:** a single checkout produces one trace with ≥ 40 spans across ≥ 7 services and 4 runtimes, with no orphaned or broken context propagation.
2. **Full-stack correlation:** from a RUM session replay you can click into the APM trace, then into the exact log lines, then into the DBM query for that request.
3. **Coverage:** every row of § 6 is demonstrable, with the file path that produces it documented in `05-FUNCTIONALITY.md`.
4. **Chaos:** all 10 scenarios in § 8 fire and revert correctly, verified twice.
5. **Always-on:** dashboards show ≥ 24 hours of continuous, non-flat data with no human intervention.
6. **Dashboards and monitors as code:** all 6 dashboards, all monitors, all 3 SLOs, and all 5 synthetic tests exist as committed JSON/YAML and can be recreated from scratch with one command.
7. **Reproducible deploy:** a fresh EC2 instance goes from empty to fully working in ≤ 30 minutes following `README.md` only.
8. **Tests green in CI:** GitHub Actions runs all four test suites, reports to Test Optimization, and the one known-flaky test is visibly flagged as flaky.
9. **Reset works:** `make reset` returns the system to a clean, seeded, healthy state in under 5 minutes.
10. **Demo scripts run clean:** both narratives in `06-USER-FLOWS.md § 9` can be delivered end-to-end without touching a terminal.

---

## 11. Future work (do not build in v1)

Tracked explicitly so Cursor does not wander into it:

- **App & API Protection (ASM/AAP)** — a deliberately attackable search endpoint, blocking rules, API inventory.
- **Sensitive Data Scanner** — passenger PII and card-like strings in logs, with redaction rules.
- **Cloud Security Management / CSPM** — agent-side host compliance on the EC2 instance.
- **Cloud SIEM + Audit Trail.**
- **Kubernetes variant** — k3s on the same host, Datadog Helm chart, Orchestrator Explorer.
- **Mobile RUM** — a React Native companion app.
- **Multi-region / multi-host** — to make the Host Map and NPM more interesting.
- **Real third-party sandboxes** — Stripe test mode, a real flight-data API.
- **Cost Management / CCM** — needs real AWS spend to be meaningful.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Single EC2 instance can't hold ~21 containers + Kafka + Postgres + 400k rows | Target `m5.xlarge` (4 vCPU / 16 GB) minimum; per-service memory limits in Compose; Kafka in KRaft single-broker mode; see the memory budget in `02-TECH-STACK.md § 9.1` |
| Polyglot repo is slow to iterate on in Cursor | Strict per-service isolation, one Dockerfile each, `make up-one s=<service>` for single-service rebuilds |
| Chaos state drifts and the demo starts broken | `make healthcheck` asserts all chaos flags are off and all services green; run it before every demo |
| Datadog costs from 100% trace + replay sampling | Ingestion controls documented in `02-TECH-STACK.md § 8`; `DD_TRACE_SAMPLE_RATE` configurable; replay sampling reducible |
| Mock LLM makes LLM Obs look fake | Mock returns realistic token counts, latency distributions, and streaming; a real provider key can be swapped in via one env var |
| Seed data generation is slow | Bulk `COPY` inserts, not ORM row-by-row; seeding is a separate one-shot container |

---

## 13. Glossary

- **Hold** — a time-limited reservation of inventory (seat or room) created before payment. 15-minute TTL.
- **GDS** — Global Distribution System; the upstream flight/hotel inventory provider. Mocked here.
- **Chaos flag** — a Redis-backed boolean or value that changes runtime behavior without a restart.
- **Scenario** — a named bundle of chaos flags representing one demo story.
- **PNR** — the booking reference shown to the user (6-character alphanumeric).
