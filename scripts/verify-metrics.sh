#!/usr/bin/env bash
#
# Phase 10 deliverable 10, as assertions: the thirty business metrics defined in
# 05-FUNCTIONALITY.md § 14.
#
# The exit criterion is written as "queryable in the metrics explorer", which
# needs a valid Datadog application key. There is not a working one on this
# machine, so this asserts the last point on this side of the wire instead:
# `agent dogstatsd-stats`, which lists the metrics the Agent has actually
# received, by name and by tag set. A name that appears there has been built by
# a service, serialised, sent over UDP and parsed by the Agent. What is left
# after that is Datadog's own delivery.
#
# Three things this deliberately does not do:
#
#   It does not trust ambient traffic. loadgen-api and loadgen-browser drive a
#   full funnel continuously, so almost every metric below would appear without
#   a single request from this script. Both are stopped for the duration and the
#   Agent is restarted first, which clears its stats, so every count here is
#   traffic this script caused.
#
#   It does not assert anything by absence before proving the capture is not
#   empty. The cardinality checks at the end are the dangerous ones: they look
#   for identifiers in tag values, so nothing received at all passes every one
#   of them, which is the most misleading green there is.
#
#   It does not accept a bare metric name as proof. § 14 specifies the tags too,
#   and a metric with the wrong tag keys is not queryable in the way the
#   dashboards in datadog/dashboards query it, so the required tag keys are
#   asserted alongside each name.
#
# Requires the dev overlay for the host ports:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# It writes real data: four bookings, four card authorisations, a support
# conversation. It also ages one hold and one cart directly in Postgres and
# Redis rather than waiting fifteen minutes for them to expire on their own --
# that simulates the passage of time, not the metric, which is still emitted by
# the service's own sweeper.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

env_value() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

GATEWAY=${GATEWAY_URL:-http://127.0.0.1:4000}
ADMIN_SECRET=${ADMIN_SECRET:-$(env_value ADMIN_SECRET)}
ADMIN_HEADER="x-voyager-admin: ${ADMIN_SECRET}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)

STATS=/tmp/voyager-dogstatsd-stats.txt
OUT=/tmp/voyager-metrics

# The deterministic test cards from mocks/mock-payments/src/cards.ts. The error
# card is used rather than `payment_error_rate`, which is the same failure by a
# less certain route: a probabilistic flag has to be set, propagated through two
# chaos caches and then win a coin toss, and a run where it loses is a failure
# that looks like missing instrumentation.
GOOD_CARD=4242424242424242
DECLINED_CARD=4000000000009995
ERROR_CARD=4000000000000119

# One point under the 25,000 silver threshold (loyalty-service/src/points.ts), so
# the next booking crosses it however few points that fare earns. A gap of a
# couple of hundred assumed every fare earned that much; a short-haul fare
# earns under a hundred and never leaves standard. Set after the first accrual
# has created the row.
JUST_UNDER_SILVER=24999

LOADGEN=(loadgen-api loadgen-browser)

passed=0
failed=0

pass() { printf '  ok    %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; failed=$((failed + 1)); }
note() { printf '  --    %s\n' "$1"; }
section() { printf '\n%s\n' "$1"; }

check() {
  local label=$1 condition=$2
  if [[ $condition == true ]]; then pass "$label"; else fail "$label"; fi
}

# ------------------------------------------------------------------- setup --

if ! docker ps --format '{{.Names}}' | grep -qx datadog-agent; then
  echo "datadog-agent is not running -- start the stack first" >&2
  exit 1
fi

# Only the generators that were actually running are restarted, so a run on a
# stack started without the loadgen overlay does not leave two stopped
# containers behind that were never part of it. A string rather than an array
# because bash 3.2, which is what macOS ships, treats an empty array as unbound
# under `set -u` and would abort here on exactly that stack.
stopped_loadgens=""
for generator in "${LOADGEN[@]}"; do
  if docker ps --format '{{.Names}}' | grep -qx "$generator"; then
    stopped_loadgens+="$generator "
  fi
done

set_flags() {
  curl -sS -o /dev/null -X PUT -H "$ADMIN_HEADER" -H 'content-type: application/json' \
    -d "$1" "$GATEWAY/api/v1/admin/chaos"
  # The chaos snapshot is cached for two seconds in every service.
  sleep 3
}

reset_flags() {
  curl -sS -o /dev/null -X POST -H "$ADMIN_HEADER" "$GATEWAY/api/v1/admin/chaos/reset"
}

cleanup() {
  reset_flags
  for generator in $stopped_loadgens; do
    docker start "$generator" >/dev/null 2>&1
  done
}
trap cleanup EXIT INT TERM

for generator in $stopped_loadgens; do
  docker stop "$generator" >/dev/null 2>&1
done
reset_flags

section "Agent is able to report what it receives"

# Restarted for a clean slate: dogstatsd-stats accumulates for the Agent's
# lifetime, so without this every assertion below could be satisfied by traffic
# from before this script ran.
docker restart datadog-agent >/dev/null 2>&1
for _ in $(seq 1 60); do
  docker exec datadog-agent agent dogstatsd-stats >/dev/null 2>&1 && break
  sleep 2
done

if ! docker exec datadog-agent agent dogstatsd-stats >/dev/null 2>&1; then
  fail "agent dogstatsd-stats is available (dogstatsd_metrics_stats_enable in infra/datadog/datadog.yaml)"
  echo
  echo "  $passed passed, $failed failed"
  exit 1
fi
pass "agent dogstatsd-stats is available"

# Checked again at the end. Anything that restarts the Agent mid-run empties the
# stats store, and the result reads exactly like instrumentation that never
# fired -- which is what happened on the run this guard was written for.
# `docker restart` can return while StartedAt still names the previous process.
# Reading it in that window makes this guard fail on the script's own restart.
sleep 2
agent_started=$(docker inspect -f '{{.State.StartedAt}}' datadog-agent 2>/dev/null)

: >"$STATS"

# Appended rather than overwritten, once per phase. The Agent's stats store is
# bounded, and a single capture at the end of a six-minute run can have dropped
# what the first phase proved.
capture_stats() {
  # Flush windows: the Go and Python clients send immediately, the Node client
  # every ten seconds, and the Agent aggregates on its own ten-second tick.
  sleep 12
  docker exec datadog-agent agent dogstatsd-stats 2>/dev/null >>"$STATS"
}

# The same, for a metric that arrives later than the phase that triggered it. A
# confirmation email is produced by one consumer and delivered by another, and
# this stack's notification worker runs tens of seconds behind whenever anything
# has queued up, so a fixed wait reports a lagging consumer as an absent metric.
capture_until() {
  local name=$1 deadline=$(( $(date +%s) + ${2:-120} ))
  while :; do
    capture_stats
    grep -qF "$name " "$STATS" && return 0
    (( $(date +%s) >= deadline )) && return 1
  done
}

field() { python3 -c "
import json, sys
doc = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    if isinstance(doc, list):
        doc = doc[int(key)] if key.isdigit() and int(key) < len(doc) else None
    elif isinstance(doc, dict):
        doc = doc.get(key)
    else:
        doc = None
print(doc if doc is not None else '')
" "$1" "$2" 2>/dev/null; }

psql_do() {
  docker exec postgres psql -U "${POSTGRES_USER:-voyager}" -d "${POSTGRES_DB:-voyager}" \
    -At -c "$1" 2>/dev/null | tr -d '\r'
}

redis_do() { docker exec redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }

future_date() {
  date -v+"$((RANDOM % 200 + 30))"d +%Y-%m-%d 2>/dev/null \
    || date -d "+$((RANDOM % 200 + 30)) days" +%Y-%m-%d
}

# --------------------------------------------------------------- the driver --

# One traveller for the whole run. A tier upgrade needs two bookings by the same
# person, and a fresh signup per booking would never accumulate the points.
EMAIL="metrics-$(date +%s%N)@example.com"
PASSWORD=correct-horse-battery
ACCESS=""
USER_ID=""

signup() {
  curl -sS -o "$OUT-signup.json" -X POST "$GATEWAY/api/v1/auth/signup" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"firstName\":\"Mira\",\"lastName\":\"Metric\"}"
  ACCESS=$(field "$OUT-signup.json" accessToken)
  USER_ID=$(field "$OUT-signup.json" user.id)
}

# Searches, returning "<searchId> <resultId>" for whatever it found.
search_flights() {
  local origin=$1 destination=$2 depart=$3
  curl -sS -o "$OUT-search.json" -X POST "$GATEWAY/api/v1/search/flights" \
    -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
    -d "{\"origin\":\"$origin\",\"destination\":\"$destination\",\"departDate\":\"$depart\",\"passengers\":{\"adults\":1,\"children\":0,\"infants\":0},\"cabin\":\"economy\"}"
  printf '%s %s' "$(field "$OUT-search.json" searchId)" "$(field "$OUT-search.json" results.0.id)"
}

# A draft, a hold and a named passenger: the state a cart is in when the
# traveller reaches the payment screen. Echoes "<bookingId> <totalCents>".
open_cart() {
  local depart search_id result_id booking_id total
  depart=$(future_date)
  read -r search_id result_id <<<"$(search_flights LHR JFK "$depart")"
  [[ -z $result_id ]] && return 1

  curl -sS -o "$OUT-checkout.json" -X POST "$GATEWAY/api/v1/bff/checkout/init" \
    -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
    -d "{\"searchId\":\"$search_id\",\"resultId\":\"$result_id\",\"contactEmail\":\"$EMAIL\",\"passengerCounts\":{\"adult\":1,\"child\":0,\"infant\":0}}"
  booking_id=$(field "$OUT-checkout.json" booking.id)
  [[ -z $booking_id ]] && return 1

  curl -sS -o "$OUT-pax.json" -X PUT "$GATEWAY/api/v1/bookings/$booking_id/passengers" \
    -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
    -d '{"passengers":[{"passengerType":"adult","title":"Ms","firstName":"Mira","lastName":"Metric","dateOfBirth":"1988-03-02","nationality":"GB"}]}'

  total=$(field "$OUT-pax.json" totalCents)
  [[ -z $total ]] && total=$(field "$OUT-checkout.json" booking.totalCents)
  printf '%s %s' "$booking_id" "$total"
}

# `Idempotency-Key` is echoed back so a caller can replay the same request.
authorize() {
  local booking_id=$1 total=$2 card=$3 key=$4
  curl -sS -o "$OUT-auth.json" -X POST "$GATEWAY/api/v1/payments/authorize" \
    -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
    -H "Idempotency-Key: $key" \
    -d "{\"bookingId\":\"$booking_id\",\"amountCents\":$total,\"currency\":\"GBP\",\"card\":{\"number\":\"$card\",\"expiryMonth\":12,\"expiryYear\":2029,\"cvc\":\"123\",\"holderName\":\"Mira Metric\"}}"
}

# Confirmation is asynchronous: payment-service emits, booking-service consumes.
await_pnr() {
  local booking_id=$1
  for _ in $(seq 1 30); do
    curl -sS -o "$OUT-booking.json" "$GATEWAY/api/v1/bff/booking/$booking_id" \
      -H "authorization: Bearer $ACCESS"
    if [[ $(field "$OUT-booking.json" booking.state) == CONFIRMED ]]; then
      field "$OUT-booking.json" booking.pnr
      return 0
    fi
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------------ search --

section "Driving search-service"

signup
if [[ -z $ACCESS ]]; then
  fail "signed a traveller up (nothing below can run without one)"
  echo
  echo "  $passed passed, $failed failed"
  exit 1
fi
pass "signed a traveller up"

# A date nobody has searched for, then the identical request again: the first is
# a cold fan-out across four providers, the second is a cache hit, and
# cache_hit is a tag on both search metrics.
cold_date=$(future_date)
search_flights LHR JFK "$cold_date" >/dev/null
search_flights LHR JFK "$cold_date" >/dev/null

# Hotels, so `product` has both of its values.
curl -sS -o /dev/null -X POST "$GATEWAY/api/v1/search/hotels" \
  -H 'content-type: application/json' \
  -d "{\"city\":\"PAR\",\"checkIn\":\"$(future_date)\",\"nights\":2,\"guests\":2,\"rooms\":1}"

# One provider that always times out: three of four answer, which is both a
# provider error and a partial result.
#
# Re-asserted on every attempt and checked against the response rather than set
# once and trusted. The flag lives in a Redis hash that the admin API, chaos.sh
# and every other verification script can clear, so a search that ran a moment
# after somebody else's reset comes back complete -- and would then read as
# missing instrumentation when what was missing was the injection.
partial_seen=false
for _ in 1 2 3; do
  set_flags '{"gds_provider_down":"SABR"}'
  search_flights LHR JFK "$(future_date)" >/dev/null
  queried=$(field "$OUT-search.json" providersQueried)
  responded=$(field "$OUT-search.json" providersResponded)
  if [[ $responded =~ ^[0-9]+$ && $queried =~ ^[0-9]+$ ]] && ((responded < queried)); then
    partial_seen=true
    break
  fi
done
check "one provider driven down ($responded of $queried answered)" "$partial_seen"
reset_flags

capture_stats

# ---------------------------------------------------- checkout and payment --

section "Driving booking-service, pricing-service, payment-service, loyalty-service"

read -r booking_id total <<<"$(open_cart)"
if [[ -z ${booking_id:-} ]]; then
  fail "opened a cart (the booking and payment metrics cannot be driven without one)"
else
  pass "opened a cart"
  authorize "$booking_id" "$total" "$GOOD_CARD" "metrics-$(date +%s%N)"
  pnr=$(await_pnr "$booking_id")
  check "first booking confirmed" "$([[ -n ${pnr:-} ]] && echo true || echo false)"
fi

# A replay of one authorisation: same key, same body, served from the
# idempotency record rather than charged again.
read -r replay_booking replay_total <<<"$(open_cart)"
if [[ -n ${replay_booking:-} ]]; then
  replay_key="metrics-replay-$(date +%s%N)"
  authorize "$replay_booking" "$replay_total" "$GOOD_CARD" "$replay_key"
  authorize "$replay_booking" "$replay_total" "$GOOD_CARD" "$replay_key"
  await_pnr "$replay_booking" >/dev/null
fi

# A refused card, which is a declined payment and then a failed booking.
read -r declined_booking declined_total <<<"$(open_cart)"
if [[ -n ${declined_booking:-} ]]; then
  authorize "$declined_booking" "$declined_total" "$DECLINED_CARD" "metrics-$(date +%s%N)"
fi

capture_stats

section "Driving the tier upgrade"

# The accrual from the first booking created the account row; this puts it just
# below the silver threshold so the next one crosses it. Done in the database
# because there is no API for granting points, and buying 25,000 points' worth
# of flights would take forty bookings.
if [[ -n $USER_ID ]]; then
  updated=$(psql_do "UPDATE voyager.loyalty_accounts
                     SET lifetime_points = $JUST_UNDER_SILVER, tier = 'standard'
                     WHERE user_id = '$USER_ID' RETURNING user_id")
  check "traveller parked just below silver" \
    "$([[ -n $updated ]] && echo true || echo false)"

  read -r upgrade_booking upgrade_total <<<"$(open_cart)"
  if [[ -n ${upgrade_booking:-} ]]; then
    authorize "$upgrade_booking" "$upgrade_total" "$GOOD_CARD" "metrics-$(date +%s%N)"
    await_pnr "$upgrade_booking" >/dev/null
  fi
fi

capture_stats

# The worker delivers tens of seconds behind the booking. Arming the rejection
# flag while those receipts are still queued dead-letters every one of them,
# and voyager.notifications.sent never fires.
note "waiting for a confirmation email to be accepted"
if ! capture_until voyager.notifications.sent 150; then
  fail "confirmation email accepted before the rejection flag is armed"
fi

# ------------------------------------------------- provider and DLQ errors --

section "Driving the provider-error and dead-letter paths"

# The error card makes mock-payments answer 500, which is our fault rather than
# the customer's: a PaymentProviderError, not a decline. § 13.3 keeps the two
# apart and so do the metrics.
read -r error_booking error_total <<<"$(open_cart)"
if [[ -n ${error_booking:-} ]]; then
  authorize "$error_booking" "$error_total" "$ERROR_CARD" "metrics-$(date +%s%N)"
fi

# `email_failure_rate` makes mock-email answer 422, which is permanent, so the
# confirmation email dead-letters on the first attempt instead of after three.
read -r dlq_booking dlq_total <<<"$(open_cart)"
if [[ -n ${dlq_booking:-} ]]; then
  set_flags '{"email_failure_rate":1}'
  # Read back rather than assumed. The chaos hash is shared and this stack has
  # more than one thing resetting it, and a run that loses that race reports a
  # missing metric when what it actually had was a missing flag.
  if [[ -z $(redis_do HGET voyager:chaos email_failure_rate) ]]; then
    fail "email_failure_rate armed (the DLQ counter cannot be driven without it)"
  else
    pass "email_failure_rate armed"
  fi

  authorize "$dlq_booking" "$dlq_total" "$GOOD_CARD" "metrics-$(date +%s%N)"
  await_pnr "$dlq_booking" >/dev/null
  # The PNR means the confirmation was published, not that mock-email has
  # answered it. The flag therefore stays set until the metric has arrived:
  # clearing it on the PNR lets the worker deliver the message after all, and
  # a fixed wait instead of this one is what an earlier run failed on.
  note "waiting for the confirmation email to be rejected"
  capture_until voyager.notifications.dlq 150
  reset_flags
else
  capture_stats
fi

# ------------------------------------------------------- holds and carts --

section "Driving hold expiry and cart abandonment"

# One cart is left unpaid, and both its clocks are wound forward rather than
# waited out: the hold is fifteen minutes and the cart sweep follows it.
# Neither metric is emitted here -- booking-service's sweeper emits one and the
# gateway's sweeper emits the other, both on their own schedule.
read -r abandoned_booking _ <<<"$(open_cart)"
if [[ -z ${abandoned_booking:-} ]]; then
  fail "opened a cart to abandon"
else
  pass "opened a cart to abandon"
  psql_do "UPDATE voyager.bookings SET hold_expires_at = now() - interval '1 minute'
           WHERE id = '$abandoned_booking'" >/dev/null
  # The gateway's schedule is a sorted set scored by the hold expiry.
  redis_do ZADD voyager:carts "$(( ($(date +%s) - 60) * 1000 ))" "$abandoned_booking" >/dev/null

  # booking-service sweeps every 30 s, the gateway every 15 s.
  note "waiting for the two sweepers"
  sleep 40
fi

capture_stats

# ---------------------------------------------------------------- support --

section "Driving ai-support-service"

curl -sS -o "$OUT-conv.json" -X POST "$GATEWAY/api/v1/support/conversations" \
  -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
  -d '{}'
conversation_id=$(field "$OUT-conv.json" conversationId)

if [[ -z $conversation_id ]]; then
  fail "opened a support conversation"
else
  pass "opened a support conversation"
  say() {
    curl -sS -o /dev/null -X POST \
      "$GATEWAY/api/v1/support/conversations/$conversation_id/messages" \
      -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
      -H 'accept: text/event-stream' -d "{\"content\":$1}"
  }

  # A real booking reference, so the tool call returns `ok` rather than
  # `not_found`. The PNR goes in the message, never in a tag.
  if [[ -n ${pnr:-} ]]; then
    say "\"Can you look up my booking $pnr, last name Metric?\""
  else
    say '"What is the baggage allowance on my flight?"'
  fi
  # Asking for a person is what selects `escalate_to_human`.
  say '"This is not helping, I want to speak to a human."'
fi

capture_stats

# Sweepers and the Node client flush on their own clocks. A hold that expires
# during the support conversation is not in the snapshot taken immediately
# afterwards, so the assertions wait out one more interval and look again.
note "waiting for late sweepers to flush"
sleep 20
capture_stats

# ------------------------------------------------------------ assertions --

section "§ 14 metrics received by the Agent"

if [[ ! -s $STATS ]]; then
  fail "agent dogstatsd-stats returned nothing at all"
  echo
  echo "  $passed passed, $failed failed"
  exit 1
fi

if [[ $(docker inspect -f '{{.State.StartedAt}}' datadog-agent 2>/dev/null) == "$agent_started" ]]; then
  pass "the Agent was not restarted mid-run"
else
  fail "the Agent was not restarted mid-run (its stats store was emptied; rerun)"
fi

# One line per metric per tag set: "name | tags | count | last seen".
lines_for() { grep -E "^$1[[:space:]]" "$STATS"; }

# A name and every tag key § 14 requires on it. The tag keys matter as much as
# the name: `datadog/dashboards` groups by them, and a metric missing one is
# present but not answerable.
metric() {
  local name=$1
  shift
  local found
  found=$(lines_for "$name")
  if [[ -z $found ]]; then
    fail "$name"
    return
  fi
  local missing=()
  for key in "$@"; do
    grep -qF -- "${key}:" <<<"$found" || missing+=("$key")
  done
  if ((${#missing[@]})); then
    fail "$name (no ${missing[*]} tag)"
  else
    pass "$name"
  fi
}

metric voyager.search.requests product origin destination cabin cache_hit
metric voyager.search.results_count product cache_hit
metric voyager.search.provider_latency provider
metric voyager.search.provider_errors provider error_kind
metric voyager.search.partial_results providers_responded

metric voyager.pricing.rules_evaluated hot_path

metric voyager.booking.created product tier
metric voyager.booking.confirmed product tier currency
metric voyager.booking.failed product failure_reason
metric voyager.booking.revenue_cents product currency tier
metric voyager.booking.time_to_confirm_ms product
metric voyager.hold.created resource_type
metric voyager.hold.expired resource_type
metric voyager.hold.lock_wait_ms resource_type

metric voyager.payment.authorized provider card_brand
metric voyager.payment.declined provider decline_code
metric voyager.payment.errors provider error_kind
metric voyager.payment.idempotency_replays endpoint
metric voyager.payment.provider_latency_ms provider operation

metric voyager.loyalty.points_accrued tier product
metric voyager.loyalty.tier_upgrades from_tier to_tier

metric voyager.notifications.sent template
metric voyager.notifications.dlq template failure_reason
metric voyager.notifications.lag_seconds consumer_group

metric voyager.support.conversations intent
metric voyager.support.tool_calls tool outcome
metric voyager.support.tokens direction model
metric voyager.support.escalations intent

metric voyager.cart.abandoned step product
metric voyager.chaos.flags_active

section "Every metric carries env, service and version"

# Unified service tagging. Without these a metric is unusable next to the
# traces and logs it belongs with, and none of the dashboards' $env template
# variables filter it.
for tag in env service version; do
  total=$(grep -cE '^voyager\.' "$STATS")
  tagged=$(grep -E '^voyager\.' "$STATS" | grep -cF "${tag}:")
  check "$tag on all $total voyager.* lines" \
    "$([[ $total -gt 0 && $total -eq $tagged ]] && echo true || echo false)"
done

section "Tag cardinality"

# These pass by absence, so an empty capture would pass all of them. Guarded
# explicitly: the failure mode is a green run that proved nothing.
voyager_lines=$(grep -E '^voyager\.' "$STATS")
if [[ -z $voyager_lines ]]; then
  fail "no voyager.* metric reached the Agent (the cardinality checks cannot be trusted)"
else
  check "no UUID in any tag value" \
    "$(grep -qE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' <<<"$voyager_lines" \
      && echo false || echo true)"
  # Six characters from the PNR alphabet, which excludes 0, 1, I and O.
  check "no PNR-shaped tag value" \
    "$(grep -qE ':[A-HJ-NP-Z2-9]{6}(\b|$)' <<<"$voyager_lines" && echo false || echo true)"
  check "no email address in any tag value" \
    "$(grep -qE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' <<<"$voyager_lines" && echo false || echo true)"
  # A card number, a phone number, or an epoch in nanoseconds. Nothing in § 14
  # legitimately tags with a long run of digits.
  check "no long digit run in any tag value" \
    "$(grep -qE ':[0-9]{10,}' <<<"$voyager_lines" && echo false || echo true)"
fi

section "No metric outside § 14"

# § 14 is the contract. A `voyager.*` name that is not in it is either a typo of
# one that is -- in which case the real one is short of data and nothing says so
# -- or an invented metric that belongs in the spec first.
expected=$(cat <<'NAMES'
voyager.search.requests
voyager.search.results_count
voyager.search.provider_latency
voyager.search.provider_errors
voyager.search.partial_results
voyager.pricing.rules_evaluated
voyager.booking.created
voyager.booking.confirmed
voyager.booking.failed
voyager.booking.revenue_cents
voyager.booking.time_to_confirm_ms
voyager.hold.created
voyager.hold.expired
voyager.hold.lock_wait_ms
voyager.payment.authorized
voyager.payment.declined
voyager.payment.errors
voyager.payment.idempotency_replays
voyager.payment.provider_latency_ms
voyager.loyalty.points_accrued
voyager.loyalty.tier_upgrades
voyager.notifications.sent
voyager.notifications.dlq
voyager.notifications.lag_seconds
voyager.support.conversations
voyager.support.tool_calls
voyager.support.tokens
voyager.support.escalations
voyager.cart.abandoned
voyager.chaos.flags_active
NAMES
)

received=$(awk -F'|' '/^voyager\./ {gsub(/[ \t]+$/, "", $1); print $1}' "$STATS" | sort -u)
unexpected=$(comm -23 <(sort <<<"$received") <(sort <<<"$expected"))
if [[ -n $unexpected ]]; then
  while read -r name; do fail "$name is not in § 14"; done <<<"$unexpected"
else
  pass "every voyager.* metric received is one of the thirty in § 14"
fi

# ------------------------------------------------------------------ result --

echo
echo "  full capture: $STATS"
echo "  $passed passed, $failed failed"
[[ $failed -eq 0 ]]
