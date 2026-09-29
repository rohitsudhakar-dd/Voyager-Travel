# Voyager -- the operator interface.
#
# Every target named in 02-TECH-STACK.md § 11 exists from day one. Targets that
# depend on code from a later phase announce the phase that will implement them,
# so the interface never changes underneath the runbooks.

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE      := docker compose
COMPOSE_DEV  := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml
DATA_LAYER   := postgres redis kafka

# Source Code Integration. Resolved from the working tree and exported so that
# both `build` (which bakes them into the image) and `up` see the same values.
# A dirty tree still reports the last commit, which is the honest answer: the
# link points at code that exists on the remote rather than at nothing.
export DD_GIT_COMMIT_SHA    ?= $(shell git rev-parse HEAD 2>/dev/null)
export DD_GIT_REPOSITORY_URL ?= $(shell git config --get remote.origin.url 2>/dev/null)

# `s=` selects a single service for the targets that take one.
s ?=

.PHONY: help bootstrap build up up-full up-one down nuke seed seed-verify reset \
        logs migrate healthcheck chaos chaos-reset scenario scenarios \
        dd-apply dd-sourcemaps demo-mode idle-mode test verify deploy ps

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
		cp .env.example .env; \
		echo "created .env from .env.example"; \
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

up-full: ## up + the k6 and Playwright load generators
	@echo "not yet implemented (phase 11)"

up-one: ## Rebuild and restart one service: make up-one s=pricing
	@test -n "$(s)" || { echo "usage: make up-one s=<service>"; exit 1; }
	$(COMPOSE) up -d --build $(s)

down: ## Stop everything, keep volumes
	$(COMPOSE) down --remove-orphans

nuke: ## Stop everything and delete volumes (destructive)
	$(COMPOSE) down --remove-orphans --volumes

ps: ## Show container status
	@$(COMPOSE) ps

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
	@echo "not yet implemented (phase 12)"

dd-sourcemaps: ## Upload web-ui sourcemaps
	@echo "not yet implemented (phase 9)"

demo-mode: ## 100% sampling, 2x load
	@echo "not yet implemented (phase 13)"

idle-mode: ## Reduced sampling, 1x load, 20% replay -- controls cost
	@echo "not yet implemented (phase 13)"

# -------------------------------------------------------------- verify --

healthcheck: ## Assert every service is healthy and all chaos flags are off
	@echo "not yet implemented (phase 13)"

test: ## Run all four test suites
	@# The host has no Go toolchain, so the suites run in a throwaway
	@# container against the working tree.
	@for svc in search-service pricing-service; do \
		echo "== $$svc =="; \
		docker run --rm -v "$(PWD)/services/$$svc":/src -w /src golang:1.23-alpine \
			sh -c 'go vet ./... && go test ./...' || exit 1; \
	done
	@for svc in booking-service payment-service; do \
		echo "== $$svc =="; \
		docker run --rm -v "$(PWD)/services/$$svc":/app -w /app python:3.12-slim \
			sh -c 'pip install -q -r requirements.txt -r requirements-dev.txt && python -m pytest' \
			|| exit 1; \
	done
	@echo "== typescript =="
	@echo "not yet implemented (phases 5, 7)"

verify: ## Run the phase exit-criteria scripts against a running stack
	@./scripts/verify-mocks.sh
	@./scripts/verify-search.sh
	@./scripts/verify-booking.sh
	@./scripts/verify-gateway.sh

deploy: ## Pull, stamp DD_VERSION, build, rolling restart, migrate, healthcheck
	@echo "not yet implemented (phase 13)"
