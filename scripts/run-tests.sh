#!/usr/bin/env bash
#
# The four test suites, in containers (02-TECH-STACK.md § 13).
#
#   scripts/run-tests.sh all        every suite, in order
#   scripts/run-tests.sh go         one suite: web | node | python | go
#   scripts/run-tests.sh go --junit also write JUnit XML to .test-reports/
#
# One script rather than a Makefile recipe and a workflow step, because a suite
# that runs differently in CI than it does on a laptop is a suite that fails
# only in CI. .github/workflows/ci.yml calls exactly these commands.
#
# Everything runs in a container: the development host has no Node, Go or
# Python toolchain (02-TECH-STACK.md § 11). Dependencies install into named
# volumes rather than into the bind-mounted working tree, because the tree
# holds the host's node_modules -- built for a different architecture than the
# Linux containers here -- and overwriting them breaks the host's editor
# tooling for reasons nobody would connect to having run the tests.
#
# JUnit XML is the reporting path for all four suites. § 5 lists dd-trace/ci
# for vitest; that needs dd-trace in web-ui's dependency tree, where it would
# also be in the browser bundle's lockfile, so the two vitest suites report
# through `datadog-ci junit upload` like the Go suite does. pytest keeps
# --ddtrace, which costs nothing because ddtrace is already installed there.
set -uo pipefail

cd "$(dirname "$0")/.."

suite=${1:-all}
junit=false
[[ ${2:-} == --junit ]] && junit=true

REPORTS=.test-reports
NODE_IMAGE=node:20.17-alpine
GO_IMAGE=golang:1.23-alpine
PY_IMAGE=python:3.12-slim

# gotestsum is pinned: it produces the JUnit XML the Go suite reports with, and
# an unpinned @latest makes the test job's behaviour depend on the day.
GOTESTSUM_VERSION=v1.12.0

failures=()

heading() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Shared caches. Without them every run re-downloads the same trees, which on
# CI is most of the wall time.
NPM_CACHE=voyager_test_npm_cache
GO_CACHE=voyager_test_go_cache
PIP_CACHE=voyager_test_pip_cache

record() {
  local label=$1 status=$2
  if [[ $status -eq 0 ]]; then
    printf '\033[32m   %s passed\033[0m\n' "$label"
  else
    printf '\033[31m   %s FAILED (exit %d)\033[0m\n' "$label" "$status"
    failures+=("$label")
  fi
}

report_dir() {
  local name=$1
  if [[ $junit == true ]]; then
    mkdir -p "$REPORTS/$name"
    echo "$REPORTS/$name"
  fi
}

# --------------------------------------------------------------- vitest --

# Both vitest suites mount the repository root: web-ui's vitest resolves
# @voyager/shared-schemas to packages/shared-schemas/src, which is outside the
# app directory, and a narrower mount makes that alias unresolvable.
run_vitest() {
  local label=$1 dir=$2 modules_volume=$3
  local out
  out=$(report_dir "$label")

  local reporters=(--reporter=default)
  [[ -n "$out" ]] && reporters+=(--reporter=junit "--outputFile=/repo/$out/junit.xml")

  heading "vitest: $label"
  docker run --rm \
    -v "$PWD:/repo" \
    -v "$modules_volume:/repo/$dir/node_modules" \
    -v "$NPM_CACHE:/root/.npm" \
    -w "/repo/$dir" \
    -e CI=true \
    "$NODE_IMAGE" \
    sh -c "npm ci --prefer-offline --no-audit --fund=false >/dev/null && npx vitest run ${reporters[*]}"
  record "vitest ($label)" $?
}

run_typecheck() {
  local dir=$1 modules_volume=$2
  heading "tsc --noEmit: $dir"
  docker run --rm \
    -v "$PWD:/repo" \
    -v "$modules_volume:/repo/$dir/node_modules" \
    -v "$NPM_CACHE:/root/.npm" \
    -w "/repo/$dir" \
    "$NODE_IMAGE" \
    sh -c "npm ci --prefer-offline --no-audit --fund=false >/dev/null && npm run typecheck"
  record "typecheck ($dir)" $?
}

suite_web() {
  run_vitest web-ui apps/web-ui voyager_test_modules_web_ui
}

suite_node() {
  # loyalty-service is the only Node service with a vitest suite. The gateway
  # and the mocks are typechecked instead, which is the strongest claim
  # available about code that has no tests, and is not nothing: the zod
  # schemas in packages/shared-schemas are shared with web-ui, so a contract
  # change that only one side followed fails here.
  run_vitest loyalty-service services/loyalty-service voyager_test_modules_loyalty
  run_typecheck services/api-gateway voyager_test_modules_gateway
  for mock in mock-gds mock-payments mock-email mock-llm; do
    run_typecheck "mocks/$mock" "voyager_test_modules_$(tr - _ <<<"$mock")"
  done
}

suite_python() {
  local out
  out=$(report_dir python)

  # These packages install ddtrace's import hooks at module load, so a tracer
  # starts whether the suite asked for one or not. Without an Agent to reach it
  # spends three retries and a timeout per suite before giving up, which is
  # most of a local run's wall time and reads like a hung test.
  local trace_enabled=false
  [[ -n "${DD_API_KEY:-}" ]] && trace_enabled=true

  for service in booking-service payment-service notification-worker ai-support-service; do
    heading "pytest: $service"
    local args=(-q)
    [[ -n "$out" ]] && args+=("--junitxml=/repo/$out/$service.xml")
    # --ddtrace is pytest's Test Optimization plugin, shipped with ddtrace,
    # which these services already depend on. It is gated on DD_API_KEY so a
    # laptop run does not try to reach Datadog and fail for want of a key.
    [[ "$trace_enabled" == true ]] && args+=(--ddtrace)

    docker run --rm \
      -v "$PWD:/repo" \
      -v "$PIP_CACHE:/root/.cache/pip" \
      -w "/repo/services/$service" \
      -e DD_API_KEY="${DD_API_KEY:-}" \
      -e DD_SITE="${DD_SITE:-datadoghq.com}" \
      -e DD_ENV="${DD_ENV:-ci}" \
      -e DD_SERVICE="voyager-$(sed 's/-service$//' <<<"$service")" \
      -e DD_CIVISIBILITY_AGENTLESS_ENABLED="$trace_enabled" \
      -e DD_TRACE_ENABLED="$trace_enabled" \
      "$PY_IMAGE" \
      sh -c "pip install -q -r requirements.txt -r requirements-dev.txt && python -m pytest ${args[*]}"
    record "pytest ($service)" $?
  done
}

suite_go() {
  local out
  out=$(report_dir go)

  for service in search-service pricing-service; do
    heading "go test: $service"
    local command='go vet ./... && '
    if [[ -n "$out" ]]; then
      command+="go install gotest.tools/gotestsum@$GOTESTSUM_VERSION >/dev/null 2>&1 && "
      command+="gotestsum --format testname --junitfile /repo/$out/$service.xml -- ./..."
    else
      command+='go test ./...'
    fi

    docker run --rm \
      -v "$PWD:/repo" \
      -v "$GO_CACHE:/go/pkg/mod" \
      -w "/repo/services/$service" \
      "$GO_IMAGE" \
      sh -c "$command"
    record "go test ($service)" $?
  done
}

case "$suite" in
  web)    suite_web ;;
  node)   suite_node ;;
  python) suite_python ;;
  go)     suite_go ;;
  all)    suite_web; suite_node; suite_python; suite_go ;;
  *)
    echo "usage: $0 <web|node|python|go|all> [--junit]" >&2
    exit 1
    ;;
esac

printf '\n'
if (( ${#failures[@]} )); then
  printf '\033[31m%d suite(s) failed: %s\033[0m\n' "${#failures[@]}" "${failures[*]}"
  exit 1
fi
printf '\033[32mall requested suites passed\033[0m\n'
