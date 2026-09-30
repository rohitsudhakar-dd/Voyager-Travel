# 02 — Tech Stack

Canonical reference for every technology choice, version, port, service name, and environment variable in Voyager. **When any other document and this one disagree, this one wins.**

---

## 1. Service inventory

All services run as containers on one EC2 host, on a user-defined bridge network named `voyager`. Only the edge proxy binds to host ports.

| Container | Language / Runtime | Framework | Internal port | `DD_SERVICE` | Repo path |
|---|---|---|---|---|---|
| `edge` | — | Caddy 2.8 | 80 / 443, **2019 (internal)** | `voyager-edge` | `infra/edge/` |
| `web-ui` | Node 20 build → Nginx 1.27 runtime | React 18 + Vite 5 + TypeScript 5.5 | 8080 | `voyager-web` (RUM) | `apps/web-ui/` |
| `api-gateway` | Node 20.17 LTS | Fastify 4 + TypeScript | 4000 | `voyager-api-gateway` | `services/api-gateway/` |
| `search-service` | Go 1.23 | chi v5 | 4010 | `voyager-search` | `services/search-service/` |
| `pricing-service` | Go 1.23 | chi v5 | 4020 | `voyager-pricing` | `services/pricing-service/` |
| `booking-service` | Python 3.12 | FastAPI 0.115 + uvicorn | 4030 | `voyager-booking` | `services/booking-service/` |
| `payment-service` | Python 3.12 | FastAPI 0.115 + uvicorn | 4040 | `voyager-payment` | `services/payment-service/` |
| `loyalty-service` | Node 20.17 | Fastify 4 + KafkaJS | 4050 | `voyager-loyalty` | `services/loyalty-service/` |
| `notification-worker` | Python 3.12 | aiokafka + FastAPI (health only) | 4060 | `voyager-notifications` | `services/notification-worker/` |
| `ai-support-service` | Python 3.12 | FastAPI 0.115 | 4070 | `voyager-ai-support` | `services/ai-support-service/` |
| `mock-gds` | Node 20.17 | Fastify 4 | 4900 | `mock-gds` | `mocks/mock-gds/` |
| `mock-payments` | Node 20.17 | Fastify 4 | 4910 | `mock-payments` | `mocks/mock-payments/` |
| `mock-email` | Node 20.17 | Fastify 4 | 4920 | `mock-email` | `mocks/mock-email/` |
| `mock-llm` | Node 20.17 | Fastify 4 (SSE streaming) | 4930 | `mock-llm` | `mocks/mock-llm/` |
| `postgres` | — | PostgreSQL 16.4 | 5432 | `voyager-postgres` | `infra/postgres/` |
| `redis` | — | Redis 7.4 | 6379 | `voyager-redis` | `infra/redis/` |
| `kafka` | — | Apache Kafka 3.8 (KRaft, single broker) | 9092, **9999 (JMX)** | `voyager-kafka` | `infra/kafka/` |
| `datadog-agent` | — | Datadog Agent 7 (latest) | 8126 / 8125 / 5002 | — | `infra/datadog/` |
| `seeder` | Python 3.12 | one-shot job | — | `voyager-seeder` | `tools/seeder/` |
| `loadgen-api` | — | k6 0.53 | — | `voyager-loadgen-api` | `tools/loadgen-api/` |
| `loadgen-browser` | Node 20.17 | Playwright 1.47 (Chromium) | — | `voyager-loadgen-browser` | `tools/loadgen-browser/` |

**Port convention:** `49xx` = mocks, `40xx` = first-party services, in dependency order. Keep it.

**The edge's 2019** is Caddy's Prometheus endpoint, served by the `metrics` directive on a listener that is never published to the host. Two things read it: the Agent's `caddy` check (autodiscovered from a label on the container, § 6.1) and the container's own healthcheck. Liveness has to live there rather than on 80 or 443, because a probe through the site block would depend on `api-gateway` or `web-ui` — and an edge that reports unhealthy because the API is down cannot serve the "the API is down" screen, which is a screen the demo needs.

**Service count:** 13 services appear in APM — 9 first-party (`voyager-web` via RUM, `-api-gateway`, `-search`, `-pricing`, `-booking`, `-payment`, `-loyalty`, `-notifications`, `-ai-support`) plus the 4 mocks. `edge` is visible via the Caddy integration but is not tracer-instrumented. Postgres, Redis, and Kafka appear as downstream nodes. Total Compose containers: ~21 including data layer, agent, seeder, and load generators.

---

## 2. Why these choices

| Choice | Reason |
|---|---|
| **Polyglot (Node / Go / Python)** | Cross-runtime context propagation is the single most convincing thing a Datadog demo can show. A single-language app can't show it. |
| **Fastify over Express** | First-class async, better `dd-trace-js` integration, and the plugin model keeps the instrumentation file small and legible. |
| **Go with chi** | Minimal middleware surface means `dd-trace-go` wiring is 6 lines you can show on a slide. |
| **FastAPI over Django** | Async-native, so consumer lag and slow-dependency behavior are realistic; `ddtrace` auto-instruments it cleanly. |
| **Kafka, not SQS/RabbitMQ** | Data Streams Monitoring's strongest support, and consumer-group lag is the most intuitive queue metric to demo. |
| **Kafka in KRaft mode** | No ZooKeeper container. Saves ~400 MB RAM on a single host. |
| **Postgres, not MySQL** | `pg_stat_statements` + `EXPLAIN (ANALYZE, BUFFERS)` give the richest DBM story. |
| **Redis** | Cache-hit-ratio and eviction metrics are easy wins, and it doubles as the chaos-flag store. |
| **Vite SPA, not Next.js** | Keeps the RUM → APM boundary crisp (browser calls the gateway directly). SSR would blur the "where did the time go" story. |
| **Caddy over Nginx at the edge** | Automatic TLS from a single line of config; matters because RUM and Session Replay behave best over HTTPS. |
| **Mock third parties in-repo** | Zero external accounts, zero rate-limit surprises mid-demo, and full control over latency distributions. |
| **k6 for API load, Playwright for browser load** | RUM needs a real browser engine. k6 alone cannot generate RUM sessions. |

---

## 3. Frontend stack — `apps/web-ui`

```
react                    18.3.x
react-dom                18.3.x
react-router-dom          6.26.x
typescript                 5.5.x
vite                        5.4.x
@vitejs/plugin-react        4.3.x
tailwindcss                 3.4.x
@tanstack/react-query       5.56.x    # server state, retries, cache
zustand                     4.5.x     # local UI state only
react-hook-form             7.53.x
zod                         3.23.x    # shared schemas with the gateway
date-fns                    3.6.x
lucide-react                0.44.x    # icons
clsx + tailwind-merge                 # className composition
recharts                    2.12.x    # admin panel charts only

@datadog/browser-rum        5.x
@datadog/browser-logs       5.x
```

Dev / CI:
```
vitest, @testing-library/react, @playwright/test
eslint + @typescript-eslint, prettier
@datadog/datadog-ci         # sourcemap upload
```

**Build output:** static assets served by Nginx inside the `web-ui` container. Sourcemaps are generated (`build.sourcemap: true`), uploaded to Datadog at deploy time, and **not** served publicly.

---

## 4. Backend stacks

### 4.1 Node services (`api-gateway`, `loyalty-service`, all mocks)

```
fastify                     4.28.x
@fastify/cors               9.x
@fastify/helmet             11.x
@fastify/rate-limit         9.x
@fastify/jwt                8.x
zod + fastify-type-provider-zod
pino                        9.x        # JSON logging
undici                      6.x        # HTTP client (traced)
ioredis                     5.4.x
pg                          8.12.x
kafkajs                     2.2.x
hot-shots                   10.x       # DogStatsD client
dd-trace                    5.x        # MUST be imported before anything else
```

Dev: `tsx`, `typescript`, `vitest`, `pino-pretty`.

**Non-negotiable:** `dd-trace` must be initialised in a dedicated `src/tracer.ts` that is imported as the *very first* line of `src/index.ts` — or better, loaded via `node --require ./dist/tracer.js`. If it loads after `fastify` or `pg`, auto-instrumentation silently does nothing.

### 4.2 Go services (`search-service`, `pricing-service`)

```go
github.com/go-chi/chi/v5                    v5.1.x
github.com/jackc/pgx/v5                     v5.6.x   // + pgxpool
github.com/redis/go-redis/v9                v9.6.x
github.com/rs/zerolog                       v1.33.x  // JSON logging
github.com/DataDog/datadog-go/v5/statsd     v5.5.x
gopkg.in/DataDog/dd-trace-go.v1             v1.69.x
  // contrib packages used:
  //   contrib/go-chi/chi.v5
  //   contrib/jackc/pgx.v5
  //   contrib/redis/go-redis.v9
  //   contrib/net/http                 (traced client)
  //   profiler
```

Build: multi-stage, `CGO_ENABLED=0`, distroless or `alpine` runtime. **Keep DWARF symbols** (`-gcflags` default, do *not* pass `-s -w` to the linker) or the profiler flame graph loses function names.

### 4.3 Python services (`booking-service`, `payment-service`, `notification-worker`, `ai-support-service`)

```
fastapi                     0.115.x
uvicorn[standard]           0.30.x
pydantic                     2.9.x
pydantic-settings            2.5.x
sqlalchemy                   2.0.x     # async, with asyncpg
asyncpg                      0.29.x
alembic                      1.13.x    # migrations
redis                        5.0.x     # asyncio client
aiokafka                     0.11.x
httpx                        0.27.x
structlog                   24.4.x     # JSON logging
datadog                      0.50.x    # DogStatsD
ddtrace                      2.13.x
```

`ai-support-service` additionally:
```
openai                       1.50.x    # points at mock-llm via base_url, or a real provider
ddtrace.llmobs                          # ships with ddtrace
```

Dev: `pytest`, `pytest-asyncio`, `httpx`, `ruff`, `mypy`.

**Non-negotiable:** Python services are launched with `ddtrace-run uvicorn …` **or** `import ddtrace.auto` at the top of the entrypoint. Pick one and use it consistently — `ddtrace-run` is preferred because it's visible in the Dockerfile CMD.

---

## 5. Datadog instrumentation matrix

| Concern | Node | Go | Python | Browser |
|---|---|---|---|---|
| Tracer | `dd-trace` v5, preloaded | `dd-trace-go` v1, `tracer.Start()` in `main()` | `ddtrace-run` | `@datadog/browser-rum` |
| Custom spans | `tracer.trace(name, opts, fn)` | `tracer.StartSpanFromContext` | `@tracer.wrap()` / `tracer.trace()` | `addAction` / `addTiming` |
| Span tags | `span.setTag()` | `span.SetTag()` | `span.set_tag()` | `setGlobalContextProperty` |
| Logs | `pino` + `dd-trace` log injection (`logInjection: true`) | `zerolog` + manual `dd.trace_id` from span context | `structlog` + `DD_LOGS_INJECTION=true` | `@datadog/browser-logs` |
| Metrics | `hot-shots` → UDP 8125 | `datadog-go/statsd` → UDP 8125 | `datadog.dogstatsd` → UDP 8125 | RUM custom vitals |
| Runtime metrics | `DD_RUNTIME_METRICS_ENABLED=true` | `WithRuntimeMetrics()` | `DD_RUNTIME_METRICS_ENABLED=true` | n/a |
| Profiler | `DD_PROFILING_ENABLED=true` | `profiler.Start()` | `DD_PROFILING_ENABLED=true` | n/a |
| LLM Obs | — | — | `ddtrace.llmobs` (`ai-support-service` only) | — |
| Test Optimization | `datadog-ci junit upload` (see § 13) | `gotestsum` + `datadog-ci` | `pytest --ddtrace` | `datadog-ci junit upload` |

### 5.1 Trace context propagation

Set on **every** service, no exceptions:

```
DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext
```

This keeps W3C `traceparent` alongside `x-datadog-*`, which is what lets browser RUM, Node, Go, Python, and Kafka headers all agree. Getting this wrong is the #1 cause of broken traces — if a trace looks truncated, check this first.

For Kafka, context travels in the message headers when Data Streams Monitoring is enabled:

```
DD_DATA_STREAMS_ENABLED=true
```

`dd-trace` (Node, via kafkajs) and `dd-trace-go` inject and extract it automatically. **Python does not.** `ddtrace` 2.14 instruments `confluent_kafka` and nothing else, and Voyager's Python services use `aiokafka`, so their messages left with no headers at all — which broke two things quietly: every trace stopped dead at the publish, so a booking and the email it caused looked like unrelated requests, and Data Streams had no pathway to follow, so the topology it exists to draw came out empty.

The three Python services therefore inject and extract by hand, in `app/kafka_context.py`, using the public `set_produce_checkpoint` / `set_consume_checkpoint` API together with `HTTPPropagator`. That produces exactly the header set kafkajs produces — `x-datadog-*`, `traceparent`, `tracestate` and `dd-pathway-ctx-base64` — so the pipeline is continuous rather than continuous-except-for-Python. Moving those services to `confluent_kafka` would get it for free, but rewriting the messaging layer of three services to buy instrumentation is a poor trade, and the checkpoint API exists precisely so unsupported clients do not have to.

A consumer must activate the extracted context **before** handling the message; doing it afterwards parents the handler's spans to nothing, which looks identical to no propagation at all.

### 5.2 Entry-point span names

Each tracer names the span it opens for an inbound HTTP request after the
framework it instruments, not after the service. Voyager has three runtimes, so
it has three entry-point span names, and every service inside a runtime shares one:

| Runtime | Entry-point span | Services |
|---|---|---|
| Node — Fastify | `fastify.request` | `api-gateway`, `loyalty-service`, all four mocks |
| Go — chi via `net/http` | `http.request` | `search-service`, `pricing-service` |
| Python — FastAPI | `fastapi.request` | `booking-service`, `payment-service`, `notification-worker`, `ai-support-service` |

This matters far more than it looks. Datadog derives trace metrics by namespacing
them under the entry-point span name — `trace.fastify.request.hits`,
`trace.fastapi.request.errors`, `p95:trace.http.request` — so every APM query in
`datadog/` has to name the right one for the service it is asking about. Name the
wrong one and the query is still valid and still returns nothing at all, which on
a dashboard is indistinguishable from a service that has stopped receiving
traffic. Phase 8 owns keeping this table true; Phase 12 reads it.

Custom spans are named explicitly in code and listed in `03-EXECUTION-ORDER.md`
Phase 8. They are not entry spans, so Datadog generates no trace metrics for
them — a dashboard breaking checkout down by stage has to query the `spans` data
source and divide `@duration` by 1,000,000 to get milliseconds.

### 5.3 Tags on Datadog objects

Monitors, SLOs and synthetic tests created from `datadog/` carry a fixed tag set.
These tag the *configuration objects*, not the telemetry, and are separate from
the span and metric tags of § 5.1 and `05-FUNCTIONALITY.md § 14`:

| Tag | Values | Purpose |
|---|---|---|
| `project` | `voyager` | Distinguishes Voyager's objects from anything else in a shared org |
| `team` | `demo` | Placeholder owner; there is no real on-call rotation |
| `env` | `demo` | Matches `DD_ENV` |
| `managed_by` | `voyager-datadog-config` | Marks the object as owned by a committed file, so nobody edits it in the UI and loses the change on the next apply |
| `voyager_id` | the filename stem, e.g. `apm-latency-search-p95` | The idempotency key `datadog/apply.sh` matches on; one file, one object, forever |
| `service` | a `DD_SERVICE` value | Which service the object is about |
| `signal` | `latency`, `errors`, `throughput`, `database`, `queue`, `logs`, `integration`, `composite`, `slo` | What kind of signal it watches, so a monitor list can be filtered by question rather than by service |
| `slo` | an SLO filename stem | Present on burn-rate alerts, naming the SLO whose budget they watch |
| `composite_leg` | a composite monitor's filename stem | Marks a monitor that exists to feed a composite and is not meant to page on its own |
| `scenario` | `S1`–`S10` | Present where a monitor is the intended alert for one of the chaos scenarios in `01-PRD.md § 8` |

Dashboards and notebooks are absent from this table because neither API accepts
tags, which is why `apply.sh` has to match those two on title instead.

---

## 6. Datadog Agent configuration

Runs as a container with host access. Key settings in `infra/datadog/datadog.yaml` + Compose environment:

```yaml
# Core
DD_API_KEY:                      ${DD_API_KEY}
DD_SITE:                         ${DD_SITE}            # datadoghq.com | datadoghq.eu | us5, etc.
DD_ENV:                          demo
DD_HOSTNAME:                     voyager-demo-1
DD_TAGS:                         "project:voyager team:demo owner:${OWNER}"

# APM
DD_APM_ENABLED:                  true
DD_APM_NON_LOCAL_TRAFFIC:        true                  # required: traces arrive from other containers
DD_APM_RECEIVER_PORT:            8126

# DogStatsD
DD_USE_DOGSTATSD:                true
DD_DOGSTATSD_NON_LOCAL_TRAFFIC:  true
DD_DOGSTATSD_PORT:               8125

# Logs
DD_LOGS_ENABLED:                 true
DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL: true
DD_CONTAINER_EXCLUDE:            "name:datadog-agent"

# Processes & containers
DD_PROCESS_AGENT_ENABLED:        true
DD_PROCESS_CONFIG_PROCESS_COLLECTION_ENABLED: true

# DBM
DD_DATABASE_MONITORING_ENABLED:  true

# Optional (kernel-dependent; leave off if the AMI fights you)
DD_SYSTEM_PROBE_NETWORK_ENABLED: false
```

Required volume mounts:
```
/var/run/docker.sock:/var/run/docker.sock:ro
/proc/:/host/proc/:ro
/sys/fs/cgroup/:/host/sys/fs/cgroup:ro
/var/lib/docker/containers:/var/lib/docker/containers:ro
```

### 6.1 Integration autodiscovery

Configure via Docker labels on the target containers, not static files — it's cleaner and it's what customers do.

```yaml
postgres:
  labels:
    com.datadoghq.ad.checks: |
      {"postgres":{"init_config":{},"instances":[{
        "host":"%%host%%","port":5432,
        "username":"datadog","password":"${DD_PG_PASSWORD}","dbname":"voyager",
        "dbm":true,
        "reported_hostname":"voyager-postgres",
        "collect_schemas":{"enabled":true},
        "query_samples":{"enabled":true},
        "query_metrics":{"enabled":true},
        "query_activity":{"enabled":true},
        "collect_settings":{"enabled":true},
        "relations":[{"relation_regex":".*"}],
        "tags":["project:voyager","service:voyager-postgres"]
      }]}}
redis:
  labels:
    com.datadoghq.ad.checks: |
      {"redisdb":{"init_config":{},"instances":[{"host":"%%host%%","port":"6379"}]}}
kafka:
  labels:
    com.datadoghq.ad.checks: |
      {"kafka":{"init_config":{},"instances":[{"host":"%%host%%","port":9999}]}}
```

Kafka also needs `KAFKA_JMX_OPTS` exposing JMX on 9999 for the `kafka` check, plus the `kafka_consumer` check for lag. Data Streams Monitoring covers lag from the client side too — run both; they answer different questions.

`reported_hostname` is not decoration. Without it the Agent identifies the database by the container's bridge IP, which changes every time the container is recreated, and Database Monitoring then treats each recreation as a new host — splitting the query history that makes a regression visible in the first place.

**The labels only do anything if the Agent is listening for them.** `infra/datadog/datadog.yaml` must declare the container listener and its config provider:

```yaml
listeners:
  - name: container
config_providers:
  - name: container
    polling: true
```

The Agent image's entrypoint writes both of these into the `datadog.yaml` it generates at startup — and Voyager bind-mounts its own file over that one, which silently discards them. The resulting failure is close to invisible: the Agent starts healthy, every core check runs, and the only symptom is that `postgres`, `redisdb` and `kafka` never appear in `agent status`, which is indistinguishable from three integrations nobody has configured yet. Confirm with `agent configcheck`, not by reading this file.

### 6.2 Postgres setup for DBM

`infra/postgres/init/03-datadog.sql` creates the monitoring role, the extension and the explain function. (It is `03-`, not `02-`: `02-readonly-role.sql` already holds that slot, and the files run in name order.)

Everything in `/docker-entrypoint-initdb.d` runs **once**, when the data volume is first initialised, so a stack that is upgraded rather than rebuilt never sees this file. `make dbm-setup` applies it to a running database instead; the file is written to be safe to run twice, and re-running it with a rotated `DD_PG_PASSWORD` is the supported way to change that password.

`make verify-dbm` (`scripts/verify-dbm.sh`) asserts all of this end to end — the settings, the role's grants, the explain function, the Agent's four DBM collection pipelines, and each of the four database chaos flags. It drops the bookings index to prove the plan flip, so it restores it from an exit trap and pauses the load generators while it measures.

The essentials:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE USER datadog WITH PASSWORD :'dd_password';
GRANT pg_monitor TO datadog;
GRANT SELECT ON pg_stat_database TO datadog;
CREATE SCHEMA IF NOT EXISTS datadog;
GRANT USAGE ON SCHEMA datadog TO datadog;
CREATE OR REPLACE FUNCTION datadog.explain_statement(l_query text, out explain json)
RETURNS SETOF json AS $$
DECLARE curs REFCURSOR; plan json;
BEGIN
  OPEN curs FOR EXECUTE pg_catalog.concat('EXPLAIN (FORMAT JSON) ', l_query);
  FETCH curs INTO plan; CLOSE curs; RETURN QUERY SELECT plan;
END; $$ LANGUAGE plpgsql RETURNS NULL ON NULL INPUT SECURITY DEFINER;
```

Two grants that look optional and are not. `GRANT USAGE ON SCHEMA voyager TO datadog` is what `relations` and `collect_schemas` need to walk the application schema — `SELECT` on the tables is not required, because the statistics live in the catalog. And `pg_monitor` is what lets the role read other sessions' query text: without it `pg_stat_statements` returns only the check's own rows, which is a populated-looking view that says nothing about the application.

The explain function deliberately does not pin its own `search_path`. The statements the Agent samples name tables unqualified, exactly as the application wrote them, and they resolve through the database-level `search_path` set in `01-schema-owner.sql`. Locking it down here would make every sampled statement fail to plan.

And `postgresql.conf`:
```
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
pg_stat_statements.max = 10000
track_activity_query_size = 4096
track_io_timing = on
```

---

## 7. Environment variables

### 7.1 Root `.env` (created from `.env.example`, never committed)

```bash
# ---- Datadog ----
DD_API_KEY=
DD_APP_KEY=                      # needed only for datadog-ci / dashboard-as-code
DD_SITE=datadoghq.com
DD_ENV=demo
DD_VERSION=                      # set by deploy script from git SHA
DD_GIT_REPOSITORY_URL=github.com/<org>/voyager
DD_GIT_COMMIT_SHA=               # set by deploy script
OWNER=rohit

# ---- Sampling / cost controls ----
DD_TRACE_SAMPLE_RATE=1.0
DD_TRACE_SAMPLING_RULES=                 # see § 8; empty in demo-mode, populated in idle-mode
DD_PROFILING_ENABLED=true
DD_LOGS_INJECTION=true
DD_DATA_STREAMS_ENABLED=true
RUM_SESSION_SAMPLE_RATE=100
RUM_SESSION_REPLAY_SAMPLE_RATE=100

# ---- RUM ----
VITE_DD_RUM_APPLICATION_ID=
VITE_DD_RUM_CLIENT_TOKEN=
VITE_DD_SITE=datadoghq.com
VITE_DD_ENV=demo
VITE_API_BASE_URL=https://<your-domain-or-ec2-ip>/api

# ---- Data layer ----
POSTGRES_USER=voyager
POSTGRES_PASSWORD=
POSTGRES_DB=voyager
DD_PG_PASSWORD=                  # for the datadog monitoring role
MOCK_DB_PASSWORD=                # for voyager_readonly, the role mock-gds uses
REDIS_URL=redis://redis:6379
KAFKA_BROKERS=kafka:9092

# ---- App ----
JWT_SECRET=
ADMIN_SECRET=                    # gates the chaos panel
PUBLIC_HOSTNAME=                 # used by Caddy for TLS
VOYAGER_DEV_BIND_ADDR=           # EMPTY on a deployed host; 127.0.0.1 on a workstation. See below.
SEED_RANDOM_SEED=20260101        # deterministic seeding

# ---- LLM ----
LLM_PROVIDER=mock                # mock | openai
LLM_BASE_URL=http://mock-llm:4930/v1
LLM_API_KEY=mock-key
LLM_MODEL=voyager-support-v1
DD_LLMOBS_ML_APP=voyager-support # the ml_app LLM Observability groups the chains under
DD_LLMOBS_ENABLED=               # leave empty; see § 7.3. Set to false to turn LLM Obs off
LLM_COST_INPUT_USD_PER_MILLION=0.50    # tariff behind the cost annotated on each llm span
LLM_COST_OUTPUT_USD_PER_MILLION=1.50   # the same two constants the D6 cost widget uses

# ---- Load generation ----
LOADGEN_API_ENABLED=true
LOADGEN_API_VUS=15
LOADGEN_BROWSER_ENABLED=true
LOADGEN_BROWSER_CONCURRENCY=2
GATEWAY_BASE_URL=http://api-gateway:4000   # where loadgen-api sends traffic; it never calls a service directly
WEB_BASE_URL=http://web-ui:8080            # origin loadgen-browser opens, so RUM records the same one a person would
```

`RUM_SESSION_SAMPLE_RATE` and `RUM_SESSION_REPLAY_SAMPLE_RATE` carry no `VITE_` prefix because they describe the RUM application as a whole, but the browser is the only thing that reads them. `apps/web-ui/Dockerfile` therefore takes them as build args and re-exports them as `VITE_RUM_SESSION_SAMPLE_RATE` and `VITE_RUM_SESSION_REPLAY_SAMPLE_RATE`, exactly as it already derives `VITE_DD_ENV` from `DD_ENV`. Both renamed pairs exist so a value has one source in `.env` rather than two that can disagree — and, like every `VITE_*` value, they are baked into the bundle at build time, so changing one means rebuilding `web-ui` rather than restarting it.

**`VOYAGER_DEV_BIND_ADDR`** is the host address `docker-compose.dev.yml` publishes its ports on, and it is also the switch that decides whether that overlay may be applied at all. Every `ports` entry in the overlay interpolates it with `:?`, so an empty value makes Compose refuse the whole command with a message pointing at that file's header. Three things then follow from one value:

- **A deployed host cannot apply the overlay.** `.env.example` ships the value empty and `infra/ec2/userdata.sh` copies that file verbatim, so the overlay refuses on the server. `infra/ec2/deploy.sh` additionally aborts if the value has been filled in, because the way that happens is someone running `make bootstrap` there to fix something unrelated.
- **A workstation always gets both files.** `make bootstrap` — which is where someone asserts they are on a workstation — writes `127.0.0.1`, and the `Makefile` adds `-f docker-compose.dev.yml` whenever the value is non-empty. So `make up` on a laptop publishes the internal ports the `scripts/verify-*.sh` suite needs, and the same target on a server does not.
- **The bind address cannot be widened by editing the compose file.** `0.0.0.0` is one character away from `127.0.0.1` in a file nobody reviews.

`scripts/verify-edge.sh` asserts all of it: that the production render publishes only the edge, that the overlay refuses with the value empty, and that with it set every published port is still on loopback.

`GATEWAY_BASE_URL` and `WEB_BASE_URL` follow the existing `<SERVICE>_BASE_URL` convention and exist because the two generators are the only containers that address the front door rather than a downstream service. On a deployed host `WEB_BASE_URL` should be the public HTTPS origin, since RUM and Session Replay behave differently over plain HTTP and a generator on the wrong scheme produces sessions that do not match the ones people create.

### 7.2 Per-service Datadog variables

Every first-party service container gets, at minimum:

```bash
DD_AGENT_HOST=datadog-agent
DD_TRACE_AGENT_PORT=8126
DD_DOGSTATSD_HOST=datadog-agent
DD_DOGSTATSD_PORT=8125
DD_SERVICE=<from table in § 1>
DD_ENV=${DD_ENV}
DD_VERSION=${DD_VERSION}
DD_TRACE_ENABLED=true
DD_TRACE_SAMPLE_RATE=${DD_TRACE_SAMPLE_RATE}
DD_LOGS_INJECTION=true
DD_RUNTIME_METRICS_ENABLED=true
DD_PROFILING_ENABLED=${DD_PROFILING_ENABLED}
DD_DATA_STREAMS_ENABLED=true
DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext
DD_GIT_REPOSITORY_URL=${DD_GIT_REPOSITORY_URL}
DD_GIT_COMMIT_SHA=${DD_GIT_COMMIT_SHA}
```

Put these in a Compose YAML anchor (`x-datadog-env: &datadog-env`) and merge into every service. Do not copy-paste them a dozen times.

### 7.3 LLM Observability variables — `ai-support-service` only

These four sit on `ai-support-service` in Compose and nowhere else. Two of them
are counter-intuitive enough to be worth stating here rather than only in a
comment, because both failure modes are silent.

| Variable | Value | Why |
|---|---|---|
| `DD_LLMOBS_ML_APP` | `voyager-support` | The application the chains are grouped under. `LLMObs.enable()` refuses to start without it, and the service passes it explicitly so a missing variable cannot raise at import. |
| `DD_LLMOBS_ENABLED` | **empty** | *Not* `true`. A truthy value makes `ddtrace/bootstrap/preload.py` call `LLMObs.enable()` before the application is imported, with integrations on — which patches `openai` explicitly and bypasses `DD_TRACE_OPENAI_ENABLED` below. The service's own `LLMObs.enable()` then returns early because the product is already enabled, and every completion is counted twice. Set it to `false` to switch LLM Observability off; leave it empty to have it on. |
| `DD_TRACE_OPENAI_ENABLED` | `false` | With LLM Observability on, ddtrace's `openai` integration emits an `llm` span of its own for every completion, on top of the `chat.completion` span the service opens. Two spans per call means double the tokens and double the cost in the product. The hop to `mock-llm` is still traced, by the `httpx` integration underneath the client. |
| `LLM_COST_{INPUT,OUTPUT}_USD_PER_MILLION` | `0.50` / `1.50` | The tariff the `total_cost` annotation on an `llm` span is computed from. Datadog derives no cost for a model it has never heard of, and `voyager-support-v1` is invented. The defaults are the same constants the "Estimated cost per hour" widget in `datadog/dashboards/d6-ai-support.json` applies to `voyager.support.tokens`, so the dashboard and the span agree on the price of a token. |

---

## 8. Ingestion and cost controls

100% sampling on a continuously-loaded demo app will produce real spend. Document and expose these knobs:

| Knob | Default | Notes |
|---|---|---|
| `DD_TRACE_SAMPLE_RATE` | `1.0` | Drop to `0.2` when idle; keep at `1.0` during demos |
| `DD_TRACE_SAMPLING_RULES` | **health probes only in demo-mode** | Both modes exclude `/health` and `/ready`; idle-mode adds the rest. |
| `RUM_SESSION_REPLAY_SAMPLE_RATE` | `100` | The most expensive single setting. Drop to `20` for always-on. |
| `LOADGEN_API_VUS` | `15` | Directly proportional to span volume |
| `DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL` | `true` | Exclude the loadgen containers to cut noise |

**Idle-mode sampling rules** (applied by `make idle-mode`):

```json
[
  {"service":"*","resource":"GET /health","sample_rate":0.0},
  {"service":"*","resource":"GET /ready","sample_rate":0.0},
  {"service":"voyager-booking","sample_rate":1.0},
  {"service":"voyager-payment","sample_rate":1.0},
  {"service":"*","sample_rate":0.2}
]
```

**Demo-mode sampling rules** (applied by `make demo-mode`) — the first two of the above and nothing else:

```json
[
  {"service":"*","resource":"GET /health","sample_rate":0.0},
  {"service":"*","resource":"GET /ready","sample_rate":0.0}
]
```

Rules are evaluated in order, first match wins. The `*` service glob covers the mocks too. Anything that matches no rule falls through to `DD_TRACE_SAMPLE_RATE`, which demo-mode sets to `1.0` — so demo-mode is 100% of everything except the probes.

This section previously said demo-mode leaves the variable empty. That contradicted `05-FUNCTIONALITY.md § 16`, which excludes `/health` and `/ready` from trace sampling unconditionally, and it put roughly twenty probes a minute per service back into APM during the one mode where someone is looking at APM. The health exclusions now belong to both modes; the difference between them is the last three rules and the replay rate.

Both modes are applied by rewriting `.env` and recreating the application containers, because each tracer reads `DD_TRACE_SAMPLE_RATE` and `DD_TRACE_SAMPLING_RULES` once, at process start. That takes about half a minute, which is why this is a mode you set before a demo rather than a dial you turn during one. Load-generator intensity is the exception — the generators poll `voyager:loadgen`, so that part takes effect in seconds.

---

## 9. Infrastructure — EC2 target

| Item | Spec | Notes |
|---|---|---|
| Instance type | **`m5.xlarge`** (4 vCPU, 16 GB) minimum | **Avoid burstable instances (`t3`, `t4g`)** — CPU credit throttling distorts latency and profiler demos in ways that are confusing to debug and embarrassing to hit live |
| AMI | Ubuntu 22.04 LTS or Amazon Linux 2023 | Ubuntu 22.04 is the better-tested path for the Agent's system-probe if you later enable NPM |
| Storage | 100 GB gp3, 3000 IOPS | Postgres with 400k bookings + Kafka retention + container images |
| Security group inbound | 22 (your IP only), 80, 443 (0.0.0.0/0 or your corp range) | **Never** expose 4000–4930, 5432, 6379, 8080, 8125, 8126, 9092, 9999, 5002 — only Caddy on 80/443 should be reachable |
| Security group outbound | 443 to `*.datadoghq.com` (or your site), 443 general for image pulls | |
| IAM instance profile | Optional: CloudWatch read for the AWS integration, S3 write if you enable log archives | |
| Elastic IP | Recommended | RUM app config and synthetic tests reference the hostname |
| DNS + TLS | A record → Elastic IP; Caddy gets a Let's Encrypt cert automatically | HTTPS matters for RUM / Session Replay fidelity |

### 9.1 Memory budget (16 GB host)

| Component | Limit |
|---|---|
| `postgres` | 3 GB (`shared_buffers=1GB`, `work_mem=16MB`) |
| `kafka` | 2 GB (`KAFKA_HEAP_OPTS=-Xmx1g -Xms1g`) |
| `redis` | 512 MB (`maxmemory 400mb`, **`maxmemory-policy volatile-lru`**) |
| `datadog-agent` | 1 GB |
| 8 backend services | 512 MB each = 4 GB |
| 4 mocks | 256 MB each = 1 GB |
| `loadgen-browser` (Chromium) | 1.5 GB |
| `loadgen-api` | 256 MB |
| `edge` + `web-ui` | 256 MB combined |
| **Subtotal** | **~13.5 GB** |
| Headroom | ~2.5 GB |

**Redis eviction policy matters.** `volatile-lru` evicts only keys that have a TTL, which means the search-result cache (TTL 120 s) is evictable but the `voyager:chaos` hash (no TTL) never is. With `allkeys-lru`, memory pressure could silently evict your chaos state mid-demo.

Set `mem_limit` on every service in Compose. An OOM-killed Postgres mid-demo is not a chaos scenario you want.

### 9.2 Bootstrap

`infra/ec2/userdata.sh` installs Docker Engine + Compose plugin, `make`, `git`, sets up log rotation for container logs, clones the repo, and leaves the operator to fill in `.env`. Full steps in `README.md § 6`; the runbook with the reasoning is `docs/runbooks/04-ec2-deploy.md`.

Set `VOYAGER_REPO_URL` at the top of the script before launching — it is the only value without a usable default. `VOYAGER_DIR` (default `/opt/voyager`) and `VOYAGER_USER` (default `ubuntu`) are the other two knobs. These are variables of that script, not of `.env`.

Two things the script does deliberately *not* do:

- **It does not build or start anything.** The stack cannot come up before `.env` has a Datadog API key, and a user-data script that dies halfway through a twelve-minute build leaves an instance whose state nobody can describe from the console log.
- **It does not run `make bootstrap`.** It copies `.env.example` verbatim instead. Bootstrap's one extra act is setting `VOYAGER_DEV_BIND_ADDR`, which is exactly what must stay empty on a deployed host (§ 7.1).

Container logging must stay on the `json-file` driver with a size cap, and the script sets both. The Agent collects container logs by reading the files that driver writes — the `/var/lib/docker/containers` mount in `docker-compose.yml` — so switching to `journald` or `local` makes log collection return nothing at all, with no error. Uncapped, the same files fill the 100 GB volume within a few weeks of continuous load generation, and Postgres is the process that notices first.

---

## 10. Repository layout

```
voyager/
├── README.md                     ← start here
├── Project Requirements/
│   ├── 01-PRD.md
│   ├── 02-TECH-STACK.md
│   ├── 03-EXECUTION-ORDER.md
│   ├── 04-STYLING.md
│   ├── 05-FUNCTIONALITY.md
│   └── 06-USER-FLOWS.md
├── Makefile
├── docker-compose.yml            ← base: app + data + agent
├── docker-compose.loadgen.yml    ← overlay: load generators
├── docker-compose.dev.yml        ← overlay: hot reload, exposed ports
├── .env.example
│
├── apps/
│   └── web-ui/
│       ├── src/
│       │   ├── datadog/rum.ts            ← ALL RUM setup lives here
│       │   ├── api/                      ← typed client, react-query hooks
│       │   ├── features/{search,checkout,manage,support,admin,auth}/
│       │   ├── components/ui/            ← design system primitives
│       │   └── styles/
│       ├── Dockerfile
│       └── nginx.conf
│
├── services/
│   ├── api-gateway/
│   │   └── src/{tracer.ts,index.ts,routes/,clients/,chaos.ts,logger.ts,metrics.ts}
│   ├── search-service/
│   │   └── internal/{trace,handlers,gds,cache,store,chaos,metrics}
│   ├── pricing-service/
│   ├── booking-service/
│   │   └── app/{main.py,tracing.py,routers/,domain/,repo/,kafka/,chaos.py,logging.py,metrics.py}
│   ├── payment-service/
│   ├── loyalty-service/
│   ├── notification-worker/
│   └── ai-support-service/
│
├── mocks/{mock-gds,mock-payments,mock-email,mock-llm}/
│
├── packages/
│   └── shared-schemas/           ← zod schemas shared by web-ui + api-gateway
│
├── infra/
│   ├── datadog/{datadog.yaml,conf.d/}
│   ├── postgres/{postgresql.conf,init/}
│   ├── redis/redis.conf
│   ├── kafka/
│   ├── edge/Caddyfile
│   └── ec2/{userdata.sh,deploy.sh}
│
├── datadog/                      ← observability as code
│   ├── dashboards/*.json
│   ├── monitors/*.json
│   ├── slos/*.json
│   ├── synthetics/*.json
│   ├── notebooks/*.json
│   └── apply.sh
│
├── tools/
│   ├── seeder/
│   ├── loadgen-api/              ← k6 scripts
│   ├── loadgen-browser/          ← Playwright journeys
│   └── scenarios/                ← composite chaos scenario definitions
│
└── .github/workflows/ci.yml
```

---

## 11. Makefile targets (the operator interface)

Cursor must create all of these. They are the documented UX of the project.

```make
make bootstrap        # install host deps, copy .env.example, print next steps
make build            # build all images
make up               # start app + data + agent (no load generators)
make up-full          # up + load generators
make down             # stop everything, keep volumes
make nuke             # stop + delete volumes (destructive)
make seed             # run the seeder job
make reset            # nuke + up + migrate + seed + chaos-reset  (the "make it clean" button)
make logs s=booking   # tail one service
make up-one s=pricing # rebuild + restart one service
make migrate          # run alembic migrations
make healthcheck      # assert every service healthy AND all chaos flags off
make chaos-reset      # clear all chaos flags
make scenario s=S4    # apply a composite scenario by ID
make dd-apply         # push dashboards/monitors/SLOs/synthetics via datadog-ci
make dd-sourcemaps    # upload web-ui sourcemaps
make demo-mode        # sampling 100%, loadgen 2x
make idle-mode        # sampling 20%, loadgen 1x, replay 20%
make test             # run all four test suites locally
make deploy           # git pull, set DD_VERSION + DD_GIT_COMMIT_SHA from SHA, build,
                      # rolling restart, migrate, dd-sourcemaps, healthcheck
```

Added since, and documented here because the runbooks call them:

```make
make test-web         # one suite: vitest in apps/web-ui
make test-node        # one suite: vitest + typecheck in the Node services
make test-python      # one suite: pytest in the four Python services
make test-go          # one suite: go vet + go test in the two Go services
make dbm-setup        # create the datadog role, grants and explain function (§ 6.2)
make verify           # every exit-criteria script except verify-tracing
make verify-edge      # phase 13: the edge proxy and the port posture
make verify-tracing   # phase 8: stops and restarts six services; minutes
make verify-dbm       # phase 10: DBM and the four database chaos paths
```

`make test` is the four `test-*` targets in order; CI's matrix calls them individually so a failure names the runtime. `verify-tracing` is out of `verify` because it stops and restarts six services, which is too invasive for a routine check; `verify-dbm` is out for the same reason, since it drops an index on a live database and pauses the load generators to measure without them. Both restore what they touched from an exit trap rather than at the end, so an interrupted run does not leave the stack damaged.

Every target resolves its Compose file set from `VOYAGER_DEV_BIND_ADDR` (§ 7.1): both files on a workstation, the base file alone on a deployed host. `down`, `nuke` and `ps` additionally name `docker-compose.loadgen.yml`, so the generators are not orphans of the project — without it `ps` omits them, and "is the load generator running", the first question an empty dashboard raises, cannot be answered with the operator interface.

---

## 12. Pinning and reproducibility rules

1. **Pin every image to a minor version**, never `:latest` — except `datadog/agent:7`, where tracking 7 is intentional.
2. **Commit all lockfiles**: `package-lock.json`, `go.sum`, `requirements.txt` (generated by `pip-compile`, not hand-written).
3. **One Dockerfile per service**, multi-stage, non-root runtime user.
4. **No service reads another service's database.** All cross-service access is HTTP or Kafka. This is what makes the service map honest.
5. **`DD_SERVICE` is set once, in Compose**, never hardcoded in application code.
6. **Health endpoints are uniform**: `GET /health` (liveness, no dependencies) and `GET /ready` (checks DB/Redis/Kafka). Compose healthchecks use `/health`; the gateway's aggregate status page uses `/ready`.

---

## 13. Continuous integration

`.github/workflows/ci.yml`. Four test jobs as a matrix, a Docker build validation, a sourcemap upload on `main`, and a job that tags the pipeline trace.

### 13.1 The four suites

Every suite runs through `scripts/run-tests.sh`, which is the same script `make test` calls, in the same container images. One script rather than a Makefile recipe plus a workflow step, because a suite that runs differently in CI than on a laptop is a suite that fails only in CI — the least useful place for a test to fail.

| Suite | Target | What runs | Where |
|---|---|---|---|
| `web` | `make test-web` | `vitest run` | `apps/web-ui` |
| `node` | `make test-node` | `vitest run`, then `tsc --noEmit` | `services/loyalty-service`; typecheck in `services/api-gateway` and all four mocks |
| `python` | `make test-python` | `pytest` (`--ddtrace` when a key is present) | `booking-service`, `payment-service`, `notification-worker`, `ai-support-service` |
| `go` | `make test-go` | `go vet`, then `gotestsum` | `search-service`, `pricing-service` |

`loyalty-service` is the only Node service with a test suite; the gateway and the mocks are typechecked instead, which is the strongest claim available about code that has no tests and is not nothing — the zod schemas in `packages/shared-schemas` are shared with `web-ui`, so a contract change only one side followed fails there.

Dependencies install into named Docker volumes, never into the bind-mounted working tree. The tree holds the host's `node_modules`, built for a different architecture than the Linux containers, and overwriting them breaks the host's editor tooling for reasons nobody would connect to having run the tests.

### 13.2 Reporting

JUnit XML from all four suites, uploaded with `datadog-ci junit upload` under service `voyager-ci` and tagged `suite:<name>`. § 5 lists `dd-trace/ci` for vitest; both vitest suites report through JUnit instead, because the SDK route needs `dd-trace` in `web-ui`'s dependency tree — and therefore in the browser bundle's lockfile — for a benefit that the JUnit path already provides. `pytest` keeps `--ddtrace`, which costs nothing there because `ddtrace` is already installed.

The upload step runs under `always()`: a red run whose results never reached Datadog is a red run nobody can triage there, and it is also the run whose flaky test would have been most interesting.

Two things CI cannot switch on for itself, and both are prerequisites rather than bugs:

- **Pipeline Visibility** needs Datadog's GitHub App installed on the repository. The `datadog-ci tag` job adds Voyager's tags to the pipeline trace that integration creates and does nothing without it.
- **Flaky Test Management** has to be enabled for the repository before the flaky test is labelled rather than merely passing after a retry.

### 13.3 The flaky test

`services/loyalty-service/tests/flaky.test.ts`, one test, commented as deliberate at the top of the file. It is a wall-clock assertion with two milliseconds of headroom over the timer it measures, and it carries `retry: 3` so the pipeline stays green.

A coin flip would have been easier to tune and would have been a fake flake: it fails at the same rate on an idle runner as on a loaded one. This one fails more often exactly when CI is busy, which is what makes real flakes hard to reproduce and tempting to re-run and ignore.

### 13.4 Build validation

`docker compose -f docker-compose.yml build` for every image, on a runner with none of the layer cache a demo host accumulates, with `DD_GIT_COMMIT_SHA` and `DD_GIT_REPOSITORY_URL` set the way `infra/ec2/deploy.sh` sets them. The job then **reads the commit stamp back out of the built images** and fails if any of the twelve disagrees, which is the same assertion `deploy.sh` and `make healthcheck` make: those two values are baked in at build time, and if they are wrong there is no error anywhere — Error Tracking simply produces stack-frame links that resolve to nothing.

The job also runs `scripts/verify-edge.sh --config-only` before building, which asserts offline that the production Compose configuration publishes only the edge's 80 and 443. It is the cheapest check in the workflow and the one most likely to catch a change that would otherwise only be noticed by someone scanning the demo host.

Both the build job and the sourcemap job write a throwaway `.env` from `.env.example` first: `docker-compose.yml` fails closed on the secrets it needs (`${POSTGRES_PASSWORD:?…}` and friends), which is correct and also means `config` and `build` need a file to interpolate from. `VOYAGER_DEV_BIND_ADDR` is left empty there, so the dev overlay is as refused in CI as it is on a deployed host.
