#!/usr/bin/env bash
#
# Phase 10 exit criteria for Data Streams Monitoring and the Kafka chaos paths
# (03-EXECUTION-ORDER.md phase 10, deliverables 7 and 8).
#
# Requires the dev overlay so the gateway is reachable from the host:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# The pause flag comes off on exit whatever happens. A run interrupted while
# voyager-notifications-v1 is paused leaves the demo with a consumer group that
# never drains, which is a worse state than never having run this at all.
set -uo pipefail

GATEWAY=${GATEWAY_URL:-http://localhost:4000}
ADMIN_SECRET=${ADMIN_SECRET:-$(grep -E '^ADMIN_SECRET=' .env | cut -d= -f2-)}
ADMIN_HEADER="x-voyager-admin: ${ADMIN_SECRET}"
GROUP=voyager-notifications-v1

pass=0
fail=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

assert_at_least() {
  local label=$1 actual=$2 floor=$3
  if [[ "$actual" =~ ^-?[0-9]+$ ]] && (( actual >= floor )); then
    ok "$label ($actual >= $floor)"
  else
    bad "$label (got '$actual', want >= $floor)"
  fi
}

assert_equals() {
  local label=$1 actual=$2 expected=$3
  if [[ "$actual" == "$expected" ]]; then ok "$label"
  else bad "$label (got '$actual', want '$expected')"; fi
}

# The Kafka CLI inherits the broker's JMX settings from the container
# environment and then tries to bind 9999 a second time, which fails before it
# ever reaches the broker. Blanking them is what makes these tools usable at all.
kcli() {
  docker exec -e KAFKA_JMX_OPTS= -e JMX_PORT= -e KAFKA_OPTS= kafka "$@" 2>/dev/null
}

group_lag() {
  kcli /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --group "$GROUP" --describe | awk '$6 ~ /^[0-9]+$/ {s += $6} END {print s + 0}'
}

set_flag() {
  curl -s -o /dev/null -X PUT -H "$ADMIN_HEADER" -H 'content-type: application/json' \
    -d "$1" "$GATEWAY/api/v1/admin/chaos"
}

unpause() { set_flag '{"kafka_consumer_pause":""}'; }
trap unpause EXIT INT TERM

section "Data Streams configuration"

for service in api-gateway loyalty-service booking-service payment-service \
               notification-worker search-service pricing-service ai-support-service; do
  value=$(docker exec "$service" printenv DD_DATA_STREAMS_ENABLED 2>/dev/null)
  assert_equals "$service has Data Streams enabled" "${value:-unset}" "true"
done

section "Pathway context in Kafka headers"

# Captured from live traffic rather than by publishing a synthetic message,
# because the thing under test is whether the real producers inject -- a test
# that publishes its own message proves only that the test can.
capture=$(mktemp)
kcli timeout 70 /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --whitelist 'voyager\.(bookings|payments|notifications)\..*' \
  --property print.headers=true --property print.value=false --property print.key=false \
  > "$capture" &
consumer=$!
sleep 12
./scripts/lib/drive-checkout.sh >/dev/null 2>&1
wait $consumer 2>/dev/null

captured=$(grep -c . "$capture")
# Everything below is an assertion about the messages that arrived, so with no
# messages they would all pass on an empty file -- the most misleading green
# available. Nothing is asserted unless traffic was actually seen.
if (( captured == 0 )); then
  bad "no Kafka messages were captured (the checks below cannot be trusted)"
else
  ok "captured $captured messages from live traffic"
  bare=$(grep -c 'NO_HEADERS' "$capture")
  assert_equals "every message carries headers" "$bare" "0"
  pathway=$(grep -c 'dd-pathway-ctx-base64' "$capture")
  assert_equals "every message carries the Data Streams pathway" "$pathway" "$captured"
  traced=$(grep -c 'x-datadog-trace-id' "$capture")
  assert_equals "every message carries the trace context" "$traced" "$captured"
fi
rm -f "$capture"

section "kafka_consumer_pause builds and drains real lag"

baseline=$(group_lag)
set_flag "{\"kafka_consumer_pause\":\"$GROUP\"}"
sleep 5
./scripts/lib/drive-checkout.sh >/dev/null 2>&1
sleep 20

paused_lag=$(group_lag)
assert_at_least "$GROUP accumulates lag while paused" "$((paused_lag - baseline))" 1

unpause
# Draining is the half people forget to check, and it is the half that decides
# whether the flag is reversible or just destructive.
drained=unknown
for _ in $(seq 1 12); do
  sleep 5
  current=$(group_lag)
  if (( current == 0 )); then drained=$current; break; fi
done
assert_equals "clearing the flag drains the backlog to zero" "$drained" "0"

section "Result"
printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
(( fail == 0 ))
