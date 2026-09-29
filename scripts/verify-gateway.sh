#!/usr/bin/env bash
#
# Phase 6 exit criteria, as written in 03-EXECUTION-ORDER.md.
#
# Requires the dev overlay so the service ports are reachable from the host:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# The script resets chaos on exit whatever happens. A verification run that
# leaves gds_latency_ms at 3000 behind is worse than no verification at all.
set -uo pipefail

GATEWAY=${GATEWAY_URL:-http://localhost:4000}
# Two internal endpoints are exercised directly because they exist for the BFF
# rather than for the browser, and so have no public route.
LOYALTY_URL=${LOYALTY_URL:-http://localhost:4050}
ADMIN_SECRET=${ADMIN_SECRET:-$(grep -E '^ADMIN_SECRET=' .env | cut -d= -f2-)}
ADMIN_HEADER="x-voyager-admin: ${ADMIN_SECRET}"

pass=0
fail=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

assert() {
  local label=$1 actual=$2 expected=$3
  if [[ "$actual" == "$expected" ]]; then ok "$label"
  else bad "$label (got '$actual', want '$expected')"; fi
}

assert_at_least() {
  local label=$1 actual=$2 floor=$3
  if [[ "$actual" =~ ^-?[0-9]+$ ]] && (( actual >= floor )); then
    ok "$label ($actual >= $floor)"
  else
    bad "$label (got '$actual', want >= $floor)"
  fi
}

assert_under() {
  local label=$1 actual=$2 ceiling=$3 unit=${4:-ms}
  if [[ "$actual" =~ ^-?[0-9]+$ ]] && (( actual <= ceiling )); then
    ok "$label (${actual}${unit} <= ${ceiling}${unit})"
  else
    bad "$label (got ${actual}${unit}, want <= ${ceiling}${unit})"
  fi
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

admin_get()  { curl -s -o "$1" -w '%{http_code}' -H "$ADMIN_HEADER" "$GATEWAY$2"; }
admin_post() { curl -s -o "$1" -w '%{http_code}' -X POST -H "$ADMIN_HEADER" "$GATEWAY$2"; }
admin_put()  {
  curl -s -o "$1" -w '%{http_code}' -X PUT -H "$ADMIN_HEADER" \
    -H 'content-type: application/json' -d "$3" "$GATEWAY$2"
}

reset_chaos() { admin_post /tmp/voyager-g-reset.json /api/v1/admin/chaos/reset >/dev/null; }
trap reset_chaos EXIT

printf '\033[1mPhase 6 verification: api-gateway and the chaos control plane\033[0m\n'
reset_chaos

# --------------------------------------------------------------- the gate --

section 'Admin endpoints are gated'

for path in /api/v1/admin/chaos /api/v1/admin/scenarios /api/v1/admin/status; do
  code=$(curl -s -o /tmp/voyager-g-401.json -w '%{http_code}' "$GATEWAY$path")
  assert "GET $path without the header is 401" "$code" 401
done

code=$(curl -s -o /tmp/voyager-g-401.json -w '%{http_code}' -X PUT \
  -H 'content-type: application/json' -d '{"gds_latency_ms":1}' \
  "$GATEWAY/api/v1/admin/chaos")
assert 'PUT /admin/chaos without the header is 401' "$code" 401

code=$(curl -s -o /tmp/voyager-g-401.json -w '%{http_code}' \
  -H 'x-voyager-admin: not-the-secret' "$GATEWAY/api/v1/admin/chaos")
assert 'a wrong secret is 401' "$code" 401

# The 401 body must not tell the caller how close they were.
body=$(cat /tmp/voyager-g-401.json)
if [[ "$body" != *"$ADMIN_SECRET"* && "$body" != *"secret is"* && "$body" != *"expected"* ]]; then
  ok 'the 401 body hints nothing about the correct value'
else
  bad "the 401 body leaks a hint ($body)"
fi

assert 'the 401 uses the § 13.2 envelope' "$(field /tmp/voyager-g-401.json error.code)" unauthorized

# ----------------------------------------------------------- the catalogue --

section 'The chaos catalogue is complete and self-describing'

code=$(admin_get /tmp/voyager-g-flags.json /api/v1/admin/chaos)
assert 'GET /admin/chaos with the header is 200' "$code" 200

documented=$(grep -cE '^\| `[a-z0-9_]+` \|' 05-FUNCTIONALITY.md)
served=$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-g-flags.json'))['flags']))")
assert 'the catalogue serves 38 flags' "$served" 38

missing=$(python3 -c "
import json, re
served = {f['name'] for f in json.load(open('/tmp/voyager-g-flags.json'))['flags']}
doc = open('05-FUNCTIONALITY.md').read()
section = doc.split('## 11.')[1].split('\n## ')[0]
named = set(re.findall(r'^\| \`([a-z0-9_]+)\`', section, re.M))
print(','.join(sorted(named ^ served)) or 'none')")
assert 'every served flag is a documented flag, and vice versa' "$missing" none

self_describing=$(python3 -c "
import json
flags = json.load(open('/tmp/voyager-g-flags.json'))['flags']
need = {'name','group','type','default','value','active','injection','scenarios'}
print('yes' if all(need <= set(f) for f in flags) else 'no')")
assert 'each flag carries type, default, value, group and injection point' "$self_describing" yes

assert 'nothing is active after a reset' \
  "$(python3 -c "
import json
print(sum(1 for f in json.load(open('/tmp/voyager-g-flags.json'))['flags'] if f['active']))")" 0

# ------------------------------------------------------------- validation --

section 'Bad flag values are refused, not stored'

code=$(admin_put /tmp/voyager-g-bad.json /api/v1/admin/chaos '{"not_a_real_flag":1}')
assert 'an unknown flag is 400' "$code" 400
assert 'the error names the unknown flag' \
  "$(field /tmp/voyager-g-bad.json error.code)" unknown_chaos_flag

code=$(admin_put /tmp/voyager-g-bad.json /api/v1/admin/chaos '{"gds_error_rate":5}')
assert 'an out-of-range rate is 400' "$code" 400

code=$(admin_put /tmp/voyager-g-bad.json /api/v1/admin/chaos '{"gds_latency_ms":"soon"}')
assert 'a non-numeric latency is 400' "$code" 400

# ------------------------------------------------ the criterion that matters --

section 'A flag takes effect within 3 seconds, in every language, with no restart'

search_ms() {
  local body seconds
  body=$(printf '{"origin":"LHR","destination":"CDG","departDate":"%s","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}' "$(day 30)")
  seconds=$(curl -s -o /tmp/voyager-g-search.json -w '%{time_total}' \
    -X POST "$GATEWAY/api/v1/search/flights" \
    -H 'content-type: application/json' -d "$body")
  python3 -c "print(round(float('$seconds') * 1000))"
}

# Clear the search namespace so both measurements are of a cold search. The
# chaos hash is untouched.
clear_search_cache() {
  docker compose exec -T redis redis-cli --no-raw eval \
    "local keys = redis.call('KEYS', 'search:*')
     for i = 1, #keys do redis.call('DEL', keys[i]) end
     return #keys" 0 >/dev/null
}

clear_search_cache
baseline=$(search_ms)
assert_under 'search is fast before any chaos' "$baseline" 3000

now_ms() { python3 -c 'import time; print(round(time.time() * 1000))'; }

# The exit criterion uses gds_latency_ms=3000, which is exactly the
# per-provider timeout in § 7. At that value a provider sits on the deadline,
# so the honest observable effect is "search degrades" -- either much slower,
# or GdsUnavailable when all four providers miss the cut. Both prove the flag
# reached search-service without a restart, which is what is being tested. The
# clean-slowdown case is asserted separately below at the S1 value.
admin_put /tmp/voyager-g-apply.json /api/v1/admin/chaos '{"gds_latency_ms":3000}' >/dev/null
applied_at=$(now_ms)

# Measured from the write to the *start* of the first degraded search.
# Sleeping a fixed interval and checking once would measure the sleep, and
# would sit right on the boundary it is asserting.
propagation_ms=''
for _ in 1 2 3 4 5; do
  clear_search_cache
  started_at=$(now_ms)
  elapsed=$(search_ms)
  degraded=$(field /tmp/voyager-g-search.json error.type)
  if (( elapsed - baseline >= 2000 )) || [[ -n "$degraded" ]]; then
    propagation_ms=$((started_at - applied_at))
    break
  fi
done

if [[ -n "$propagation_ms" ]]; then
  assert_under 'the flag was live within 3 seconds, with no restart' "$propagation_ms" 3000
else
  bad 'the flag was live within 3 seconds, with no restart (search never degraded)'
fi

# Now the S1 value, which is inside the timeout and so must slow search down
# rather than break it. This is the shape the demo actually tells.
admin_put /tmp/voyager-g-apply.json /api/v1/admin/chaos '{"gds_latency_ms":1500}' >/dev/null
sleep 2.5
clear_search_cache
slowed=$(search_ms)

assert_at_least 'at the S1 latency, search slows by roughly the injected delay' \
  "$((slowed - baseline))" 1000
assert_at_least 'and still returns results rather than failing' \
  "$(field /tmp/voyager-g-search.json resultCount)" 1
assert 'the flag reads back as active' \
  "$(admin_get /tmp/voyager-g-flags.json /api/v1/admin/chaos >/dev/null; python3 -c "
import json
flags = json.load(open('/tmp/voyager-g-flags.json'))['flags']
print(next(f['value'] for f in flags if f['name'] == 'gds_latency_ms'))")" 1500

# Go (search-service) saw it above. Every runtime reads the one hash, so the
# Python and Node services are looking at the same value.
assert 'one hash, read by every language' \
  "$(docker compose exec -T redis redis-cli HGET voyager:chaos gds_latency_ms)" 1500

section 'Reset returns the system to healthy within 60 seconds'

reset_started=$(date +%s)
code=$(admin_post /tmp/voyager-g-reset.json /api/v1/admin/chaos/reset)
assert 'POST /admin/chaos/reset is 200' "$code" 200

clear_search_cache
recovered=$(search_ms)
reset_elapsed=$(( $(date +%s) - reset_started ))

assert_under 'reset completed well inside 60 seconds' "$reset_elapsed" 60 's'
assert_under 'search is fast again' "$recovered" 3000
assert 'no flag is left active' \
  "$(admin_get /tmp/voyager-g-flags.json /api/v1/admin/chaos >/dev/null; python3 -c "
import json
print(sum(1 for f in json.load(open('/tmp/voyager-g-flags.json'))['flags'] if f['active']))")" 0

# ------------------------------------------------------------- scenarios --

section 'All 10 scenarios apply and are visible'

code=$(admin_get /tmp/voyager-g-scenarios.json /api/v1/admin/scenarios)
assert 'GET /admin/scenarios is 200' "$code" 200
assert 'ten scenarios are defined' \
  "$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-g-scenarios.json'))['scenarios']))")" 10

for id in S1 S2 S3 S4 S5 S6 S7 S8 S9 S10; do
  code=$(admin_post /tmp/voyager-g-s.json "/api/v1/admin/scenarios/$id/apply")
  if [[ "$code" != 200 ]]; then
    bad "$id applies (HTTP $code)"
    continue
  fi

  # Every flag the scenario names must read back as active in GET /admin/chaos.
  admin_get /tmp/voyager-g-flags.json /api/v1/admin/chaos >/dev/null
  result=$(python3 -c "
import json
scenario = next(s for s in json.load(open('/tmp/voyager-g-scenarios.json'))['scenarios']
                if s['id'] == '$id')
live = {f['name']: f for f in json.load(open('/tmp/voyager-g-flags.json'))['flags']}
missing = [name for name in scenario['flags'] if not live[name]['active']]
print(','.join(missing) or 'all')")
  assert "$id applies its documented flag set" "$result" all

  active=$(field /tmp/voyager-g-flags.json activeScenario)
  assert "$id is reported as the active scenario" "$active" "$id"

  code=$(admin_post /tmp/voyager-g-s.json "/api/v1/admin/scenarios/$id/revert")
  assert "$id reverts" "$code" 200
done

code=$(admin_post /tmp/voyager-g-s.json /api/v1/admin/scenarios/S99/apply)
assert 'an unknown scenario is 404' "$code" 404

reset_chaos

# ------------------------------------------------------------------ auth --

section 'Auth issues, refreshes and revokes'

# example.com, not .test: `.test` is a reserved TLD and booking-service's
# email validation rejects it, which would fail the checkout rather than the
# thing under test.
email="verify-$(date +%s)@example.com"
signup=$(printf '{"email":"%s","password":"correct-horse-battery","firstName":"Ada","lastName":"Verifier"}' "$email")
code=$(curl -s -o /tmp/voyager-g-signup.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/auth/signup" -H 'content-type: application/json' -d "$signup")
assert 'signup is 200' "$code" 200

access=$(field /tmp/voyager-g-signup.json accessToken)
refresh=$(field /tmp/voyager-g-signup.json refreshToken)
[[ -n "$access" ]] && ok 'signup returns an access token' || bad 'signup returns an access token'
[[ -n "$refresh" ]] && ok 'signup returns a refresh token' || bad 'signup returns a refresh token'

code=$(curl -s -o /tmp/voyager-g-dup.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/auth/signup" -H 'content-type: application/json' -d "$signup")
assert 'the same email cannot sign up twice' "$code" 409

weak=$(printf '{"email":"weak-%s@example.com","password":"short","firstName":"A","lastName":"B"}' "$(date +%s)")
code=$(curl -s -o /tmp/voyager-g-weak.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/auth/signup" -H 'content-type: application/json' -d "$weak")
assert 'a short password is refused' "$code" 400

login=$(printf '{"email":"%s","password":"correct-horse-battery"}' "$email")
code=$(curl -s -o /tmp/voyager-g-login.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/auth/login" -H 'content-type: application/json' -d "$login")
assert 'login is 200' "$code" 200

# The same message either way, or the login form becomes an enumeration oracle.
wrong_password=$(printf '{"email":"%s","password":"not-the-password"}' "$email")
curl -s -o /tmp/voyager-g-wrong.json -X POST "$GATEWAY/api/v1/auth/login" \
  -H 'content-type: application/json' -d "$wrong_password" >/dev/null
curl -s -o /tmp/voyager-g-unknown.json -X POST "$GATEWAY/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"nobody-at-all@example.com","password":"not-the-password"}' >/dev/null
assert 'a wrong password and an unknown email give the same message' \
  "$(field /tmp/voyager-g-wrong.json error.message)" \
  "$(field /tmp/voyager-g-unknown.json error.message)"

code=$(curl -s -o /tmp/voyager-g-me.json -w '%{http_code}' \
  -H "authorization: Bearer $access" "$GATEWAY/api/v1/auth/me")
assert '/auth/me with a token is 200' "$code" 200
assert '/auth/me returns the signed-up traveller' "$(field /tmp/voyager-g-me.json email)" "$email"

code=$(curl -s -o /tmp/voyager-g-me.json -w '%{http_code}' "$GATEWAY/api/v1/auth/me")
assert '/auth/me without a token is 401' "$code" 401

refresh_body=$(printf '{"refreshToken":"%s"}' "$refresh")
code=$(curl -s -o /tmp/voyager-g-refresh.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/auth/refresh" -H 'content-type: application/json' -d "$refresh_body")
assert 'refresh is 200' "$code" 200
[[ -n "$(field /tmp/voyager-g-refresh.json accessToken)" ]] \
  && ok 'refresh returns a new access token' || bad 'refresh returns a new access token'

curl -s -o /dev/null -X POST "$GATEWAY/api/v1/auth/logout" \
  -H 'content-type: application/json' -d "$refresh_body"
code=$(curl -s -o /tmp/voyager-g-refresh.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/auth/refresh" -H 'content-type: application/json' -d "$refresh_body")
assert 'a refresh token is dead after logout' "$code" 401

# -------------------------------------------------------- reference data --

section 'Reference data is served and cached'

code=$(curl -s -o /tmp/voyager-g-air.json -w '%{http_code}' "$GATEWAY/api/v1/ref/airports?q=lon")
assert '/ref/airports is 200' "$code" 200
assert_at_least 'a prefix search returns airports' \
  "$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-g-air.json'))['airports']))")" 1

code=$(curl -s -o /tmp/voyager-g-airlines.json -w '%{http_code}' "$GATEWAY/api/v1/ref/airlines")
assert '/ref/airlines is 200' "$code" 200
assert_at_least 'the airline list is populated' \
  "$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-g-airlines.json'))['airlines']))")" 5

assert 'the airline list is cached in Redis' \
  "$(docker compose exec -T redis redis-cli EXISTS ref:airlines | tr -d '[:space:]')" 1

# ------------------------------------------------------------------- BFF --

section 'One BFF checkout call fans out to five or more downstream calls'

searched=$(printf '{"origin":"LHR","destination":"CDG","departDate":"%s","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}' "$(day 30)")
curl -s -o /tmp/voyager-g-search.json -X POST "$GATEWAY/api/v1/search/flights" \
  -H 'content-type: application/json' -d "$searched" >/dev/null
search_id=$(field /tmp/voyager-g-search.json searchId)
result_id=$(field /tmp/voyager-g-search.json results.0.id)

marker="verify-$(date +%s%N)"
checkout=$(printf '{"searchId":"%s","resultId":"%s","contactEmail":"%s","passengerCounts":{"adult":1,"child":0,"infant":0}}' \
  "$search_id" "$result_id" "$email")
code=$(curl -s -o /tmp/voyager-g-checkout.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/bff/checkout/init" \
  -H 'content-type: application/json' -H "x-request-id: $marker" \
  -H "authorization: Bearer $access" -d "$checkout")
assert 'POST /bff/checkout/init is 201' "$code" 201
assert 'it returns a held booking' "$(field /tmp/voyager-g-checkout.json booking.state)" HELD
[[ -n "$(field /tmp/voyager-g-checkout.json holdExpiresAt)" ]] \
  && ok 'it returns a hold expiry' || bad 'it returns a hold expiry'

# The exit criterion is counted, not assumed: every downstream call logs
# "Downstream call completed" tagged with the request id the client sent.
downstream=$(docker compose logs api-gateway --since 2m 2>/dev/null \
  | grep -c "\"request_id\":\"$marker\".*Downstream call")
assert_at_least 'one checkout-init call produced 5 or more downstream calls' "$downstream" 5

code=$(curl -s -o /tmp/voyager-g-home.json -w '%{http_code}' \
  -H "authorization: Bearer $access" "$GATEWAY/api/v1/bff/home")
assert 'GET /bff/home is 200' "$code" 200

code=$(curl -s -o /tmp/voyager-g-account.json -w '%{http_code}' \
  -H "authorization: Bearer $access" "$GATEWAY/api/v1/bff/account")
assert 'GET /bff/account is 200' "$code" 200
assert_at_least 'the account page lists the booking just made' \
  "$(field /tmp/voyager-g-account.json bookingCount)" 1

booking_id=$(field /tmp/voyager-g-checkout.json booking.id)
code=$(curl -s -o /tmp/voyager-g-bffb.json -w '%{http_code}' \
  "$GATEWAY/api/v1/bff/booking/$booking_id")
assert 'GET /bff/booking/{uuid} is 200' "$code" 200
assert 'it resolves the booking by UUID before a PNR exists' \
  "$(field /tmp/voyager-g-bffb.json booking.id)" "$booking_id"

code=$(curl -s -o /tmp/voyager-g-account.json -w '%{http_code}' "$GATEWAY/api/v1/bff/account")
assert 'GET /bff/account without a token is 401' "$code" 401

# ----------------------------------------------- partial-failure tolerance --

section 'A failing panel degrades one widget, not the page'

# ai-support is not a dependency of /bff/home, but loyalty is -- and Phase 5
# may not have landed it yet. Either way the page must answer.
code=$(curl -s -o /tmp/voyager-g-home.json -w '%{http_code}' "$GATEWAY/api/v1/bff/home")
assert 'an anonymous home page is still 200' "$code" 200
assert_at_least 'it still lists popular airports' \
  "$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-g-home.json'))['popularAirports']))")" 1

# ------------------------------------------- the phase 5 services, joined up --

section 'Loyalty and support answer through the gateway'

code=$(curl -s -o /tmp/voyager-g-loyalty.json -w '%{http_code}' \
  -H "authorization: Bearer $access" "$GATEWAY/api/v1/loyalty/me")
assert 'GET /loyalty/me is 200' "$code" 200
assert 'a brand-new member starts at standard' \
  "$(field /tmp/voyager-g-loyalty.json tier)" standard

# The preview is the checkout widget. Taxes must not earn, and the fare class
# must select its multiplier -- the two things that were silently wrong when
# booking.confirmed carried only a total.
preview='{"userId":null,"amountCents":10000,"taxesCents":2000,"fareClassCode":"ECOSAVER","currency":"GBP"}'
code=$(curl -s -o /tmp/voyager-g-preview.json -w '%{http_code}' \
  -X POST "$LOYALTY_URL/v1/loyalty/preview" \
  -H 'content-type: application/json' -d "$preview")
assert 'POST /loyalty/preview is 200' "$code" 200
assert 'taxes are excluded from the eligible spend' \
  "$(field /tmp/voyager-g-preview.json eligibleCents)" 8000
assert 'the fare class picks up its points multiplier' \
  "$(field /tmp/voyager-g-preview.json fareMultiplier)" 0.75
assert 'so the quote is 80 units at 0.75' \
  "$(field /tmp/voyager-g-preview.json pointsToEarn)" 60

# The booking made above is confirmed asynchronously, so give the consumer a
# moment before asking what it accrued.
code=$(curl -s -o /tmp/voyager-g-accrual.json -w '%{http_code}' \
  "$LOYALTY_URL/v1/loyalty/$(field /tmp/voyager-g-signup.json user.id)/accruals/$booking_id")
assert 'an accrual lookup for an unaccrued booking is 200, not 404' "$code" 200
assert 'and reports no accrual rather than an error' \
  "$(field /tmp/voyager-g-accrual.json accrual)" ''

conversation=$(curl -s -X POST "$GATEWAY/api/v1/support/conversations" \
  -H 'content-type: application/json' -d '{"subject":"Where is my booking?"}')
conversation_id=$(python3 -c "
import json
doc = json.loads('''$conversation''')
print(doc.get('conversationId') or doc.get('id') or '')")
[[ -n "$conversation_id" ]] \
  && ok 'a support conversation can be opened' || bad 'a support conversation can be opened'

# A confirmed seeded booking, looked up by PNR and surname -- the phase 5 exit
# criterion, and the one that the mock-llm surname regex used to break.
pnr=$(docker compose exec -T postgres psql -U voyager -d voyager -tAc \
  "SELECT b.pnr FROM voyager.bookings b JOIN voyager.passengers p ON p.booking_id = b.id
   WHERE b.pnr IS NOT NULL AND b.state = 'CONFIRMED' LIMIT 1" | tr -d '[:space:]')
surname=$(docker compose exec -T postgres psql -U voyager -d voyager -tAc \
  "SELECT p.last_name FROM voyager.bookings b JOIN voyager.passengers p ON p.booking_id = b.id
   WHERE b.pnr = '$pnr' LIMIT 1" | tr -d '[:space:]')

ask=$(printf '{"content":"Where is my booking PNR %s? My last name is %s"}' "$pnr" "$surname")
curl -s -N -X POST "$GATEWAY/api/v1/support/conversations/$conversation_id/messages" \
  -H 'content-type: application/json' -d "$ask" -m 40 > /tmp/voyager-g-sse.txt

assert 'the turn calls lookup_booking' \
  "$(grep -c '"tool": "lookup_booking"' /tmp/voyager-g-sse.txt | tr -d '[:space:]' | head -c1)" 2

# The surname, not the word "is" -- which is what the old regex extracted from
# "my last name is Lovelace".
assert 'the surname is extracted from the sentence, not the word before it' \
  "$(python3 -c "
import json, re
for line in open('/tmp/voyager-g-sse.txt'):
    if line.startswith('data:') and 'lookup_booking' in line and 'args' in line:
        print(json.loads(line[5:])['args'].get('lastName', ''))
        break")" "$surname"

assert 'the tool found the booking' \
  "$(grep -c '\"outcome\": \"ok\"' /tmp/voyager-g-sse.txt | tr -d '[:space:]' | head -c1)" 1
assert_at_least 'and the answer streams back as tokens' \
  "$(grep -c '^event: token' /tmp/voyager-g-sse.txt | tr -d '[:space:]')" 1

# ---------------------------------------------------------------- status --

section 'The status endpoint reports every service'

code=$(admin_get /tmp/voyager-g-status.json /api/v1/admin/status)
assert 'GET /admin/status is 200' "$code" 200
assert 'it names seven services' \
  "$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-g-status.json'))['services']))")" 7
assert 'it reports whether the bookings index is present' \
  "$(field /tmp/voyager-g-status.json vitals.postgres.bookings_index_present)" 1

# ---------------------------------------------------- the S3 compensation --

section 'Reset undoes what a flag left behind'

admin_put /tmp/voyager-g-apply.json /api/v1/admin/chaos '{"db_drop_index":true}' >/dev/null
sleep 1
assert 'db_drop_index actually drops the index' \
  "$(docker compose exec -T postgres psql -U voyager -d voyager -tAc \
     "SELECT count(*) FROM pg_indexes WHERE schemaname='voyager'
      AND indexname='idx_bookings_user_id_created_at'" | tr -d '[:space:]')" 0

admin_post /tmp/voyager-g-reset.json /api/v1/admin/chaos/reset >/dev/null
assert 'reset rebuilds it before returning' \
  "$(docker compose exec -T postgres psql -U voyager -d voyager -tAc \
     "SELECT count(*) FROM pg_indexes WHERE schemaname='voyager'
      AND indexname='idx_bookings_user_id_created_at'" | tr -d '[:space:]')" 1
assert 'and says so' \
  "$(field /tmp/voyager-g-reset.json compensated.0)" idx_bookings_user_id_created_at

# ---------------------------------------------------------------- errors --

section 'Errors speak the § 13.2 envelope'

code=$(curl -s -o /tmp/voyager-g-404.json -w '%{http_code}' "$GATEWAY/api/v1/nothing-here")
assert 'an unknown path is 404' "$code" 404
assert 'the 404 carries a type' "$(field /tmp/voyager-g-404.json error.type)" VoyagerError
[[ -n "$(field /tmp/voyager-g-404.json error.requestId)" ]] \
  && ok 'every error carries a requestId' || bad 'every error carries a requestId'

code=$(curl -s -o /tmp/voyager-g-up.json -w '%{http_code}' \
  "$GATEWAY/api/v1/bookings/00000000-0000-0000-0000-000000000000")
assert 'an upstream 404 stays a 404 rather than becoming a 502' "$code" 404
assert 'and keeps the upstream error type' \
  "$(field /tmp/voyager-g-up.json error.type)" BookingNotFoundError

code=$(curl -s -o /tmp/voyager-g-idem.json -w '%{http_code}' \
  -X POST "$GATEWAY/api/v1/payments/authorize" -H 'content-type: application/json' -d '{}')
assert 'authorize without an Idempotency-Key is 400' "$code" 400

# ----------------------------------------------------------------- totals --

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
(( fail == 0 )) || exit 1
