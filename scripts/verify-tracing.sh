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

# The load generators are paused for the duration. They aim at the real
# service names, so during a probe their traffic lands on the probe -- which
# would let an assertion pass on traffic this script did not send, and that is
# exactly the kind of green that hides a broken span.
LOADGEN=(loadgen-api loadgen-browser)

# Every service a probe stands in for. The probe has to stop the real one --
# it needs the port and the Kafka partitions -- which means a run that is
# interrupted leaves the stack short of a service. So the list is fixed here
# and the trap restores all of it unconditionally, whether this exits cleanly,
# fails an assertion, or is killed halfway through.
PROBED=(search-service pricing-service loyalty-service
        booking-service payment-service notification-worker)

cleanup() {
  docker rm -f "$SINK" >/dev/null 2>&1
  docker rm -f trace-probe >/dev/null 2>&1

  # --force-recreate rather than start: a container that was stopped while
  # `compose run` held the network can come back detached from it, which looks
  # like a crash loop with "network is unreachable" and is far harder to
  # diagnose later than it is to prevent here.
  "${COMPOSE[@]}" up -d --force-recreate "${PROBED[@]}" >/dev/null 2>&1
  for generator in "${LOADGEN[@]}"; do
    docker start "$generator" >/dev/null 2>&1
  done
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

for generator in "${LOADGEN[@]}"; do
  docker stop "$generator" >/dev/null 2>&1
done

docker rm -f "$SINK" >/dev/null 2>&1
docker run -d --name "$SINK" --network voyager \
  -v "$PWD/scripts/lib":/opt/sink:ro \
  python:3.12-slim python /opt/sink/span_sink.py 8126 >/dev/null
sleep 3

# Each probe stands the service up again against the sink, drives the path
# that produces its spans, and puts the real one back.
#
# The real container is stopped for the duration, which matters for two
# reasons that both produced false failures when it was left running: it holds
# the service's port, so the driver's requests went to the untraced container;
# and it holds the Kafka partitions, so a probe joining the same consumer
# group received only whichever messages it happened to be assigned.
#
# --service-ports republishes exactly what the dev overlay publishes, so the
# driver's URLs need no rewriting.
probe() {
  local service=$1 port=$2
  shift 2

  "${COMPOSE[@]}" stop "$service" >/dev/null 2>&1
  # --use-aliases gives the probe the service's own DNS name, so the gateway
  # reaches it exactly as it reaches the real one. Without it the probe is
  # anonymous on the network and every call through the gateway fails at the
  # first hop.
  "${COMPOSE[@]}" run --rm -d --name trace-probe --service-ports --use-aliases \
    -e DD_AGENT_HOST="$SINK" "$service" >/dev/null 2>&1

  # Poll the service's own health endpoint, not the container's existence.
  # Checking only that the container is up is what made this unreliable: a Go
  # binary answers in about a second and `ddtrace-run uvicorn` takes ten to
  # fifteen, so the driver fired at a port nothing was listening on yet, the
  # gateway returned an upstream error, and the spans it was waiting for were
  # never created.
  local ready=false
  for _ in $(seq 1 90); do
    if curl -sS -o /dev/null "http://127.0.0.1:${port}/health" 2>/dev/null; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ $ready != true ]]; then
    fail "$service probe never became ready"
    docker rm -f trace-probe >/dev/null 2>&1
    "${COMPOSE[@]}" up -d --force-recreate "$service" >/dev/null 2>&1
    return
  fi

  "$@"

  # The tracers flush on their own schedule; nothing has been sent until they do.
  sleep 12
  docker rm -f trace-probe >/dev/null 2>&1
  "${COMPOSE[@]}" up -d --force-recreate "$service" >/dev/null 2>&1
}

# Each driver exercises exactly the path that produces its service's spans.

drive_search() {
  # A date nobody has searched for, because a cache hit skips the fan-out and
  # the normalisation this is here to observe.
  curl -sS -o /dev/null -X POST "http://127.0.0.1:4010/v1/search/flights" \
    -H 'content-type: application/json' \
    -d "{\"origin\":\"LHR\",\"destination\":\"BKK\",\"departDate\":\"$(future_date)\",\"passengers\":{\"adults\":1},\"cabin\":\"business\"}" 2>/dev/null
}

drive_pricing() {
  curl -sS -o /dev/null -X POST "http://127.0.0.1:4020/v1/price/flight" \
    -H 'content-type: application/json' \
    -d '{"id":"probe","origin":"LHR","destination":"JFK","departDate":"2026-11-20","fareClass":"Y","cabin":"economy","baseAmountCents":45000,"currency":"GBP"}' 2>/dev/null
}

drive_loyalty() {
  curl -sS -o /dev/null -X POST "http://127.0.0.1:4050/v1/loyalty/preview" \
    -H 'content-type: application/json' \
    -d '{"amountCents":52000,"taxesCents":7000,"fareClassCode":"Y","currency":"GBP"}' 2>/dev/null
}

# A signed-in traveller through a full checkout plus a declined card, which is
# what produces every booking.* and payment.* span and the usr.* tags.
drive_checkout() {
  ./scripts/lib/drive-checkout.sh >/dev/null 2>&1 || true
}

# loyalty answers both over HTTP and off Kafka, and only the Kafka path
# produces voyager-loyalty-kafka and voyager-loyalty-postgres.
drive_loyalty_then_checkout() {
  drive_loyalty
  drive_checkout
}

future_date() {
  date -v+"$((RANDOM % 200 + 30))"d +%Y-%m-%d 2>/dev/null \
    || date -d "+$((RANDOM % 200 + 30)) days" +%Y-%m-%d
}

probe search-service 4010 drive_search
probe pricing-service 4020 drive_pricing
# The loyalty probe needs a booking confirmed while it holds the partitions,
# or kafka.consume never happens and voyager-loyalty-kafka never appears.
probe loyalty-service 4050 drive_loyalty_then_checkout

# The booking and payment spans need a booking driven all the way to a card
# authorisation, so these two probes run against the live gateway rather than
# against themselves: the gateway calls whichever container holds the port,
# which is the probe. verify-booking.sh owns that flow, so this reuses it.
probe booking-service 4030 drive_checkout
probe payment-service 4040 drive_checkout
probe notification-worker 4060 drive_checkout

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
            booking.validate_availability booking.acquire_hold_lock \
            booking.hold_inventory booking.state_transition \
            payment.build_request payment.authorize payment.idempotency_check \
            payment.persist_ledger \
            loyalty.compute_points notification.render_itinerary; do
  check "span $span" "$(grep -qx "$span" <<<"$span_names" && echo true || echo false)"
done

for tag in search.route search.cabin search.cache_hit product.type \
           chaos.active_flags usr.id usr.tier \
           booking.id booking.pnr booking.state \
           payment.provider payment.decline_code; do
  check "tag $tag" "$(grep -qx "$tag" <<<"$tag_keys" && echo true || echo false)"
done

# The Service Map question, asked locally: a client that keeps the library's
# default name collapses every service onto one shared node.
for client in voyager-search-redis voyager-pricing-postgres voyager-pricing-redis \
              voyager-loyalty-postgres voyager-loyalty-redis voyager-loyalty-kafka; do
  check "client service $client" \
    "$(grep -qx "$client" <<<"$span_services" && echo true || echo false)"
done

# These three pass by absence, so an empty capture would pass all of them --
# the most misleading possible green. Nothing is asserted unless spans arrived.
if [[ -z $span_services ]]; then
  fail "the span sink captured nothing (the checks below cannot be trusted)"
else
  for bare in postgres redis kafka; do
    check "no unsplit '$bare' node" \
      "$(grep -qx "$bare" <<<"$span_services" && echo false || echo true)"
  done
fi

# ------------------------------------------------------------------ result --

echo
echo "  $passed passed, $failed failed"
[[ $failed -eq 0 ]]
