#!/usr/bin/env bash
#
# Contract check for the four mock third parties (phase 2 exit criteria).
#
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#   ./scripts/verify-mocks.sh
#
# The dev overlay is what publishes ports 4900-4930 to the host; without it
# nothing outside the `voyager` network can reach the mocks, which is the
# point of the base compose file.
#
# Every assertion prints PASS or FAIL; the script exits non-zero if any failed.
#
# One shell rule throughout: JSON bodies are built into a variable first and
# passed as "$body". Writing -d "{\"a\":1}" inside "$( ... )" breaks bash's
# quote parsing and silently word-splits the result, which produces assertions
# that pass without testing anything.

set -uo pipefail

GDS=${GDS_URL:-http://localhost:4900}
PAY=${PAYMENTS_URL:-http://localhost:4910}
EMAIL=${EMAIL_URL:-http://localhost:4920}
LLM=${LLM_URL:-http://localhost:4930}
REDIS=${REDIS_CONTAINER:-redis}

DEPART_DATE=$(date -u -v+14d +%Y-%m-%d 2>/dev/null || date -u -d '+14 days' +%Y-%m-%d)
CHECK_IN=$DEPART_DATE
CHECK_OUT=$(date -u -v+17d +%Y-%m-%d 2>/dev/null || date -u -d '+17 days' +%Y-%m-%d)

passes=0
failures=0

ok()      { printf '  \033[32mPASS\033[0m  %s\n' "$1"; passes=$((passes + 1)); }
bad()     { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; failures=$((failures + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert <description> <actual> <expected>
assert() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 -- got '$2', expected '$3'"; fi
}

# assert_at_least <description> <actual> <minimum>
assert_at_least() {
  if [ "${2:-x}" -ge "$3" ] 2>/dev/null; then
    ok "$1 ($2 >= $3)"
  else
    bad "$1 -- got '${2:-}', expected >= $3"
  fi
}

# json <python-expression>, reading the document from stdin as `d`
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

post()   { curl -s -X POST "$1" -H 'content-type: application/json' -d "$2"; }
status() { curl -s -o /dev/null -w '%{http_code}' -X POST "$1" -H 'content-type: application/json' -d "$2"; }

chaos_set() { docker compose exec -T "$REDIS" redis-cli HSET voyager:chaos "$1" "$2" >/dev/null; }
chaos_del() { docker compose exec -T "$REDIS" redis-cli HDEL voyager:chaos "$1" >/dev/null; sleep 3; }

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# ------------------------------------------------------------------ mock-gds --

section "mock-gds ($GDS)"

assert "GET /health" "$(curl -s "$GDS/health" | json 'd["status"]')" "ok"
assert "GET /ready reaches Postgres as the read-only role" \
  "$(curl -s "$GDS/ready" | json 'd["checks"]["postgres"]')" "ok"

flight_search='{"provider":"AMDS","origin":"LHR","destination":"JFK","departDate":"'$DEPART_DATE'","passengers":{"adults":1},"cabin":"economy"}'
availability=$(post "$GDS/gds/v2/flights/availability" "$flight_search")

assert_at_least "POST /gds/v2/flights/availability returns offers" \
  "$(printf '%s' "$availability" | json 'len(d.get("offers",[]))')" 10
assert "offers carry an invented carrier and a priced fare" \
  "$(printf '%s' "$availability" | json '"yes" if d["offers"][0]["marketingCarrier"]["code"] and d["offers"][0]["fare"]["totalAmountCents"] > 0 else "no"')" "yes"

offer_id=$(printf '%s' "$availability" | json 'd["offers"][0]["offerId"]')
flight_id=$(printf '%s' "$availability" | json 'd["offers"][0]["segments"][0]["flightId"]')

verify_body='{"provider":"AMDS","offerId":"'$offer_id'"}'
assert "POST /gds/v2/flights/verify confirms the offer is bookable" \
  "$(post "$GDS/gds/v2/flights/verify" "$verify_body" | json 'str(d["bookable"]).lower()')" "true"

assert_at_least "GET /gds/v2/seatmap/{flightId} returns rows" \
  "$(curl -s "$GDS/gds/v2/seatmap/$flight_id" | json 'len(d.get("rows",[]))')" 1

hotel_search='{"provider":"SABR","city":"London","checkIn":"'$CHECK_IN'","checkOut":"'$CHECK_OUT'","guests":2}'
assert_at_least "POST /gds/v2/hotels/availability returns properties" \
  "$(post "$GDS/gds/v2/hotels/availability" "$hotel_search" | json 'len(d.get("properties",[]))')" 1
assert "properties carry rate plans" \
  "$(post "$GDS/gds/v2/hotels/availability" "$hotel_search" | json '"yes" if d["properties"][0]["rates"] else "no"')" "yes"

assert "a request missing origin and destination is rejected" \
  "$(status "$GDS/gds/v2/flights/availability" '{"provider":"AMDS"}')" "422"

# TRVP answers in its legacy schema about 8% of the time. Sampling 60 times
# misses it roughly once in 150 runs.
trvp_search='{"provider":"TRVP","origin":"LHR","destination":"JFK","departDate":"'$DEPART_DATE'"}'
legacy_seen=no
for _ in $(seq 1 60); do
  schema=$(post "$GDS/gds/v2/flights/availability" "$trvp_search" | json 'd.get("schemaVersion","")')
  if [ "$schema" = "trvp-legacy-v1" ]; then legacy_seen=yes; break; fi
done
assert "TRVP sometimes answers in its legacy schema" "$legacy_seen" "yes"

# The quota is per provider, and TRVP's window is now full, so burst a
# provider that has not been touched yet.
drct_search='{"provider":"DRCT","origin":"LHR","destination":"JFK","departDate":"'$DEPART_DATE'"}'
limited=no
for _ in $(seq 1 70); do
  if [ "$(status "$GDS/gds/v2/flights/availability" "$drct_search")" = "429" ]; then
    limited=yes
    break
  fi
done
assert "the quota returns 429 once it is used up" "$limited" "yes"

retry_after=$(curl -s -D - -o /dev/null -X POST "$GDS/gds/v2/flights/availability" \
  -H 'content-type: application/json' -d "$drct_search" \
  | tr -d '\r' | awk 'tolower($1) == "retry-after:" { print $2 }')
assert "the 429 carries Retry-After" "$([ -n "$retry_after" ] && echo yes || echo no)" "yes"

section "mock-gds chaos -- no restart, effective within 3 s"

chaos_set gds_latency_ms 2000
chaos_set gds_latency_mode '"fixed"'
sleep 3
start=$(now_ms)
post "$GDS/gds/v2/flights/availability" "$flight_search" >/dev/null
elapsed=$(( $(now_ms) - start ))
if [ "$elapsed" -ge 2000 ]; then
  ok "gds_latency_ms=2000 slows the very next request (${elapsed} ms)"
else
  bad "gds_latency_ms=2000 did not take effect (${elapsed} ms)"
fi
chaos_del gds_latency_ms
chaos_del gds_latency_mode

chaos_set gds_error_rate 1
sleep 3
assert "gds_error_rate=1 returns 503" \
  "$(status "$GDS/gds/v2/flights/availability" "$flight_search")" "503"
chaos_del gds_error_rate

sabr_search='{"provider":"SABR","origin":"LHR","destination":"JFK","departDate":"'$DEPART_DATE'"}'
chaos_set gds_provider_down '"SABR"'
sleep 3
assert "gds_provider_down times the named provider out" \
  "$(status "$GDS/gds/v2/flights/availability" "$sabr_search")" "504"
assert "the other providers are unaffected" \
  "$(status "$GDS/gds/v2/flights/availability" "$flight_search")" "200"
chaos_del gds_provider_down

# ------------------------------------------------------------- mock-payments --

section "mock-payments ($PAY)"

assert "GET /health" "$(curl -s "$PAY/health" | json 'd["status"]')" "ok"

# charge_body <card-number> <amount>
charge_body() {
  printf '{"amount":%s,"currency":"GBP","card":{"number":"%s","exp_month":12,"exp_year":2030,"cvc":"123"},"metadata":{"booking_id":"verify"}}' "$2" "$1"
}

# charge <idempotency-key> <card-number> <amount>
charge() {
  curl -s -X POST "$PAY/v1/charges" -H 'content-type: application/json' \
    -H "Idempotency-Key: $1" -d "$(charge_body "$2" "$3")"
}

# charge_status <idempotency-key> <card-number> <amount>
charge_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$PAY/v1/charges" \
    -H 'content-type: application/json' -H "Idempotency-Key: $1" \
    -d "$(charge_body "$2" "$3")"
}

key="verify-$$-$RANDOM"
approved=$(charge "$key" 4242424242424242 41250)
assert "the always-succeeds card authorizes" "$(printf '%s' "$approved" | json 'd["status"]')" "authorized"
assert "only the last four digits come back" "$(printf '%s' "$approved" | json 'd["card"]["last4"]')" "4242"
assert "no full card number appears in the response" \
  "$(printf '%s' "$approved" | grep -c '4242424242424242')" "0"
assert "the brand is one of the invented schemes" \
  "$(printf '%s' "$approved" | json '"yes" if d["card"]["brand"] in ("meridian","cobalt","summit","orbit") else "no"')" "yes"

charge_id=$(printf '%s' "$approved" | json 'd["id"]')

assert "replaying the same key returns the same charge" \
  "$(charge "$key" 4242424242424242 41250 | json 'd["id"]')" "$charge_id"
assert "the same key with a different amount is a conflict" \
  "$(charge_status "$key" 4242424242424242 999)" "409"
assert "a charge with no idempotency key is rejected" \
  "$(status "$PAY/v1/charges" "$(charge_body 4242424242424242 100)")" "422"

assert "capture moves the charge to captured" \
  "$(post "$PAY/v1/charges/$charge_id/capture" '{}' | json 'd["status"]')" "captured"
assert "a partial refund leaves it partially refunded" \
  "$(post "$PAY/v1/charges/$charge_id/refund" '{"amount":10000}' | json 'd["status"]')" "partially_refunded"
assert "refunding the balance completes the refund" \
  "$(post "$PAY/v1/charges/$charge_id/refund" '{}' | json 'd["status"]')" "refunded"
assert "refunding beyond the balance is rejected" \
  "$(status "$PAY/v1/charges/$charge_id/refund" '{"amount":1}')" "409"

# Declines are business outcomes: HTTP 200 carrying a decline code.
for pair in 4000000000000002:card_declined \
            4000000000009995:insufficient_funds \
            4000000000000069:expired_card \
            4000000000000127:do_not_honor \
            4100000000000019:fraud_suspected; do
  number=${pair%%:*}
  expected=${pair##*:}
  assert "$number declines with $expected" \
    "$(charge "verify-$expected-$$-$RANDOM" "$number" 12345 | json 'd["decline_code"]')" "$expected"
done

assert "a decline is still an HTTP 200" \
  "$(charge_status "verify-200-$$-$RANDOM" 4000000000000002 100)" "200"
assert "the provider-error card is a 500, not a decline" \
  "$(charge_status "verify-500-$$-$RANDOM" 4000000000000119 100)" "500"

stepup=$(charge "verify-3ds-$$-$RANDOM" 4000000000003220 22000)
assert "the 3DS card asks for a step-up" "$(printf '%s' "$stepup" | json 'd["status"]')" "requires_3ds"
stepup_id=$(printf '%s' "$stepup" | json 'd["id"]')
assert "a step-up charge cannot be captured before the challenge" \
  "$(status "$PAY/v1/charges/$stepup_id/capture" '{}')" "409"
assert "completing the challenge authorizes the charge" \
  "$(post "$PAY/v1/charges/$stepup_id/3ds/complete" '{"challengeResponse":"ok"}' | json 'd["status"]')" "authorized"

failed_stepup=$(charge "verify-3ds-fail-$$-$RANDOM" 4000000000003220 22000)
failed_id=$(printf '%s' "$failed_stepup" | json 'd["id"]')
assert "a failed challenge declines the charge" \
  "$(post "$PAY/v1/charges/$failed_id/3ds/complete" '{"challengeResponse":"fail"}' | json 'd["status"]')" "declined"

section "mock-payments chaos"

chaos_set payment_decline_rate 1
chaos_set payment_decline_mix '"insufficient_funds"'
sleep 3
assert "payment_decline_rate=1 declines an otherwise good card" \
  "$(charge "verify-chaos-$$-$RANDOM" 4111111111111111 5000 | json 'd["decline_code"]')" "insufficient_funds"
chaos_del payment_decline_rate
chaos_del payment_decline_mix

chaos_set payment_error_rate 1
sleep 3
assert "payment_error_rate=1 is a 500, not a decline" \
  "$(charge_status "verify-chaos-err-$$-$RANDOM" 4111111111111111 5000)" "500"
chaos_del payment_error_rate

# ---------------------------------------------------------------- mock-email --

section "mock-email ($EMAIL)"

curl -s -o /dev/null -X DELETE "$EMAIL/outbox"
assert "GET /health" "$(curl -s "$EMAIL/health" | json 'd["status"]')" "ok"

confirmation='{"to":"traveller@voyager.demo","subject":"Your booking is confirmed","template":"booking_confirmed","body":"Your reference is KD7R2M."}'
assert "POST /v1/send accepts a well-formed message" \
  "$(status "$EMAIL/v1/send" "$confirmation")" "202"
assert_at_least "the message lands in the outbox" \
  "$(curl -s "$EMAIL/outbox?limit=10" | json 'd["count"]')" 1
assert "the outbox can be filtered by template" \
  "$(curl -s "$EMAIL/outbox?template=booking_confirmed" | json 'd["messages"][0]["subject"]')" "Your booking is confirmed"
assert "a message with no recipient is rejected with 422" \
  "$(status "$EMAIL/v1/send" '{"subject":"x","body":"y"}')" "422"
assert "a message with a malformed address is rejected with 422" \
  "$(status "$EMAIL/v1/send" '{"to":"not-an-address","subject":"x","body":"y"}')" "422"

chaos_set email_failure_rate 1
sleep 3
assert "email_failure_rate=1 rejects a valid message with 422" \
  "$(status "$EMAIL/v1/send" "$confirmation")" "422"
chaos_del email_failure_rate

curl -s -o /dev/null -X DELETE "$EMAIL/outbox"
assert "DELETE /outbox empties it" "$(curl -s "$EMAIL/outbox" | json 'd["count"]')" "0"

# ------------------------------------------------------------------ mock-llm --

section "mock-llm ($LLM)"

tools='[{"type":"function","function":{"name":"lookup_booking","description":"Look up a booking by reference","parameters":{"type":"object","properties":{"pnr":{"type":"string"},"lastName":{"type":"string"}}}}}]'
lookup_request='{"model":"voyager-support-v1","messages":[{"role":"user","content":"Where is my booking KD7R2M, last name Whitfield?"}],"tools":'$tools'}'
prose_request='{"messages":[{"role":"user","content":"What is the baggage allowance on my ticket?"}]}'

assert "GET /v1/models lists the model" \
  "$(curl -s "$LLM/v1/models" | json 'd["data"][0]["id"]')" "voyager-support-v1"

completion=$(post "$LLM/v1/chat/completions" "$lookup_request")
assert "a booking question produces a tool call" \
  "$(printf '%s' "$completion" | json 'd["choices"][0]["message"]["tool_calls"][0]["function"]["name"]')" "lookup_booking"
assert "the tool arguments are valid JSON carrying the PNR" \
  "$(printf '%s' "$completion" | json 'json.loads(d["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"])["pnr"]')" "KD7R2M"
assert "finish_reason is tool_calls" \
  "$(printf '%s' "$completion" | json 'd["choices"][0]["finish_reason"]')" "tool_calls"
assert "content is null when a tool is called" \
  "$(printf '%s' "$completion" | json 'str(d["choices"][0]["message"]["content"])')" "None"
assert_at_least "prompt tokens scale with the input and the tool schema" \
  "$(printf '%s' "$completion" | json 'd["usage"]["prompt_tokens"]')" 40
assert "total tokens add up" \
  "$(printf '%s' "$completion" | json '"yes" if d["usage"]["total_tokens"] == d["usage"]["prompt_tokens"] + d["usage"]["completion_tokens"] else "no"')" "yes"

assert "a question with no tools offered gets prose" \
  "$(post "$LLM/v1/chat/completions" "$prose_request" | json '"yes" if d["choices"][0]["message"]["content"] else "no"')" "yes"
assert "an empty message list is rejected" \
  "$(status "$LLM/v1/chat/completions" '{"messages":[]}')" "422"

stream=$(curl -s -N -X POST "$LLM/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"What is the baggage allowance on my ticket?"}]}')
assert "the stream terminates with [DONE]" "$(printf '%s' "$stream" | grep -c 'data: \[DONE\]')" "1"
assert_at_least "the stream delivers several content deltas" \
  "$(printf '%s' "$stream" | grep -c '"content"')" 3
assert "the stream reports usage" "$(printf '%s' "$stream" | grep -c '"usage"')" "1"

stream_tools_request='{"stream":true,"messages":[{"role":"user","content":"Look up booking KD7R2M"}],"tools":'$tools'}'
stream_tools=$(curl -s -N -X POST "$LLM/v1/chat/completions" -H 'content-type: application/json' -d "$stream_tools_request")
assert "a streamed tool call is well formed" \
  "$(printf '%s' "$stream_tools" | grep -c '"function":{"name":"lookup_booking"')" "1"
assert "the streamed tool call finishes with tool_calls" \
  "$(printf '%s' "$stream_tools" | grep -c '"finish_reason":"tool_calls"')" "1"

# A tool result in the history means the next turn is the final answer, which
# is the two-call shape ai-support-service will build its spans around.
followup_request='{"messages":[{"role":"user","content":"Look up booking KD7R2M"},{"role":"assistant","content":null},{"role":"tool","tool_call_id":"call_1","content":"{\"pnr\":\"KD7R2M\",\"status\":\"CONFIRMED\"}"}],"tools":'$tools'}'
assert "a turn following a tool result answers in prose" \
  "$(post "$LLM/v1/chat/completions" "$followup_request" | json '"yes" if d["choices"][0]["message"]["content"] else "no"')" "yes"

section "mock-llm chaos"

chaos_set llm_degrade_tools true
sleep 3
assert "llm_degrade_tools returns prose where a tool call belongs" \
  "$(post "$LLM/v1/chat/completions" "$lookup_request" | json '"no" if d["choices"][0]["message"].get("tool_calls") else "yes"')" "yes"
chaos_del llm_degrade_tools

chaos_set llm_hallucinate true
sleep 3
assert "llm_hallucinate invents an itinerary" \
  "$(post "$LLM/v1/chat/completions" "$lookup_request" | json '"yes" if "booking reference" in (d["choices"][0]["message"]["content"] or "") else "no"')" "yes"
chaos_del llm_hallucinate

chaos_set llm_error_rate 1
sleep 3
assert "llm_error_rate=1 returns 500" \
  "$(status "$LLM/v1/chat/completions" "$prose_request")" "500"
chaos_del llm_error_rate

chaos_set llm_latency_ms 2000
sleep 3
start=$(now_ms)
post "$LLM/v1/chat/completions" "$prose_request" >/dev/null
elapsed=$(( $(now_ms) - start ))
if [ "$elapsed" -ge 2000 ]; then
  ok "llm_latency_ms=2000 delays the first token (${elapsed} ms)"
else
  bad "llm_latency_ms=2000 did not take effect (${elapsed} ms)"
fi
chaos_del llm_latency_ms

# ------------------------------------------------------------------ summary --

section "summary"
printf '  %d passed, %d failed\n\n' "$passes" "$failures"
[ "$failures" -eq 0 ]
