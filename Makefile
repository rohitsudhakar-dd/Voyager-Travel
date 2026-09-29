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

# `s=` selects a single service for the targets that take one.
s ?=

.PHONY: help bootstrap build up up-full up-one down nuke seed reset logs migrate \
        healthcheck chaos-reset scenario dd-apply dd-sourcemaps demo-mode idle-mode \
        test deploy ps

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
	@echo "not yet implemented (phase 1)"

seed: ## Run the seeder job
	@echo "not yet implemented (phase 1)"

reset: ## nuke + up + migrate + seed + chaos-reset -- the "make it clean" button
	@echo "not yet implemented (phase 1)"

# ------------------------------------------------------------------ chaos --

chaos-reset: ## Clear every chaos flag
	@echo "not yet implemented (phase 6)"

scenario: ## Apply a composite scenario: make scenario s=S4
	@echo "not yet implemented (phase 6)"

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
	@echo "not yet implemented (phase 3)"

deploy: ## Pull, stamp DD_VERSION, build, rolling restart, migrate, healthcheck
	@echo "not yet implemented (phase 13)"
