# 06 — User Flows & Demo Narratives

Two kinds of flow live in this document: what a **customer** does in Voyager, and what **you** do in front of an audience. Both matter. The second is the reason the first exists.

---

## 1. Personas

| Persona | Who | Uses |
|---|---|---|
| **Guest shopper** | Unauthenticated visitor | Search, view detail, guest checkout |
| **Member** | Signed-in customer, has a tier | Everything, plus loyalty and booking history |
| **Returning traveller** | Has a PNR, not signed in | Manage booking, cancel, support chat |
| **Operator (you)** | The person running the demo | The Ops console at `/admin` |

The load generator drives all three customer personas in realistic proportions (`03-EXECUTION-ORDER.md` Phase 11).

---

## 2. Routes and screens

| Route | Screen | RUM view name | Auth |
|---|---|---|---|
| `/` | Home — search panel, deals, upcoming trips | `/home` | optional |
| `/search/flights` | Flight search form (deep-linkable) | `/search/flights` | optional |
| `/search/hotels` | Hotel search form | `/search/hotels` | optional |
| `/results/flights/:searchId` | Flight results + filters | `/results/flights` | optional |
| `/results/hotels/:searchId` | Hotel results + filters | `/results/hotels` | optional |
| `/detail/:searchId/:resultId` | Fare/rate detail, fare rules, seat map | `/detail` | optional |
| `/checkout/:bookingId/review` | Review + ancillaries | `/checkout/review` | optional |
| `/checkout/:bookingId/passengers` | Passenger details | `/checkout/passengers` | optional |
| `/checkout/:bookingId/payment` | Payment | `/checkout/payment` | optional |
| `/confirmation/:bookingId` | Confirmation + PNR | `/confirmation` | optional |
| `/manage` | PNR + surname lookup | `/manage` | none |
| `/manage/:pnr` | Booking detail, cancel, support entry | `/manage/detail` | PNR-scoped |
| `/account` | Profile, booking history, loyalty | `/account` | required |
| `/login`, `/signup` | Auth | `/login`, `/signup` | none |
| `/admin` | Ops console (Chaos / Scenarios / Load / Status / Data) | `/admin` | admin secret |
| anything else | Not found | `/not-found` | none |

`/not-found` is a view name rather than an omission on purpose. RUM has to call the view something, and leaving it unnamed would charge a mistyped URL's resources and errors to whichever screen the visitor came from.

**RUM view naming rule:** use the *pattern*, never the instantiated path. `/results/flights`, not `/results/flights/srch_01J8XYZ`. Instance IDs go in view attributes. Getting this wrong produces thousands of one-off views and makes RUM analytics useless.

---

## 3. Primary flow — flight booking (the demo spine)

This is the flow you will run most often. Every step lists what it does and what it produces in Datadog, because the two are designed together.

### Step 1 — Home → search
The user lands on `/`, which fires `GET /bff/home` (4 downstream services). They pick LHR → JFK, dates two weeks out, 1 adult, economy, and press Search.

- **RUM:** view `/home`, action `Submit flight search`
- **APM:** one gateway trace fanning out to 4 services
- **Custom timing:** this is where `time_to_first_result` starts its clock

### Step 2 — Results
`POST /api/v1/search/flights` → the full search pipeline in `05-FUNCTIONALITY.md § 7`. Skeleton rows render immediately; results replace them.

- **RUM:** view `/results/flights`; custom timing `time_to_first_result`; view attributes `route`, `cabin`, `result_count`, `cache_hit`
- **APM:** ~22 spans — gateway → search → 4 parallel GDS calls → pricing batch → Redis write
- **Metrics:** `voyager.search.requests`, `voyager.search.results_count`, `voyager.search.provider_latency`
- **This is the screen to open your demo on.** Cold vs warm search is the fastest way to make caching visible: run the same search twice and watch 1.8 s become 80 ms.

### Step 3 — Filter and sort
Every filter change re-queries the gateway against the cached result set.

- **RUM:** actions `Filter by stops`, `Filter by airline`, `Change sort`, `Adjust price range`
- **APM:** short cache-hit traces — useful for showing a healthy p50 alongside a fat p99

### Step 4 — Detail
`GET /search/:searchId/results/:resultId` — segments, fare rules, baggage, seat map availability.

- **RUM:** view `/detail`, action `View fare details`

### Step 5 — Checkout init
Select → `POST /bff/checkout/init`. This is the widest single request in the app: validate offer, verify with GDS, re-price, create draft, acquire hold, preview loyalty points. The hold countdown timer starts at 15:00.

- **RUM:** action `Select flight result`; view `/checkout/review`
- **APM:** 4 services, 6+ calls, including `booking.acquire_hold_lock` and `booking.hold_inventory`
- **Metrics:** `voyager.hold.created`, `voyager.booking.created`

### Step 6 — Ancillaries
Optional: seat, bags, insurance. Each selection re-prices via `pricing-service`.

- **RUM:** actions `Select seat`, `Add baggage`, `Add insurance`

### Step 7 — Passengers
`PUT /bookings/:id/passengers`, validated per `05-FUNCTIONALITY.md § 15`.

- **RUM:** view `/checkout/passengers`, action `Submit passenger details`, timing `checkout_step_duration`

### Step 8 — Payment
`POST /payments/authorize` with an idempotency key. Booking → `PENDING_PAYMENT`. The 3DS card triggers a step-up modal.

- **RUM:** view `/checkout/payment`, action `Submit payment`. **Card fields are masked in Session Replay.**
- **APM:** `payment.idempotency_check` → `payment.authorize` → `mock-payments` → `payment.persist_ledger`
- **Metrics:** `voyager.payment.authorized` or `.declined` with `decline_code`

### Step 9 — Async confirmation
`payment.authorized` → Kafka → `booking-service` → `CONFIRMED` + PNR → `booking.confirmed` → Kafka → `loyalty-service` and `notification-worker` in parallel. The frontend polls `GET /bff/booking/:bookingId` (the UUID — the PNR doesn't exist until `CONFIRMED`) at 1 s intervals.

- **APM:** Kafka-linked spans with Data Streams context
- **Data Streams:** the full producer → topic → 2 consumers topology
- **Metrics:** `voyager.booking.confirmed`, `voyager.booking.revenue_cents`, `voyager.booking.time_to_confirm_ms`, `voyager.loyalty.points_accrued`, `voyager.notifications.sent`

### Step 10 — Confirmation
PNR in a copyable chip, itinerary, total paid, points earned. If the email hasn't landed yet, an amber banner says so — which is exactly the state scenario S5 produces.

- **RUM:** view `/confirmation`, action `Booking confirmed` with attributes `product_type`, `total`, `points_earned`
- **This closes the funnel.** From here you can jump straight into the RUM funnel widget and show the whole session, then into the trace, then the logs.

**End-to-end target with chaos off: 6–9 seconds of wall-clock user time, one RUM session, ~45 APM spans, ~60 log lines, and 7 Kafka messages** (`search.analytics`, `booking.created`, `booking.held`, `payment.authorized`, `booking.confirmed`, `points.accrued`, `notifications.outbound`).

---

## 4. Secondary flow — hotel booking

Structurally identical, with these differences:

- City autocomplete instead of airport pairs; nights instead of a return date.
- Results are image-forward cards, which is what makes `frontend_heavy_assets` (S8) so effective — the hotel results page is the LCP-sensitive screen in the app.
- Ancillaries are room upgrades and breakfast rather than seats and bags.
- Hold is a room-night hold; the same advisory-lock path applies.

Run this flow when you want to demo Core Web Vitals. Run flights when you want to demo trace depth.

---

## 5. Manage booking flow

1. `/manage` — PNR + surname. No auth.
2. `GET /bff/booking/:pnr` → 3 services.
3. `/manage/:pnr` — itinerary, passengers, payment status, cancellation policy, Cancel and Support actions.
4. Cancel → confirmation modal → `POST /bookings/:id/cancel` → `CANCELLED` → refund → `REFUNDED`.

**The authenticated variant is the important one.** `/account` calls `GET /bookings/mine`, which is the query behind `idx_bookings_user_id_created_at`. With 400k bookings and scenario S3 active, this page goes from 40 ms to several seconds, and DBM shows the plan flip. This is the single cleanest DBM demo in the app — know this path by heart.

- **RUM:** views `/manage`, `/manage/detail`, `/account`; actions `Look up booking`, `Cancel booking`, `Confirm cancellation`
- **APM:** the booking-list query, with DBM attribution
- **Metrics:** `voyager.booking.failed` with `failure_reason:user_cancelled`

---

## 6. Support chat flow

1. Launcher (bottom right) → `POST /support/conversations`.
2. User: "I need to cancel my flight, PNR K8M2QR." (Use a PNR from a booking you actually made — the alphabet excludes `0`, `1`, `I`, `O`.)
3. SSE stream opens. The model returns a tool call; the UI renders a chip: `🔍 Looked up booking K8M2QR`.
4. `lookup_booking` → `booking-service` (a full APM subtree inside the LLM trace).
5. Second completion: the real itinerary and cancellation policy, streamed.
6. Model asks for confirmation. User says yes. `initiate_cancellation` runs — gated in the tool handler, not the prompt.
7. Booking cancelled, refund initiated, chip: `✅ Cancellation initiated`.

- **RUM:** action `Open support chat`, `Send support message`
- **LLM Obs:** `workflow` → `retrieval` → `llm` → `tool` → `llm` → `task`, with tokens and cost per span
- **Metrics:** `voyager.support.conversations`, `.tool_calls`, `.tokens`, `.escalations`

The visible tool-call chips are doing real work for you here: the audience understands the trace structure before you've switched tabs.

---

## 7. RUM action taxonomy

Keep the total set under ~40 names. Variable detail goes in action *attributes*, never in the name.

| Action name | Where | Attributes |
|---|---|---|
| `Submit flight search` | Home, search form | `origin`, `destination`, `cabin`, `pax`, `days_ahead` |
| `Submit hotel search` | Home, search form | `city`, `nights`, `guests` |
| `Swap airports` | Search form | — |
| `Select airport suggestion` | Combobox | `field` |
| `Filter by stops` / `by airline` / `by price` / `by time` | Results | `value` |
| `Change sort` | Results | `sort` |
| `Load more results` | Results | `page` |
| `Select flight result` | Results | `position`, `price_band`, `stops` |
| `Select hotel result` | Results | `position`, `star_rating`, `price_band` |
| `View fare details` | Results, detail | — |
| `Select seat` / `Add baggage` / `Add insurance` / `Upgrade room` | Checkout | `price_band` |
| `Submit passenger details` | Checkout | `passenger_count` |
| `Submit payment` | Checkout | `card_brand`, `requires_3ds` |
| `Complete 3DS challenge` | Checkout | `outcome` |
| `Booking confirmed` | Confirmation | `product_type`, `price_band`, `points_earned` |
| `Copy PNR` | Confirmation, manage | — |
| `Look up booking` | Manage | — |
| `Cancel booking` / `Confirm cancellation` | Manage | `refundable` |
| `Open support chat` / `Send support message` | Any | `intent` |
| `Sign in` / `Sign up` / `Sign out` | Auth | — |
| `Toggle theme` | Header | `theme` |
| `Retry search` | Error state | `error_kind` |

**`price_band`, not `price`.** Bucket prices into `0-200`, `200-500`, `500-1000`, `1000+`. A raw price in an action attribute is unbounded cardinality.

### 7.1 Custom timings

| Timing | Start | Stop |
|---|---|---|
| `time_to_first_result` | Search submitted | First result row painted |
| `time_to_interactive_results` | Search submitted | Filters usable |
| `checkout_step_duration` | Step mounted | Step submitted |
| `time_to_confirmation` | Payment submitted | Confirmation page rendered |
| `support_first_token` | Message sent | First streamed token |

### 7.2 User context

On login: `datadogRum.setUser({ id, email, name, tier, signup_cohort })`. On logout: `clearUser()`. Guest sessions get `setGlobalContextProperty('user_type', 'guest')` so you can segment the funnel by guest vs member — which is a genuinely interesting product question and makes the RUM demo feel like a real analysis rather than a feature tour.

---

## 8. Funnel definition

Configure this as a RUM funnel widget on dashboard D5.

| Step | View / action | Realistic conversion (loadgen tuned to this) |
|---|---|---|
| 1 | `/home` or `/search/*` | 100% |
| 2 | `Submit flight search` | 72% |
| 3 | `/results/*` viewed | 70% |
| 4 | `Select flight result` | 34% |
| 5 | `/checkout/review` | 33% |
| 6 | `Submit passenger details` | 24% |
| 7 | `Submit payment` | 19% |
| 8 | `Booking confirmed` | 17% |

These are deliberately OTA-plausible. A demo funnel that converts at 90% tells the audience it's fake. The steepest real drop-off is results → selection, and that's where scenario S1 (slow search) and S8 (bad Core Web Vitals) visibly make things worse — which is the point of having a funnel at all.

---

## 9. Demo narratives

Two scripted runs, matching the two audiences in `01-PRD.md § 4`. Commit these as runbooks. Both assume `make healthcheck` passed and all chaos is off.

---

### 9.1 SRE / Platform deep dive — 45 minutes

**Setup:** two browser windows — Voyager on the left, Datadog on the right. Ops console open in a third tab. Load generator at `1x`.

**Act 1 — "Here is the system" (7 min)**
1. Open the Service Map. 13 services, 4 runtimes, Postgres, Redis, Kafka. Let them look at it.
2. Complete one flight booking by hand in the left window.
3. Open the trace. 45 spans, browser to database. Walk the waterfall: the parallel GDS fan-out, the pricing call, the hold lock, the payment, then the Kafka handoff to two independent consumers.
4. Point out what they're seeing: one trace, four languages, no manual correlation IDs.

**Act 2 — "Something is slow and it isn't us" (8 min) — Scenario S1**
1. Ops console → Apply **S1: Third-party degradation**.
2. Search a few times. It's slow, but inconsistently so.
3. Datadog: search p95 rises, p50 barely moves. Open a slow trace.
4. The time is in `mock-gds`, not in your code. One provider is the tail.
5. Show `voyager.search.provider_latency` broken down by provider — one provider is the whole story.
6. Check Watchdog for an automatically-surfaced anomaly.
7. Revert.

**Act 3 — "The missing index" (10 min) — Scenario S3**
1. Sign in as one of the seeded power users (`power1@voyager.demo` / `demo1234` — 300–800 bookings). Load `/account`. It's fast.
2. Apply **S3**.
3. Reload `/account`. It crawls.
4. APM: the endpoint's p95 has jumped 10×+. Open a trace — the time is one Postgres span.
5. Click into DBM. Same query, same normalized text, execution plan flipped from Index Scan to Seq Scan, rows scanned in the hundreds of thousands.
6. Show the explain plan side by side with the earlier one.
7. Revert. Watch it recover live. **This is usually the moment the room goes quiet — DBM plan comparison is the most concrete thing in the whole demo.**

**Act 4 — "The cascade" (12 min) — Scenario S4**
1. Apply **S4: Cache stampede**, and raise load to `2x`.
2. Narrate the cascade as it unfolds in the dashboards: cache hit ratio → 0, GDS call volume up 20×, rate-limit 429s appear, search errors climb, holds start expiring, booking success rate falls, revenue widget dives.
3. Monitors fire. The composite "Checkout degraded" monitor triggers.
4. Declare an incident from the monitor. Add the dashboard and the trace as evidence.
5. Walk the SLO error budget burning down in real time.
6. Revert, and watch recovery. Close the incident and show the postmortem notebook template.

**Act 5 — "Where is the CPU going?" (8 min) — Scenario S6**
1. Apply **S6: Hot deploy** — this sets `version_override=v2-bad` (which changes the reported `DD_VERSION`) and turns on `pricing_hot_path`.
2. APM: p95 on `voyager-pricing` regresses right at the deployment marker. Compare versions side by side.
3. Continuous Profiler: the flame graph is dominated by `evaluateFareRules` and `regexp.MustCompile`.
4. Code Hotspots links the span straight to the line, and Source Code Integration opens it in GitHub.
5. Revert.

**Closing (optional, if they're engaged)** — Data Streams with **S5**, or lock contention with **S10**.

---

### 9.2 Developer / APM walkthrough — 25 minutes

**Setup:** Cursor or an IDE open on the repo, plus Datadog. Load generator at `1x`.

**Act 1 — "Instrumentation is four files" (6 min)**
1. Open `services/booking-service/app/tracing.py`. That's the tracer. Show the Dockerfile `CMD` with `ddtrace-run`.
2. Open `services/api-gateway/src/tracer.ts` and the `--require` flag. Explain *why* load order matters and what silently breaks when it's wrong.
3. Open `services/search-service/internal/trace/trace.go`. Six lines plus contrib wiring.
4. Open `apps/web-ui/src/datadog/rum.ts` — and specifically `allowedTracingUrls`. That single option is what connects the browser to the backend trace.
5. Land the point: four languages, four small files, one trace.

**Act 2 — "Custom spans that mean something" (6 min)**
1. Open `booking-service/app/domain/booking.py` and show `booking.acquire_hold_lock`, `booking.hold_inventory`, `booking.state_transition`.
2. Show the span tags: `booking.id`, `booking.state`, `usr.tier`.
3. Find that exact trace in Datadog and point at the spans you just read.
4. Show a trace search filtered by `@booking.state:CONFIRMED` and `@usr.tier:platinum` — arbitrary business questions answered from trace tags.

**Act 3 — "Errors that group correctly" (5 min)**
1. Open the typed error hierarchy. Explain why `error.type` is a class name and `message` is a constant.
2. Apply **S2: Payment brownout**.
3. Error Tracking: a small number of clean issue groups, not thousands of unique errors.
4. Contrast with what interpolated messages would have produced.
5. Show that declines are *tagged outcomes*, not span errors — and why that keeps the error rate and the SLO honest.
6. Revert.

**Act 4 — "Logs and traces are the same thing" (4 min)**
1. Open `05-FUNCTIONALITY.md § 12` — one schema, four languages.
2. Take a trace ID from a span, search logs by it. Every line from every service, in order.
3. Click a log line → back to the trace. Click the span → the code in GitHub.

**Act 5 — "It's all in CI" (4 min)**
1. Open the GitHub Actions run. Four test suites, all reporting to Test Optimization.
2. Show the flaky test flagged as flaky, with its history.
3. Show Pipeline Visibility with build durations.
4. Close on `make deploy`: `DD_VERSION` from the git SHA, sourcemaps uploaded, deployment marker appears in APM.

---

## 10. Pre-demo checklist

Run this every time. Ten minutes of checks beats a dead demo.

```
[ ] make healthcheck          → all green, zero active chaos flags
[ ] Load generator running at 1x for ≥ 30 minutes (dashboards have shape)
[ ] make demo-mode            → sampling at 100%
[ ] Complete one manual booking end-to-end; note the PNR
[ ] Confirm that booking's trace has ≥ 40 spans
[ ] Confirm its Session Replay exists and the card field is masked
[ ] All 6 dashboards open in tabs, no "no data" widgets
[ ] Ops console open in its own tab, Reset All Chaos visible
[ ] Signed in as a power user (power1@voyager.demo / demo1234) in a second tab, for S3
[ ] Apply and revert one scenario as a smoke test, then reset
[ ] Browser zoom at 110–125% so the room can read it
[ ] Notifications and Slack silenced
```

---

## 11. Recovery — when a demo goes wrong

| Symptom | Do this |
|---|---|
| Traces look truncated | Check `DD_TRACE_PROPAGATION_STYLE` on the service where the trace stops. This is the cause the overwhelming majority of the time. |
| A service is unhealthy | `make up-one s=<service>`. Takes ~20 s. Keep talking. |
| Chaos won't revert | `make chaos-reset`, then hard-reload the Ops console. If an index is still missing, `make migrate` recreates it. |
| Dashboards are empty | Check that the load generator is running: `docker compose ps loadgen-api loadgen-browser`. |
| RUM sessions missing | Check the client token and `VITE_DD_RUM_APPLICATION_ID`, and that you're on HTTPS. |
| Postgres was OOM-killed | `make up-one s=postgres`; data survives in the volume. Then `make healthcheck`. |
| Memory-leak scenario left the box wedged | `docker compose restart booking-service` — the one scenario that needs a restart, and it's documented. |
| Everything is confusing | `make reset`. Five minutes to a clean, seeded, healthy system. Say you're resetting the environment; nobody minds. |

**The honest move:** if something breaks and you can't fix it in 30 seconds, say so and pivot to a dashboard or a saved trace. An operator who debugs their own demo calmly is more convincing than one whose demo never breaks — especially when the product you're selling is the thing that would have told them what went wrong.
