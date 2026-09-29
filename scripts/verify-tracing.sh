#!/usr/bin/env bash
#
# Phase 8 exit criteria, as assertions.
#
# Two things are checked, and they need different machinery:
#
#   1. Every service reaches the Agent, in the right language, with the right
#      service name. The real Agent's own log answers this.
#   2. The sixteen custom spans and twelve span tags exist. The Agent cannot
#      answer this -- its status names only the top-level service on each
#      payload, so a child span like `search.fanout` is invisible there however
#      correct it is -- and the Datadog API needs an application key. So each
#      service is run once more against scripts/lib/span_sink.py, which decodes
#      the payload and prints one line per span.
#
# The throwaway containers share the running stack's databases and Redis, so
# this is safe to run against a live demo, but it does write a booking.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
SINK=span-sink
SINK_LOG=/tmp/voyager-spans.jsonl

passed=0
failed=0

pass() { printf '  ok    %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; failed=$((failed + 1)); }

check() {
  local label=$1 condition=$2
  if [[ $condition == true ]]; then pass "$label"; else fail "$label"; fi
}

cleanup() {
  docker rm -f "$SINK" >/dev/null 2>&1
  docker rm -f trace-probe >/dev/null 2>&1
}
trap cleanup EXIT

# ------------------------------------------------------------------ part 1 --

echo
echo "Tracers reporting to the Agent"

if ! docker ps --format '{{.Names}}' | grep -qx datadog-agent; then
  echo "  datadog-agent is not running -- start the stack first"
  exit 1
fi

# One request per service, so nothing depends on traffic that happened to be
# flowing already.
curl -sS -o /dev/null "http://127.0.0.1:4000/api/v1/ref/airports?q=ZRH" 2>/dev/null
curl -sS -o /dev/null "http://127.0.0.1:4000/api/v1/bff/home" 2>/dev/null

# The Agent flushes its per-tracer stats once a minute, so the window has to
# be at least that long or a healthy service reads as missing.
echo "  (waiting for the Agent's stats flush)"
sleep 65

agent_log=$(docker exec datadog-agent cat /var/log/datadog/trace-agent.log 2>/dev/null | tr -d '\000')

for service in voyager-gateway voyager-search voyager-pricing voyager-booking \
               voyager-payment voyager-loyalty voyager-notifications \
               voyager-ai-support mock-gds mock-payments mock-email mock-llm; do
  if grep -q "service:${service}\]" <<<"$agent_log"; then
    pass "$service reports traces"
  else
    fail "$service reports traces"
  fi
done

for language in go nodejs python; do
  check "$language tracers reporting" \
    "$(grep -q "lang:${language} " <<<"$agent_log" && echo true || echo false)"
done

# § 12 of the deliverable list: health checks must not become APM resources.
check "health checks are filtered out of APM" \
  "$(grep -q 'traces filtered: [1-9]' <<<"$agent_log" && echo true || echo false)"

# ------------------------------------------------------------------ part 2 --

echo
echo "Custom spans and span tags"

docker rm -f "$SINK" >/dev/null 2>&1
docker run -d --name "$SINK" --network voyager \
  -v "$PWD/scripts/lib":/opt/sink:ro \
  python:3.12-slim python /opt/sink/span_sink.py 8126 >/dev/null
sleep 3

# Each probe runs one service against the sink and drives the path that
# produces its spans. The port is deliberately 10000 above the real one so a
# probe can never be mistaken for the running service.
probe() {
  local service=$1 port=$2
  # Assigned separately: bash expands every word on a `local` line before it
  # assigns any of them, so `port` is still unset in the arithmetic.
  local host_port=$((port + 10000))
  shift 2

  "${COMPOSE[@]}" run --rm -d --name trace-probe \
    -e DD_AGENT_HOST="$SINK" -p "${host_port}:${port}" "$service" >/dev/null 2>&1

  # Poll rather than sleep: a cold Go binary and a cold uvicorn differ by
  # several seconds, and a fixed wait long enough for the slowest is a fixed
  # wait for every one of them.
  for _ in $(seq 1 40); do
    curl -sS -o /dev/null "http://127.0.0.1:${host_port}/health" 2>/dev/null && break
    sleep 1
  done

  "$@" "$host_port"

  # The tracers flush on their own schedule; nothing has been sent until they do.
  sleep 12
  docker rm -f trace-probe >/dev/null 2>&1
}

drive_search() {
  # A date nobody has searched for, because a cache hit skips the fan-out and
  # the normalisation that this is here to observe.
  curl -sS -o /dev/null -X POST "http://127.0.0.1:$1/v1/search/flights" \
    -H 'content-type: application/json' \
    -d "{\"origin\":\"LHR\",\"destination\":\"BKK\",\"departDate\":\"$(date -v+$((RANDOM % 200 + 30))d +%Y-%m-%d 2>/dev/null || date -d "+$((RANDOM % 200 + 30)) days" +%Y-%m-%d)\",\"passengers\":{\"adults\":1},\"cabin\":\"business\"}" 2>/dev/null
}

drive_pricing() {
  curl -sS -o /dev/null -X POST "http://127.0.0.1:$1/v1/pricing/quote" \
    -H 'content-type: application/json' \
    -d '{"id":"probe","origin":"LHR","destination":"JFK","departDate":"2026-11-20","fareClass":"Y","cabin":"economy","baseAmountCents":45000,"currency":"GBP"}' 2>/dev/null
}

drive_loyalty() {
  curl -sS -o /dev/null -X POST "http://127.0.0.1:$1/v1/loyalty/preview" \
    -H 'content-type: application/json' \
    -d '{"amountCents":52000,"taxesCents":7000,"fareClassCode":"Y","currency":"GBP"}' 2>/dev/null
}

probe search-service 4010 drive_search
probe pricing-service 4020 drive_pricing
probe loyalty-service 4050 drive_loyalty

docker logs "$SINK" >"$SINK_LOG" 2>/dev/null

span_names=$(python3 -c "
import json, sys
for line in open('$SINK_LOG'):
    try: print(json.loads(line)['name'])
    except Exception: pass
" | sort -u)

span_services=$(python3 -c "
import json, sys
for line in open('$SINK_LOG'):
    try: print(json.loads(line)['service'])
    except Exception: pass
" | sort -u)

tag_keys=$(python3 -c "
import json, sys
for line in open('$SINK_LOG'):
    try: print('\n'.join(json.loads(line)['meta']))
    except Exception: pass
" | sort -u)

for span in search.fanout search.cache_lookup search.normalize_results \
            pricing.load_rules pricing.evaluate_fare_rules pricing.apply_taxes \
            loyalty.compute_points; do
  check "span $span" "$(grep -qx "$span" <<<"$span_names" && echo true || echo false)"
done

for tag in search.route search.cabin search.cache_hit product.type \
           chaos.active_flags usr.tier; do
  check "tag $tag" "$(grep -qx "$tag" <<<"$tag_keys" && echo true || echo false)"
done

# The Service Map question, asked locally: a client that keeps the library's
# default name collapses every service onto one shared node.
for client in voyager-search-redis voyager-pricing-postgres voyager-pricing-redis \
              voyager-loyalty-postgres voyager-loyalty-redis voyager-loyalty-kafka; do
  check "client service $client" \
    "$(grep -qx "$client" <<<"$span_services" && echo true || echo false)"
done

for bare in postgres redis kafka; do
  check "no unsplit '$bare' node" \
    "$(grep -qx "$bare" <<<"$span_services" && echo false || echo true)"
done

# ------------------------------------------------------------------ result --

echo
echo "  $passed passed, $failed failed"
[[ $failed -eq 0 ]]
