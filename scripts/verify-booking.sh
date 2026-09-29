#!/usr/bin/env bash
#
# Phase 4 exit criteria, as written in 03-EXECUTION-ORDER.md.
#
# Requires the dev overlay so 4010-4040 are reachable from the host:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# The hold-expiry criterion is skipped unless booking-service is running with
# a shortened TTL, because the real one is fifteen minutes:
#   HOLD_TTL_MINUTES=0 docker compose -f docker-compose.yml \
#     -f docker-compose.dev.yml up -d booking-service
#
# Same shell rule as the other verify scripts: JSON bodies are built into a
# variable first and passed as "$body".
set -uo pipefail

SEARCH=${SEARCH_URL:-http://localhost:4010}
BOOKING=${BOOKING_URL:-http://localhost:4030}
PAYMENT=${PAYMENT_URL:-http://localhost:4040}

pass=0
fail=0
skip=0

ok()      { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()     { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skipped() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; skip=$((skip + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

assert() {
  local label=$1 actual=$2 expected=$3
  if [[ "$actual" == "$expected" ]]; then ok "$label"
  else bad "$label (got '$actual', want '$expected')"; fi
}

assert_at_least() {
  local label=$1 actual=$2 floor=$3
  if [[ "$actual" =~ ^-?[0-9]+$ ]] && (( actual >= floor )); then ok "$label"
  else bad "$label (got '$actual', want >= $floor)"; fi
}

field() { python3 -c "
import json,sys
doc = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    doc = doc[int(key)] if key.isdigit() else doc.get(key)
    if doc is None: break
print('' if doc is None else doc)
" "$1" "$2" 2>/dev/null; }

day() { date -u -v+"$1"d +%Y-%m-%d 2>/dev/null || date -u -d "+$1 days" +%Y-%m-%d; }
key() { echo "verify_$(openssl rand -hex 8)"; }
psql() { docker compose exec -T postgres psql -U voyager -d voyager -tAc "$1" | tr -d '[:space:]'; }

# Runs search -> create -> hold and echoes the booking id.
new_held_booking() {
  local origin=$1 destination=$2 offset=$3
  local body search_id result_id booking_id

  body=$(printf '{"origin":"%s","destination":"%s","departDate":"%s","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}' \
    "$origin" "$destination" "$(day "$offset")")
  curl -s -X POST "$SEARCH/v1/search/flights" -H 'content-type: application/json' \
    -d "$body" > /tmp/voyager-b-search.json

  search_id=$(field /tmp/voyager-b-search.json searchId)
  result_id=$(field /tmp/voyager-b-search.json results.0.id)

  body=$(printf '{"searchId":"%s","resultId":"%s","contactEmail":"ada@example.com","passengerCounts":{"adult":1,"child":0,"infant":0}}' \
    "$search_id" "$result_id")
  curl -s -X POST "$BOOKING/v1/bookings" -H 'content-type: application/json' \
    -d "$body" > /tmp/voyager-b-create.json

  booking_id=$(field /tmp/voyager-b-create.json id)
  curl -s -X POST "$BOOKING/v1/bookings/$booking_id/hold" > /tmp/voyager-b-hold.json
  echo "$booking_id"
}

authorize() {
  local out=$1 booking_id=$2 amount=$3 card=$4 idem=$5
  local body
  body=$(printf '{"bookingId":"%s","amountCents":%s,"currency":"GBP","card":{"number":"%s","expiryMonth":12,"expiryYear":2029,"cvc":"123","holderName":"A OKONKWO"}}' \
    "$booking_id" "$amount" "$card")
  curl -s -o "$out" -w '%{http_code}' -X POST "$PAYMENT/v1/payments/authorize" \
    -H 'content-type: application/json' -H "Idempotency-Key: $idem" -d "$body"
}

# poll_state <booking_id> <target> <seconds>
poll_state() {
  local booking_id=$1 target=$2 limit=$3
  for _ in $(seq 1 "$limit"); do
    curl -s "$BOOKING/v1/bookings/$booking_id" > /tmp/voyager-b-poll.json
    [[ "$(field /tmp/voyager-b-poll.json state)" == "$target" ]] && return 0
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------------ health --

section 'Health and readiness'

assert 'booking /health' "$(curl -s -o /dev/null -w '%{http_code}' "$BOOKING/health")" 200
assert 'booking /ready'  "$(curl -s -o /dev/null -w '%{http_code}' "$BOOKING/ready")"  200
assert 'payment /health' "$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT/health")" 200
assert 'payment /ready'  "$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT/ready")"  200

section 'Kafka topics exist with three partitions each'

for topic in voyager.bookings.events voyager.payments.events \
             voyager.notifications.outbound voyager.notifications.dlq \
             voyager.loyalty.accruals voyager.search.analytics; do
  # --describe prints one summary line plus one line per partition, and both
  # start with "Topic:". Read PartitionCount off the summary rather than
  # counting lines, which is off by one.
  partitions=$(docker compose exec -T kafka sh -c \
    "KAFKA_JMX_OPTS= /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 \
     --describe --topic $topic 2>/dev/null" \
    | sed -n 's/.*PartitionCount: *\([0-9]*\).*/\1/p' | head -1 | tr -d '[:space:]')
  assert "$topic" "$partitions" 3
done

# -------------------------------------------------------------- happy path --

section 'Happy path: search, create, hold, passengers, authorize, confirm'

booking_id=$(new_held_booking LHR JFK 21)

assert 'booking starts as a draft' "$(field /tmp/voyager-b-create.json state)" DRAFT
assert 'hold succeeds'             "$(field /tmp/voyager-b-hold.json state)"   HELD
[[ -n "$(field /tmp/voyager-b-hold.json holdExpiresAt)" ]] \
  && ok 'hold carries an expiry' || bad 'hold carries an expiry'

one_adult='{"passengers":[{"passengerType":"adult","title":"Ms","firstName":"Ada","lastName":"Okonkwo","dateOfBirth":"1990-04-12","nationality":"GB"}]}'
status=$(curl -s -o /tmp/voyager-b-pax.json -w '%{http_code}' -X PUT \
  "$BOOKING/v1/bookings/$booking_id/passengers" \
  -H 'content-type: application/json' -d "$one_adult")
assert 'passengers accepted' "$status" 200

body='{"ancillaries":[{"type":"baggage","description":"Checked bag, 23kg","quantity":1}]}'
status=$(curl -s -o /tmp/voyager-b-anc.json -w '%{http_code}' -X PUT \
  "$BOOKING/v1/bookings/$booking_id/ancillaries" \
  -H 'content-type: application/json' -d "$body")
assert 'ancillaries priced' "$status" 200
assert_at_least 'a bag costs something' \
  "$(field /tmp/voyager-b-anc.json ancillariesCents)" 1

total=$(field /tmp/voyager-b-anc.json totalCents)
sums_up=$(python3 -c "
import json
doc = json.load(open('/tmp/voyager-b-anc.json'))
items = sum(i['totalPriceCents'] for i in doc['items'])
print(items + doc['taxesCents'] == doc['totalCents'])
")
assert 'items plus taxes equal the total' "$sums_up" True

good_key=$(key)
status=$(authorize /tmp/voyager-b-auth.json "$booking_id" "$total" 4242424242424242 "$good_key")
assert 'authorization accepted'    "$status" 201
assert 'payment is authorized'     "$(field /tmp/voyager-b-auth.json state)" AUTHORIZED
assert 'only the last four digits are stored' \
  "$(field /tmp/voyager-b-auth.json cardLast4)" 4242

if poll_state "$booking_id" CONFIRMED 20; then
  ok 'booking confirms via the payment-events consumer'
else
  bad "booking never confirmed (stuck in $(field /tmp/voyager-b-poll.json state))"
fi

pnr=$(field /tmp/voyager-b-poll.json pnr)
if [[ "$pnr" =~ ^[A-HJ-NP-Z2-9]{6}$ ]]; then
  ok "a PNR was issued ($pnr)"
else
  bad "PNR is missing or malformed ('$pnr')"
fi

section 'Guest lookup'

status=$(curl -s -o /tmp/voyager-b-pnr.json -w '%{http_code}' \
  "$BOOKING/v1/bookings?pnr=$pnr&lastName=okonkwo")
assert 'PNR plus surname finds the booking' "$status" 200
assert 'and it is the right one' "$(field /tmp/voyager-b-pnr.json bookings.0.pnr)" "$pnr"

status=$(curl -s -o /dev/null -w '%{http_code}' \
  "$BOOKING/v1/bookings?pnr=$pnr&lastName=someoneelse")
assert 'a PNR alone is not enough' "$status" 404

# ------------------------------------------------------------ idempotency --

section 'Idempotency'

status=$(authorize /tmp/voyager-b-replay.json "$booking_id" "$total" 4242424242424242 "$good_key")
assert 'a replay is accepted'  "$status" 201
assert 'and returns the same payment id' \
  "$(field /tmp/voyager-b-replay.json id)" "$(field /tmp/voyager-b-auth.json id)"
assert 'with no second row in the ledger' \
  "$(psql "SELECT count(*) FROM voyager.payments WHERE booking_id='$booking_id'")" 1

status=$(authorize /tmp/voyager-b-dup.json "$booking_id" 99999 4242424242424242 "$good_key")
assert 'the same key with a different body is refused' "$status" 409
assert 'with a stable error type' \
  "$(field /tmp/voyager-b-dup.json error.type)" DuplicateIdempotencyKeyError

# ---------------------------------------------------- illegal transitions --

section 'Illegal transitions return 409'

status=$(curl -s -o /tmp/voyager-b-ill.json -w '%{http_code}' -X POST \
  "$BOOKING/v1/bookings/$booking_id/hold")
assert 'a confirmed booking cannot be held again' "$status" 409
assert 'with a stable error type' \
  "$(field /tmp/voyager-b-ill.json error.type)" InvalidBookingTransitionError
assert 'and the error names what is allowed instead' \
  "$(field /tmp/voyager-b-ill.json error.details.from)" CONFIRMED

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  "$BOOKING/v1/bookings/$booking_id/passengers" \
  -H 'content-type: application/json' -d "$one_adult")
assert 'a confirmed booking cannot be edited' "$status" 409

# ------------------------------------------------- declines and cancelling --

section 'A decline is not a failure'

declined_id=$(new_held_booking LHR DXB 35)
declined_total=$(field /tmp/voyager-b-hold.json totalCents)

status=$(authorize /tmp/voyager-b-dec.json "$declined_id" "$declined_total" \
  4000000000009995 "$(key)")
assert 'a declined card still returns 201'  "$status" 201
assert 'the payment records the decline'    "$(field /tmp/voyager-b-dec.json state)" DECLINED
assert 'with the provider'"'"'s code'       "$(field /tmp/voyager-b-dec.json declineCode)" insufficient_funds

if poll_state "$declined_id" FAILED 15; then
  ok 'the booking moves to FAILED'
else
  bad "the booking did not fail (it is $(field /tmp/voyager-b-poll.json state))"
fi
[[ -n "$(field /tmp/voyager-b-poll.json holdExpiresAt)" ]] \
  && ok 'and keeps its hold, so the traveller can retry' \
  || bad 'the hold was dropped, so a retry has nothing to pay for'

status=$(authorize /tmp/voyager-b-retry.json "$declined_id" "$declined_total" \
  4242424242424242 "$(key)")
assert 'a retry with another card is accepted' "$status" 201
if poll_state "$declined_id" CONFIRMED 20; then
  ok 'and the booking confirms'
else
  bad "the retry did not confirm (it is $(field /tmp/voyager-b-poll.json state))"
fi

section 'A provider outage is not a decline'

error_id=$(new_held_booking LHR DXB 42)
error_total=$(field /tmp/voyager-b-hold.json totalCents)

status=$(authorize /tmp/voyager-b-err.json "$error_id" "$error_total" \
  4000000000000119 "$(key)")
assert 'an unreachable provider is a 502'  "$status" 502
assert 'with a distinct error type'        "$(field /tmp/voyager-b-err.json error.type)" \
  PaymentProviderError
assert 'and the payment lands in ERROR, not DECLINED' \
  "$(psql "SELECT state FROM voyager.payments WHERE booking_id='$error_id'")" ERROR
assert 'carrying no decline code' \
  "$(psql "SELECT coalesce(decline_code,'none') FROM voyager.payments WHERE booking_id='$error_id'")" \
  none

section 'Cancelling'

status=$(curl -s -o /tmp/voyager-b-cxl.json -w '%{http_code}' -X POST \
  "$BOOKING/v1/bookings/$booking_id/cancel" \
  -H 'content-type: application/json' -d '{"reason":"plans changed"}')
assert 'a confirmed booking can be cancelled' "$status" 200
assert 'and lands in CANCELLED' "$(field /tmp/voyager-b-cxl.json state)" CANCELLED
# § 15: a non-refundable fare cancels with a zero refund, not an error.
assert 'a non-refundable fare refunds nothing, without erroring' \
  "$(field /tmp/voyager-b-cxl.json refund.amountCents)" 0
assert 'and its hold is released' \
  "$(psql "SELECT count(*) FROM voyager.inventory_holds WHERE booking_id='$booking_id' AND state='active'")" \
  0

# ------------------------------------------------------------- validation --

section 'Passenger validation'

pending_id=$(new_held_booking AMS BCN 50)

reject() {
  local label=$1 payload=$2
  local code
  code=$(curl -s -o /tmp/voyager-b-val.json -w '%{http_code}' -X PUT \
    "$BOOKING/v1/bookings/$pending_id/passengers" \
    -H 'content-type: application/json' -d "$payload")
  assert "$label" "$code" 400
}

reject 'an unaccompanied infant is refused' \
  '{"passengers":[{"passengerType":"infant","firstName":"Kai","lastName":"Okonkwo","dateOfBirth":"2025-09-30","nationality":"GB"}]}'
reject 'a missing surname is refused' \
  '{"passengers":[{"passengerType":"adult","firstName":"Ada","lastName":"","dateOfBirth":"1990-04-12","nationality":"GB"}]}'
reject 'an adult born last year is refused' \
  '{"passengers":[{"passengerType":"adult","firstName":"Ada","lastName":"Okonkwo","dateOfBirth":"2025-04-12","nationality":"GB"}]}'
reject 'more passengers than were searched for is refused' \
  '{"passengers":[{"passengerType":"adult","firstName":"Ada","lastName":"Okonkwo","dateOfBirth":"1990-04-12","nationality":"GB"},{"passengerType":"adult","firstName":"Lee","lastName":"Okonkwo","dateOfBirth":"1988-01-02","nationality":"GB"}]}'

# --------------------------------------------------------------- sweeping --

section 'Hold expiry'

ttl=$(docker inspect booking-service \
  --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | grep '^HOLD_TTL_MINUTES=' | cut -d= -f2)

if [[ "${ttl:-15}" -gt 1 ]]; then
  skipped "needs a shortened TTL (HOLD_TTL_MINUTES is ${ttl:-15})"
else
  expiring_id=$(new_held_booking LHR CDG 28)
  flight_id=$(field /tmp/voyager-b-search.json results.0.segments.0.flightId)

  # Read inventory once the hold is in place, and derive what it was before
  # from the hold itself. Reading first would need the flight id, which only
  # the search result carries.
  held_seats=$(psql "SELECT seats_available FROM voyager.flights WHERE id=$flight_id")
  quantity=$(psql "SELECT quantity FROM voyager.inventory_holds WHERE booking_id='$expiring_id'")
  assert_at_least 'the hold reserved a seat' "$quantity" 1

  if poll_state "$expiring_id" EXPIRED 60; then
    ok 'the sweeper expires the hold'
  else
    bad "the hold never expired (it is $(field /tmp/voyager-b-poll.json state))"
  fi
  assert 'and the seat goes back' \
    "$(psql "SELECT seats_available FROM voyager.flights WHERE id=$flight_id")" \
    "$((held_seats + quantity))"
  assert 'with the hold marked expired' \
    "$(psql "SELECT state FROM voyager.inventory_holds WHERE booking_id='$expiring_id'")" \
    expired
fi

# ------------------------------------------------------------ containment --

section 'Containers'

for service in booking-service payment-service; do
  assert "$service is healthy" \
    "$(docker inspect --format '{{.State.Health.Status}}' "$service" 2>/dev/null)" healthy
done

# ------------------------------------------------------------------ summary --

printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skip"
(( fail == 0 )) || exit 1
