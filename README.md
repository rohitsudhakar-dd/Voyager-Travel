# Voyager — a Datadog demo application

A production-shaped online travel agency built to demonstrate the full Datadog platform. Polyglot (React / Node / Go / Python), event-driven, deliberately breakable, and deployable to a single EC2 instance.

**What makes it different from most demo apps:** a single checkout produces one distributed trace with 40+ spans across four language runtimes, the database pathology is real database pathology, and every failure mode is a toggle in an admin console rather than something you hope happens.

---

## 1. For Cursor — how to use this repository

> **Read this section first. It tells you the order to consume these documents and the rules that apply throughout.**

### Document map

| Doc | What it is | When you need it |
|---|---|---|
| **README.md** (this file) | Orientation, quickstart, deployment, troubleshooting | First, then whenever you deploy |
| **Project Requirements/01-PRD.md** | Goals, scope, Datadog coverage matrix, chaos scenarios, success criteria | Read fully before writing anything. Don't code from it. |
| **Project Requirements/02-TECH-STACK.md** | Every version, port, service name, env var, repo path | **The canonical reference.** When docs disagree, this wins. |
| **Project Requirements/03-EXECUTION-ORDER.md** | The 14-phase build plan with exit criteria | **Your work queue.** Follow it strictly, in order. |
| **Project Requirements/04-STYLING.md** | Design tokens, components, accessibility, instrumentation markup hooks | Phase 7 and whenever you touch UI |
| **Project Requirements/05-FUNCTIONALITY.md** | API contracts, data model, state machines, chaos flags, log schema, error types, metrics | **The doc you'll open most.** Every name and contract lives here. |
| **Project Requirements/06-USER-FLOWS.md** | Screens, routes, RUM taxonomy, funnel, demo runbooks | Phases 7, 9, and 13 |

### Reading order for the first pass

1. This section.
2. `Project Requirements/01-PRD.md` — all of it. Understand the *why* before the *what*.
3. `Project Requirements/02-TECH-STACK.md` — all of it. Memorize the service/port table.
4. `Project Requirements/03-EXECUTION-ORDER.md` § Phase 0, then start Phase 0.
5. From then on: read each phase, read the sections of `Project Requirements/05-FUNCTIONALITY.md` it cites, build, verify against the exit criteria, commit.

### Rules that apply to every phase

1. **Follow the phase order.** Phases 0–7 build a working app with **zero Datadog code**. Phases 8–12 add observability. This is deliberate — instrumenting a broken app is slow and unverifiable. Resist the urge to add tracing early.
2. **Don't invent names.** Service names, ports, env vars, table names, topic names, span names, metric names, chaos flag names, and error types are all specified. If you need a name that isn't in the docs, add it to `02-TECH-STACK.md` or `05-FUNCTIONALITY.md` in the same commit.
3. **`02-TECH-STACK.md` is authoritative** on any conflict between documents.
4. **Don't finish a phase with failing exit criteria.** If you can't meet one, stop and report what's blocking. A partial phase costs more than a delay.
5. **Commit at every phase boundary** as `phase(N): <summary>`.
6. **Isolate instrumentation.** Per service: one tracer file, one logging file, one metrics file, one chaos file. A customer should be able to read those four and understand the whole integration.
7. **Never `sleep()` to fake slowness.** Chaos must inject *real* work — real regex compilation, real full table scans, real lock waits. The one documented exception is `db_slow_query_ms`, which emulates a genuinely expensive analytical query. Fake slowness produces flame graphs that prove nothing.
8. **Chaos must never break correctness.** A slow payment is still a correct payment. Only the two named LLM quality flags may produce wrong output.
9. **Add `data-testid` and `data-dd-action-name` as you write components**, not later. Retrofitting them is slow and you'll miss some.
10. **No secrets in the repo.** Everything through `.env`, which is gitignored. `.env.example` carries placeholders only.
11. **No real brands.** All airlines, hotels, and payment providers in Voyager are invented. Don't reproduce any real company's name, logo, or visual design.

### Working in Cursor effectively

- Keep `02-TECH-STACK.md` and `05-FUNCTIONALITY.md` open as context for every backend task.
- Keep `04-STYLING.md` and `06-USER-FLOWS.md` open for every frontend task.
- Work one service at a time. `make up-one s=<service>` rebuilds and restarts a single container in ~20 seconds, which is the tight loop you want.
- Don't refactor across services in one change. The strict service boundaries are what make the service map honest.

---

## 2. What Voyager is

An OTA where customers search and book flights and hotels:

- **Search** — parallel fan-out to four simulated GDS providers, Redis-cached, dynamically priced
- **Checkout** — time-limited inventory holds, multi-passenger details, ancillaries, payment authorization with idempotency, 3DS step-up
- **Async confirmation** — Kafka-driven, fanning out to loyalty accrual and email notification
- **Manage booking** — PNR lookup, cancellation, refund
- **AI support chat** — LLM with tool-calling against the real booking service
- **Ops console** — 35+ chaos flags and 10 one-click demo scenarios

### Architecture

```
                     ┌──────────────┐
  Browser ──HTTPS──► │ edge (Caddy) │
   (RUM)             └──────┬───────┘
                            ├──────────────► web-ui (React SPA, Nginx)
                            │
                            ▼
                     ┌──────────────┐
                     │ api-gateway  │  Node · auth, BFF, admin API
                     └──────┬───────┘
          ┌─────────────────┼──────────────────┬──────────────┐
          ▼                 ▼                  ▼              ▼
   search-service    booking-service    payment-service   ai-support-service
       (Go)              (Python)          (Python)           (Python)
          │                 │                  │                 │
          ├─► pricing (Go)  ├─► Postgres       ├─► Postgres      ├─► mock-llm
          ├─► mock-gds      ├─► Redis          ├─► mock-payments ├─► booking-service
          └─► Redis         └─► Kafka          └─► Kafka         └─► loyalty-service
                                  │                  │
                    ┌─────────────┴──────────────────┘
                    ▼                            ▼
              loyalty-service           notification-worker
                  (Node)                     (Python)
                    │                            └─► mock-email
                    └─► Kafka (loyalty.accruals)

  Datadog Agent (container) ◄── traces · logs · metrics · profiles
                                from every service above
```

**Thirteen instrumented services** — nine first-party (`voyager-web` via RUM, `-api-gateway`, `-search`, `-pricing`, `-booking`, `-payment`, `-loyalty`, `-notifications`, `-ai-support`) plus four mocked third parties — across **four runtimes** and **three data stores**. Around 21 containers in total once the agent, seeder, and load generators are counted.

### Datadog products demonstrated

APM · Distributed Tracing · Service Map · Error Tracking · Deployment Tracking · Source Code Integration · Continuous Profiler · Code Hotspots · RUM · Session Replay · Core Web Vitals · Log Management · Trace-Log Correlation · Infrastructure Monitoring · Container Monitoring · Database Monitoring · Data Streams Monitoring · LLM Observability · Synthetic Monitoring · Monitors · SLOs · Incident Management · Watchdog · CI Visibility · Test Optimization

Full mapping in `01-PRD.md § 6`.

---

## 3. Prerequisites

**Local development**
- Docker Engine 24+ with the Compose plugin
- Node 20.17 (use `.nvmrc`)
- Go 1.23
- Python 3.12
- `make`, `git`
- 16 GB RAM, 40 GB free disk

**Datadog**
- An API key, and an App key (for dashboards-as-code)
- A RUM application — note its application ID and client token
- Your Datadog site (`datadoghq.com`, `datadoghq.eu`, `us5.datadoghq.com`, …)

**EC2 deployment**
- An AWS account with EC2 permissions
- A key pair
- Optionally a domain name (recommended — HTTPS makes RUM and Session Replay behave properly)

---

## 4. Quickstart (local)

```bash
git clone <repo-url> voyager && cd voyager

make bootstrap              # installs tooling, copies .env.example → .env
$EDITOR .env                # fill in DD_API_KEY, RUM IDs, passwords, JWT_SECRET, ADMIN_SECRET

make build                  # ~8 minutes on first run
make up                     # starts data layer, services, and the Datadog Agent
make migrate
make seed                   # ~4 minutes — generates 400k bookings
make healthcheck            # everything green?

open https://localhost
```

The edge redirects plain HTTP to HTTPS. With `PUBLIC_HOSTNAME=localhost` the certificate comes from Caddy's own CA, so a browser will warn once; accept it, because RUM and Session Replay behave differently over plain HTTP and you want to see what a real user sees.

`make bootstrap` sets `VOYAGER_DEV_BIND_ADDR=127.0.0.1`, and every `make` target then includes `docker-compose.dev.yml` so the service ports are reachable from your terminal for the `scripts/verify-*.sh` suite. By hand that is always both files:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Then start continuous traffic so dashboards populate:

```bash
make up-full                # adds the k6 and Playwright load generators
```

And push the observability config:

```bash
make dd-apply               # dashboards, monitors, SLOs, synthetics
make dd-sourcemaps          # RUM sourcemaps
```

### Useful commands

```bash
make logs s=booking         # tail one service
make up-one s=pricing       # rebuild + restart one service
make test                   # all four test suites
make test-go                # or just one: test-web, test-node, test-python, test-go
make verify                 # every exit-criteria script against a running stack
make chaos-reset            # clear every chaos flag
make scenario s=S4          # apply a composite scenario
make demo-mode              # 100% sampling, 2x load
make idle-mode              # reduced sampling and load, to control cost
make reset                  # nuke → up → migrate → seed → chaos-reset  (~5 min)
make down                   # stop, keep data
make nuke                   # stop and delete volumes (destructive)
```

---

## 5. Configuration

Copy `.env.example` to `.env` and fill it in. The variables that actually need your attention:

| Variable | Notes |
|---|---|
| `DD_API_KEY` | Required. Nothing reaches Datadog without it. |
| `DD_APP_KEY` | Needed only for `make dd-apply`. |
| `DD_SITE` | Must match your org's site, or data goes nowhere silently. |
| `DD_ENV` | `demo`. Keep it consistent — it's the key correlation dimension. |
| `VITE_DD_RUM_APPLICATION_ID`, `VITE_DD_RUM_CLIENT_TOKEN` | From your RUM application. |
| `VITE_API_BASE_URL` | Must be the **public** URL the browser will call, not an internal hostname. |
| `PUBLIC_HOSTNAME` | Your domain. Caddy uses it for TLS. |
| `POSTGRES_PASSWORD`, `DD_PG_PASSWORD`, `JWT_SECRET`, `ADMIN_SECRET` | Generate real values: `openssl rand -hex 32` |
| `SEED_RANDOM_SEED` | Keep the default for reproducible demos. |
| `LLM_PROVIDER` | `mock` by default. Set `openai` plus `LLM_API_KEY` for a real model. |

Full list with comments in `02-TECH-STACK.md § 7.1`.

---

## 6. EC2 deployment

### 6.1 Launch the instance

| Setting | Value |
|---|---|
| Instance type | **`m5.xlarge`** (4 vCPU / 16 GB) |
| AMI | Ubuntu 22.04 LTS |
| Storage | 100 GB gp3 |
| Inbound | 22 from your IP only; 80 and 443 from your allowed range |
| Outbound | 443 (Datadog intake + image pulls) |
| Elastic IP | Yes — synthetics and RUM config reference the hostname |
| User data | `infra/ec2/userdata.sh` |

Avoid burstable instances (`t3`, `t4g`). CPU credit throttling distorts latency and profiler demos in ways that are confusing to debug and embarrassing to hit live.

**Never expose** ports 4000–4930, 5432, 6379, 8080, 8125, 8126, 9092, 9999, or 5002. Only Caddy on 80/443 should be reachable.

### 6.2 Bring it up

```bash
ssh -i <key>.pem ubuntu@<elastic-ip>
cd /opt/voyager

$EDITOR .env                # userdata.sh already created it from .env.example

make build                  # ~12 minutes on m5.xlarge
make up
make migrate
make seed
make up-full
make healthcheck
make dd-apply
```

Point an A record at the Elastic IP before starting Caddy, and it will obtain a certificate automatically. Then visit `https://your-domain`.

**Do not run `make bootstrap` on a deployed host, and leave `VOYAGER_DEV_BIND_ADDR` empty.** That variable is what keeps `docker-compose.dev.yml` — which publishes Postgres, Redis, Kafka and every service on the host's interfaces — from being applied there; empty, the overlay refuses to load at all. `make bootstrap` sets it, which is the one thing it does that `userdata.sh` has not already done. `infra/ec2/deploy.sh` refuses to deploy if it finds the value filled in.

Full reasoning, and the list of what in this path has never been run against a real instance, is in `docs/runbooks/04-ec2-deploy.md`.

### 6.3 Updating

```bash
make deploy    # pull, set DD_VERSION from the git SHA, build, rolling restart,
               # migrate, upload sourcemaps, healthcheck
```

Each deploy sets a new `DD_VERSION`, so deployment markers appear in APM automatically — which is what makes the regression demo (scenario S6) work.

### 6.4 Cost notes

- `m5.xlarge` on-demand runs roughly $140/month if left on continuously. Stop the instance when it's not in use; the EBS volume and all data persist.
- The biggest Datadog cost driver is 100% Session Replay sampling. Use `make idle-mode` between demos — it reduces trace sampling and replay sampling together.
- `make down` stops containers but keeps volumes, so you don't re-seed after a restart.

---

## 7. The Ops console

`https://<host>/admin` — requires header `X-Voyager-Admin: ${ADMIN_SECRET}`, which the UI prompts for and stores in session storage.

| Tab | What's there |
|---|---|
| **Chaos** | All 35+ flags, grouped, with live values and descriptions |
| **Scenarios** | The 10 composite demo scenarios, one click each |
| **Load** | Traffic intensity, API and browser generators |
| **Status** | Per-service health, latency, error rate, version; DB/Redis/Kafka vitals |
| **Data** | Re-seed, clear caches, reset chaos |

The **RESET ALL CHAOS** button is deliberately large and always visible. You will use it while talking, without looking.

Flag catalogue: `05-FUNCTIONALITY.md § 11`. Scenario descriptions: `01-PRD.md § 8`.

---

## 8. Running a demo

Committed runbooks in `docs/runbooks/`, one step per line, written to be held while you talk:

| Runbook | For |
|---|---|
| `01-sre-deep-dive.md` | SRE / platform audiences, 45 min (`06-USER-FLOWS.md § 9.1`) |
| `02-developer-walkthrough.md` | Developers, 25 min (`06-USER-FLOWS.md § 9.2`) |
| `03-pre-demo-checklist.md` | The checklist and the mid-demo recovery table |
| `04-ec2-deploy.md` | Deployment, and an honest list of what is untested |

Before every demo, run the checklist. The short version:

```bash
make healthcheck     # green, zero active chaos flags
make demo-mode       # full sampling
# Load generator should have been running ≥ 30 min so dashboards have shape
# Complete one manual booking; verify its trace has 40+ spans
```

---

## 9. Troubleshooting

### Traces are truncated or services are missing from the map
Almost always propagation configuration. Check `DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext` on the service where the trace *stops* — not the one where it starts. Then check tracer load order: in Node, `dd-trace` must load before `fastify` and `pg`; in Python, the container must launch via `ddtrace-run`.

### No traces at all from one service
```bash
docker compose logs <service> | grep -i datadog
docker compose exec <service> env | grep DD_
curl -s http://localhost:8126/info        # is the Agent's APM receiver up?
```
Confirm `DD_APM_NON_LOCAL_TRAFFIC=true` on the Agent — without it, the Agent rejects traces from other containers, silently.

### RUM sessions not appearing
Check `VITE_DD_RUM_APPLICATION_ID` and `VITE_DD_RUM_CLIENT_TOKEN` are baked into the build (they're build-time, not runtime — rebuild after changing them). Check the browser console for SDK errors, confirm `VITE_DD_SITE` matches your org, and confirm you're on HTTPS.

### Logs arriving without `trace_id`
Verify `DD_LOGS_INJECTION=true` and that the logger is the one the tracer patched. In Node, a `pino` instance created *before* `dd-trace` initializes won't be instrumented. In Go, injection is manual — pull the IDs from the span context.

### DBM shows no queries
```sql
SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';
SELECT * FROM pg_stat_statements LIMIT 1;
```
If the extension is missing, `shared_preload_libraries` wasn't applied — that requires a Postgres restart, not a reload. Also confirm the `datadog` role exists with `pg_monitor` and that the Agent's check has `dbm: true`.

### Data Streams Monitoring is empty
`DD_DATA_STREAMS_ENABLED=true` must be set on **both** producers and consumers. Inspect a message's headers and confirm the tracer injected context.

### Profiler shows no function names (Go)
The build stripped symbols. Remove `-ldflags="-s -w"` from the Dockerfile.

### Containers are being OOM-killed
```bash
docker stats
free -h
```
Check `mem_limit` values against the budget in `02-TECH-STACK.md § 9.1`. The usual culprits are Postgres `shared_buffers` set too high and the Playwright container. Reduce `LOADGEN_BROWSER_CONCURRENCY` to 1.

### Seeding is slow or fails
Seeding writes well over 1M rows (400k bookings, 400k payments, 150k flights, plus the 20 power users with 300–800 bookings each). It should take under 5 minutes on `m5.xlarge`. If it's much slower, check disk IOPS — gp2 or a low-IOPS gp3 volume will bottleneck it. Seeding is idempotent, so re-running is safe.

### Chaos won't revert
```bash
make chaos-reset
redis-cli -h localhost HGETALL voyager:chaos     # should be empty
make migrate                                     # recreates a dropped index
```

### `docker compose` refuses to start: "refusing to publish internal ports"

`docker-compose.dev.yml` interpolates `VOYAGER_DEV_BIND_ADDR` into every port
mapping with `:?`, so it will not load while that value is empty. That is the
mechanism that keeps the overlay — which publishes Postgres, Redis, Kafka and
every service on the host's interfaces — off a deployed host.

On a **workstation**, set it:
```bash
echo 'VOYAGER_DEV_BIND_ADDR=127.0.0.1' >> .env
```
`make bootstrap` does this when it creates `.env`; a `.env` copied by hand from
`.env.example` will not have it.

On a **deployed host**, leave it empty and do not reach for the overlay. If a
verify script cannot connect there, that is the design: nothing but the edge is
reachable. Run the check through the edge instead —
`EDGE_URL=https://<host> scripts/verify-edge.sh`.

### `make healthcheck` fails on "images carrying no usable commit stamp"

`DD_GIT_COMMIT_SHA` and `DD_GIT_REPOSITORY_URL` are baked into each image at
build time, because the running container has no git to ask. If they are
missing or hold a placeholder, Source Code Integration produces stack-frame
links that resolve to nothing — which is worse than no link, since it looks
like the integration works and the repository is wrong.

```bash
make build && make up     # restamps from the working tree
# or, on a deployed host:
make deploy               # resolves the SHA and reads it back out to check
```

If it persists after a rebuild, the value is not reaching Compose. Check it:
```bash
docker compose -f docker-compose.yml config | grep -A2 DD_GIT_COMMIT_SHA
```
A checkout with no git remote has no repository URL to resolve, so
`DD_GIT_REPOSITORY_URL` has to come from `.env` in that case.

### No certificate, or Caddy logs "no solvers succeeded"

Caddy answers the ACME HTTP-01 challenge on port 80, so that port has to be
reachable from the internet even if you only ever visit HTTPS. Check the
security group, and check that the A record points at this instance before the
edge starts — Let's Encrypt's rate limit is five failures per hostname per week.

With `PUBLIC_HOSTNAME=localhost` or a bare IP, Caddy signs with its own CA
instead and never contacts Let's Encrypt at all. That is the right behaviour
locally, and it means the ACME path is entirely untested until a real domain is
configured.

### The API returns 404 for everything through the edge

The gateway mounts its routes at `/api/v1`, so the prefix must survive the
proxy. In `infra/edge/Caddyfile` that is `handle /api/*`; `handle_path` would
strip it and turn every API call into a 404 from Fastify's not-found handler —
a JSON error envelope that reads like an application bug rather than a routing
mistake. Confirm both halves:
```bash
curl -sk -o /dev/null -w '%{http_code}\n' "https://<host>/api/v1/ref/airports?q=LON"   # 200
scripts/verify-edge.sh                                                                  # asserts it
```

### Everything is confusing
```bash
make reset     # nuke → up → migrate → seed → chaos-reset
               # ~5 minutes to a clean, seeded, healthy system
```

---

## 10. Repository layout

```
apps/web-ui/            React SPA (RUM lives in src/datadog/rum.ts)
services/               8 first-party services
mocks/                  4 simulated third parties
packages/               Shared zod schemas
infra/                  Datadog Agent, Postgres, Redis, Kafka, Caddy, EC2 scripts
datadog/                Dashboards, monitors, SLOs, synthetics, notebooks — as code
tools/                  Seeder, k6 load, Playwright load, scenario definitions
scripts/                Operator entry points and the exit-criteria verifiers
docs/runbooks/          Demo narratives, pre-demo checklist, deployment runbook
.github/workflows/      CI with Test Optimization
```

Full tree in `02-TECH-STACK.md § 10`.

---

## 11. Not included (deliberately)

App & API Protection, Sensitive Data Scanner, Cloud Security Management, Cloud SIEM, Kubernetes/Orchestrator Explorer, Mobile RUM, and Cloud Cost Management are all out of scope for v1, tracked in `01-PRD.md § 11`.

Cursor: **do not build these.** They're listed so their absence reads as a decision rather than an oversight.

---

## 12. Notes and disclaimers

- Every airline, hotel, and payment provider in Voyager is invented. No real brands, logos, or visual identities are reproduced.
- No real payment processing occurs. All card handling is against an in-repo mock; there is no PCI scope.
- Passenger data is synthetic. No real personal information is stored anywhere.
- This is a demo environment. It is not hardened, not scalable, and not suitable for production use. Keep it behind an IP allowlist.
