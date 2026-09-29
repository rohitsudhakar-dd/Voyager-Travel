# 02 — Tech Stack

Canonical reference for every technology choice, version, port, service name, and environment variable in Voyager. **When any other document and this one disagree, this one wins.**

---

## 1. Service inventory

All services run as containers on one EC2 host, on a user-defined bridge network named `voyager`. Only the edge proxy binds to host ports.

| Container | Language / Runtime | Framework | Internal port | `DD_SERVICE` | Repo path |
|---|---|---|---|---|---|
| `edge` | — | Caddy 2.8 | 80 / 443 | `voyager-edge` | `infra/edge/` |
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
| Test Optimization | `dd-trace/ci` with vitest | `gotestsum` + `datadog-ci` | `pytest --ddtrace` | `datadog-ci junit upload` |

### 5.1 Trace context propagation

Set on **every** service, no exceptions:

```
DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext
```

This keeps W3C `traceparent` alongside `x-datadog-*`, which is what lets browser RUM, Node, Go, Python, and Kafka headers all agree. Getting this wrong is the #1 cause of broken traces — if a trace looks truncated, check this first.

For Kafka, `dd-trace` (Node), `dd-trace-go`, and `ddtrace` (Python) all inject context into message headers automatically when Data Streams Monitoring is enabled:

```
DD_DATA_STREAMS_ENABLED=true
```

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
        "collect_schemas":{"enabled":true},
        "relations":[{"relation_regex":".*"}]
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

### 6.2 Postgres setup for DBM

`infra/postgres/init/02-datadog.sql` must create the monitoring role and extension:

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
SEED_RANDOM_SEED=20260101        # deterministic seeding

# ---- LLM ----
LLM_PROVIDER=mock                # mock | openai
LLM_BASE_URL=http://mock-llm:4930/v1
LLM_API_KEY=mock-key
LLM_MODEL=voyager-support-v1

# ---- Load generation ----
LOADGEN_API_ENABLED=true
LOADGEN_API_VUS=15
LOADGEN_BROWSER_ENABLED=true
LOADGEN_BROWSER_CONCURRENCY=2
```

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

---

## 8. Ingestion and cost controls

100% sampling on a continuously-loaded demo app will produce real spend. Document and expose these knobs:

| Knob | Default | Notes |
|---|---|---|
| `DD_TRACE_SAMPLE_RATE` | `1.0` | Drop to `0.2` when idle; keep at `1.0` during demos |
| `DD_TRACE_SAMPLING_RULES` | **empty in demo-mode** | Set only by `make idle-mode`. In demo-mode it must be empty so everything is sampled at 100%. |
| `RUM_SESSION_REPLAY_SAMPLE_RATE` | `100` | The most expensive single setting. Drop to `20` for always-on. |
| `LOADGEN_API_VUS` | `15` | Directly proportional to span volume |
| `DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL` | `true` | Exclude the loadgen containers to cut noise |

**Idle-mode sampling rules** (applied by `make idle-mode`, cleared by `make demo-mode`):

```json
[
  {"service":"*","resource":"GET /health","sample_rate":0.0},
  {"service":"*","resource":"GET /ready","sample_rate":0.0},
  {"service":"voyager-booking","sample_rate":1.0},
  {"service":"voyager-payment","sample_rate":1.0},
  {"service":"*","sample_rate":0.2}
]
```

Rules are evaluated in order, first match wins. The `*` service glob covers the mocks too. `make demo-mode` sets `DD_TRACE_SAMPLING_RULES=""` and `DD_TRACE_SAMPLE_RATE=1.0`; `make idle-mode` applies the rules above and reduces loadgen intensity and replay sampling together.

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

`infra/ec2/userdata.sh` installs Docker Engine + Compose plugin, `make`, `git`, sets up log rotation for container logs, clones the repo, and leaves the operator to fill in `.env`. Full steps in `README.md § 6`.

---

## 10. Repository layout

```
voyager/
├── README.md                     ← start here
├── 01-PRD.md
├── 02-TECH-STACK.md
├── 03-EXECUTION-ORDER.md
├── 04-STYLING.md
├── 05-FUNCTIONALITY.md
├── 06-USER-FLOWS.md
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

---

## 12. Pinning and reproducibility rules

1. **Pin every image to a minor version**, never `:latest` — except `datadog/agent:7`, where tracking 7 is intentional.
2. **Commit all lockfiles**: `package-lock.json`, `go.sum`, `requirements.txt` (generated by `pip-compile`, not hand-written).
3. **One Dockerfile per service**, multi-stage, non-root runtime user.
4. **No service reads another service's database.** All cross-service access is HTTP or Kafka. This is what makes the service map honest.
5. **`DD_SERVICE` is set once, in Compose**, never hardcoded in application code.
6. **Health endpoints are uniform**: `GET /health` (liveness, no dependencies) and `GET /ready` (checks DB/Redis/Kafka). Compose healthchecks use `/health`; the gateway's aggregate status page uses `/ready`.
