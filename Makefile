# Voyager -- the operator interface.
#
# Every target named in 02-TECH-STACK.md § 11 exists from day one. Targets that
# depend on code from a later phase announce the phase that will implement them,
# so the interface never changes underneath the runbooks.

SHELL := /bin/bash
.DEFAULT_GOAL := help

DATA_LAYER   := postgres redis kafka

# The dev overlay is selected by the same value that arms it. docker-compose.dev.yml
# refuses to interpolate an empty VOYAGER_DEV_BIND_ADDR, so a workstation --
# where `make bootstrap` set it -- always gets both files, and a deployed host,
# where .env.example's empty value stands, can never get the second one even by
# running a target that would have asked for it.
DEV_BIND_ADDR := $(shell sed -n 's/^VOYAGER_DEV_BIND_ADDR=\([^[:space:]\#]*\).*/\1/p' .env 2>/dev/null | head -1)
COMPOSE_FILES := -f docker-compose.yml
ifneq ($(strip $(DEV_BIND_ADDR)),)
COMPOSE_FILES += -f docker-compose.dev.yml
endif

COMPOSE      := docker compose $(COMPOSE_FILES)
COMPOSE_ALL  := $(COMPOSE) -f docker-compose.loadgen.yml

# Exported so that the scripts which have to recreate containers -- currently
# only sampling-mode.sh -- act on the same file set as everything else rather
# than quietly dropping the overlay's published ports on a workstation.
export VOYAGER_COMPOSE := docker compose $(COMPOSE_FILES)

# Source Code Integration. Resolved from the working tree and exported so that
# both `build` (which bakes them into the image) and `up` see the same values.
# A dirty tree still reports the last commit, which is the honest answer: the
# link points at code that exists on the remote rather than at nothing.
#
# Each is exported only when git can actually answer. Exported empty, it would
# shadow the value in .env -- which is the only source a checkout with no
# remote has -- and turn Source Code Integration off with no error anywhere.
VOYAGER_SHA  := $(shell git rev-parse HEAD 2>/dev/null)
VOYAGER_REPO := $(shell git config --get remote.origin.url 2>/dev/null)
ifneq ($(strip $(VOYAGER_SHA)),)
export DD_GIT_COMMIT_SHA ?= $(VOYAGER_SHA)
endif
ifneq ($(strip $(VOYAGER_REPO)),)
export DD_GIT_REPOSITORY_URL ?= $(VOYAGER_REPO)
endif

# `s=` selects a single service for the targets that take one.
s ?=

.PHONY: help bootstrap build up up-full up-one web-ui down nuke seed seed-verify reset \
        logs migrate dbm-setup healthcheck chaos chaos-reset scenario scenarios \
        dd-apply dd-sourcemaps demo-mode idle-mode test verify verify-tracing verify-streams deploy ps \
        test-web test-node test-python test-go verify-edge verify-llmobs verify-rum verify-dbm \
        verify-metrics

help: ## List available targets
	@echo "Voyager -- make targets"
	@echo
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  Pass a single service with s=<name>, e.g. make logs s=booking"

# ---------------------------------------------------------------- lifecycle --

bootstrap: ## Check host tooling and create .env from the template
	@command -v docker >/dev/null || { echo "docker not found -- install Docker Engine 24+"; exit 1; }
	@$(COMPOSE) version >/dev/null 2>&1 || { echo "docker compose plugin not found"; exit 1; }
	@if [ -f .env ]; then \
		echo ".env already exists -- leaving it alone"; \
	else \
		sed 's|^VOYAGER_DEV_BIND_ADDR=.*|VOYAGER_DEV_BIND_ADDR=127.0.0.1|' \
			.env.example > .env; \
		echo "created .env from .env.example"; \
		echo "set VOYAGER_DEV_BIND_ADDR=127.0.0.1 -- this is a workstation, so"; \
		echo "docker-compose.dev.yml may publish internal ports on loopback"; \
	fi
	@echo
	@echo "Next:"
	@echo "  1. \$$EDITOR .env    -- set DD_API_KEY, RUM ids, and generate the secrets:"
	@echo "                         openssl rand -hex 32"
	@echo "  2. make build"
	@echo "  3. make up && make migrate && make seed"

build: ## Build all images
	$(COMPOSE) build

up: ## Start the data layer, services, and the Datadog Agent
	$(COMPOSE) up -d
	@$(MAKE) --no-print-directory ps

web-ui: ## Run the frontend dev server with the browser fixture layer (no backend needed)
	docker run --rm -it -p 5173:5173 \
		-v "$(PWD)/apps/web-ui":/app -v "$(PWD)/packages":/packages -w /app \
		node:20.17-alpine sh -c "npm install && npm run dev -- --host 0.0.0.0"

up-full: ## up + the k6 and Playwright load generators
	$(COMPOSE_ALL) --profile loadgen up -d
	@$(MAKE) --no-print-directory ps

up-one: ## Rebuild and restart one service: make up-one s=pricing
	@test -n "$(s)" || { echo "usage: make up-one s=<service>"; exit 1; }
	$(COMPOSE) up -d --build $(s)

# down, nuke and ps name the loadgen overlay as well. Without it the
# generators are orphans of the project: `down` reports them as such and
# `ps` omits them, so "is the load generator running" -- the first question
# an empty dashboard raises -- cannot be answered with the operator interface.
down: ## Stop everything, keep volumes
	$(COMPOSE_ALL) --profile loadgen down --remove-orphans

nuke: ## Stop everything and delete volumes (destructive)
	$(COMPOSE_ALL) --profile loadgen down --remove-orphans --volumes

ps: ## Show container status
	@$(COMPOSE_ALL) --profile loadgen ps

logs: ## Tail one service: make logs s=booking
	@test -n "$(s)" || { echo "usage: make logs s=<service>"; exit 1; }
	$(COMPOSE) logs -f --tail=200 $(s)

# ------------------------------------------------------------------- data --

migrate: ## Run Alembic migrations (booking-service owns the schema)
	$(COMPOSE) run --rm --no-deps booking-service alembic upgrade head

seed: ## Run the seeder job (truncate-then-load, deterministic)
	$(COMPOSE) --profile tools run --rm seeder --yes

seed-verify: ## Re-run the seed exit-criteria checks without reloading
	$(COMPOSE) --profile tools run --rm seeder --verify-only

dbm-setup: ## Create the datadog role, grants and explain function (idempotent)
	@# infra/postgres/init runs once, on first initialisation of the volume.
	@# A stack that predates 03-datadog.sql -- which is every stack upgraded
	@# rather than rebuilt -- never sees it, and the Postgres check then fails
	@# authentication with no hint as to why. The file is written to be safe to
	@# run twice so this target can simply apply it.
	@set -a; . ./.env; set +a; \
	$(COMPOSE) exec -T -e DD_PG_PASSWORD="$$DD_PG_PASSWORD" postgres \
		psql -v ON_ERROR_STOP=1 -U "$${POSTGRES_USER:-voyager}" -d "$${POSTGRES_DB:-voyager}" \
		-f /docker-entrypoint-initdb.d/03-datadog.sql

reset: ## nuke + up + migrate + seed -- the "make it clean" button
	@$(MAKE) --no-print-directory nuke
	@$(MAKE) --no-print-directory up
	@$(MAKE) --no-print-directory migrate
	@$(MAKE) --no-print-directory seed
	@$(MAKE) --no-print-directory chaos-reset

# ------------------------------------------------------------------ chaos --

chaos: ## Show every chaos flag that is currently active
	@./scripts/chaos.sh status

chaos-reset: ## Clear every chaos flag and undo its side effects
	@./scripts/chaos.sh reset

scenario: ## Apply a composite scenario: make scenario s=S4
	@test -n "$(s)" || { echo "usage: make scenario s=<S1..S10>"; exit 1; }
	@./scripts/chaos.sh apply $(s)

scenarios: ## List the composite scenarios and which one is active
	@./scripts/chaos.sh scenarios

# ------------------------------------------------------------- datadog --

dd-apply: ## Push dashboards, monitors, SLOs and synthetics
	@./datadog/apply.sh

dd-sourcemaps: ## Upload web-ui sourcemaps
	@./scripts/dd-sourcemaps.sh

demo-mode: ## 100% sampling, 2x load
	@./scripts/sampling-mode.sh demo

idle-mode: ## Reduced sampling, 1x load, 20% replay -- controls cost
	@./scripts/sampling-mode.sh idle

# -------------------------------------------------------------- verify --

healthcheck: ## Assert every service is healthy and all chaos flags are off
	@./scripts/healthcheck.sh

test: ## Run all four test suites
	@./scripts/run-tests.sh all

test-web: ## One suite: vitest in apps/web-ui
	@./scripts/run-tests.sh web

test-node: ## One suite: vitest and typecheck in the Node services
	@./scripts/run-tests.sh node

test-python: ## One suite: pytest in the four Python services
	@./scripts/run-tests.sh python

test-go: ## One suite: go vet and go test in the two Go services
	@./scripts/run-tests.sh go

verify: ## Run the phase exit-criteria scripts against a running stack
	@./scripts/verify-mocks.sh
	@./scripts/verify-search.sh
	@./scripts/verify-booking.sh
	@./scripts/verify-gateway.sh
	@./scripts/verify-edge.sh
	@./scripts/verify-rum.sh
	@echo
	@echo "Span-level tracing checks are not run here: they stop and restart six"
	@echo "services. Run them on their own with 'make verify-tracing', and the"
	@echo "LLM Observability checks with 'make verify-llmobs'."

verify-tracing: ## Phase 8 exit criteria (stops and restarts services; takes minutes)
	@./scripts/verify-tracing.sh

verify-dbm: ## Phase 10 DBM exit criteria (drops an index and restores it; ~3 min)
	@./scripts/verify-dbm.sh

verify-llmobs: ## Phase 10 LLM Observability (stops ai-support-service; sets chaos)
	@./scripts/verify-llmobs.sh

verify-metrics: ## Phase 10 § 14 business metrics (pauses loadgen, books four times; ~6 min)
	@./scripts/verify-metrics.sh

verify-streams: ## Phase 10 Data Streams and Kafka chaos (pauses a consumer group; takes minutes)
	@./scripts/verify-streams.sh

verify-edge: ## Phase 13 exit criteria for the edge proxy and port exposure
	@./scripts/verify-edge.sh

verify-rum: ## Phase 9 exit criteria (drives one real browser session; sets chaos)
	@./scripts/verify-rum.sh

deploy: ## Pull, stamp DD_VERSION, build, rolling restart, migrate, healthcheck
	@./infra/ec2/deploy.sh
