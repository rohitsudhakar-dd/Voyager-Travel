#!/usr/bin/env bash
#
# Phase 3 exit criteria, as written in 03-EXECUTION-ORDER.md.
#
# Requires the dev overlay so 4010 and 4020 are reachable from the host:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# Same shell rule as verify-mocks.sh: JSON bodies are built into a variable
# first and passed as "$body". Writing -d "{\"a\":1}" inside "$( ... )" breaks
# bash's quote parsing and silently word-splits the result.
set -uo pipefail

SEARCH=${SEARCH_URL:-http://localhost:4010}
PRICING=${PRICING_URL:-http://localhost:4020}

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

# jq is not a dependency anywhere else in the repo, so field reads go through
# python3, which the seeder already requires.
field() { python3 -c "
import json,sys
doc = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    doc = doc[int(key)] if key.isdigit() else doc.get(key)
    if doc is None: break
print('' if doc is None else doc)
" "$1" "$2" 2>/dev/null; }

day() { date -u -v+"$1"d +%Y-%m-%d 2>/dev/null || date -u -d "+$1 days" +%Y-%m-%d; }

flight_body() {
  printf '{"origin":"%s","destination":"%s","departDate":"%s","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}' \
    "$1" "$2" "$3"
}

# post <outfile> <url> <body>; echoes elapsed milliseconds.
post() {
  local out=$1 url=$2 body=$3
  local seconds
  seconds=$(curl -s -o "$out" -w '%{time_total}' -X POST "$url" \
    -H 'content-type: application/json' -d "$body")
  python3 -c "print(round(float('$seconds') * 1000))"
}

chaos_set() { docker compose exec -T redis redis-cli HSET voyager:chaos "$1" "$2" >/dev/null; }
chaos_del() { docker compose exec -T redis redis-cli HDEL voyager:chaos "$1" >/dev/null; }

# ------------------------------------------------------------------ health --

section 'Health and readiness'

assert 'search /health'   "$(curl -s -o /dev/null -w '%{http_code}' "$SEARCH/health")"  200
assert 'search /ready'    "$(curl -s -o /dev/null -w '%{http_code}' "$SEARCH/ready")"   200
assert 'pricing /health'  "$(curl -s -o /dev/null -w '%{http_code}' "$PRICING/health")" 200
assert 'pricing /ready'   "$(curl -s -o /dev/null -w '%{http_code}' "$PRICING/ready")"  200

# --------------------------------------------------------- cold/warm search --

section 'LHR to JFK, 14 days out'

# Two runs inside the 120s cache TTL would otherwise measure a warm search
# and call it cold. Only the search namespace is cleared, so the chaos hash
# and anything else in Redis survives.
docker compose exec -T redis redis-cli --no-raw eval \
  "local keys = redis.call('KEYS', 'search:*')
   for i = 1, #keys do redis.call('DEL', keys[i]) end
   return #keys" 0 >/dev/null

body=$(flight_body LHR JFK "$(day 14)")
cold=$(post /tmp/voyager-s1.json "$SEARCH/v1/search/flights" "$body")

assert_at_least 'cold search returns results' "$(field /tmp/voyager-s1.json resultCount)" 10
assert_under    'cold search under 2s'        "$cold" 2000
assert 'cold search is not a cache hit'   "$(field /tmp/voyager-s1.json cacheHit)" False
assert 'all four providers were queried'  "$(field /tmp/voyager-s1.json providersQueried)" 4
# Not four: mock-gds carries a 0.5% baseline error rate, and tolerating a
# provider that does not answer is the behaviour under test, not a flake.
assert_at_least 'a quorum of providers answered' \
  "$(field /tmp/voyager-s1.json providersResponded)" 3

warm=$(post /tmp/voyager-s2.json "$SEARCH/v1/search/flights" "$body")

assert 'identical request is a cache hit'  "$(field /tmp/voyager-s2.json cacheHit)" True
assert 'cache hit reuses the search id' \
  "$(field /tmp/voyager-s2.json searchId)" "$(field /tmp/voyager-s1.json searchId)"
assert_under 'warm search under 100ms' "$warm" 100

section 'The seed covers the full 360-day window'

for offset in 90 200 300; do
  body=$(flight_body LHR JFK "$(day $offset)")
  post /tmp/voyager-window.json "$SEARCH/v1/search/flights" "$body" >/dev/null
  assert_at_least "+${offset}d returns results" "$(field /tmp/voyager-window.json resultCount)" 10
done

section 'Every demo route is searchable'

for route in LHR:CDG JFK:LAX LHR:DXB AMS:BCN SFO:NRT; do
  body=$(flight_body "${route%%:*}" "${route##*:}" "$(day 21)")
  post /tmp/voyager-route.json "$SEARCH/v1/search/flights" "$body" >/dev/null
  assert_at_least "${route/:/ to } returns results" \
    "$(field /tmp/voyager-route.json resultCount)" 10
done

# ------------------------------------------------------------------ pricing --

section 'Prices come from pricing-service, not the provider'

search_id=$(field /tmp/voyager-s1.json searchId)
priced=$(python3 -c "
import json
doc = json.load(open('/tmp/voyager-s1.json'))
print(sum(1 for r in doc['results'] if r['fare'].get('appliedRules')))
")
assert_at_least 'some results carry applied fare rules' "$priced" 1

consistent=$(python3 -c "
import json
doc = json.load(open('/tmp/voyager-s1.json'))
bad = [r['id'] for r in doc['results']
       if r['fare']['baseAmountCents'] + r['fare']['adjustmentsCents']
          + r['fare']['taxesCents'] != r['fare']['totalAmountCents']]
print(len(bad))
")
assert 'base + adjustments + taxes equals total' "$consistent" 0

section 'Result reads'

status=$(curl -s -o /tmp/voyager-page.json -w '%{http_code}' \
  "$SEARCH/v1/search/$search_id/results?page=2&size=5")
assert 'paginated read'      "$status" 200
assert 'page 2 returns five' "$(python3 -c "
import json; print(len(json.load(open('/tmp/voyager-page.json'))['results']))")" 5

result_id=$(field /tmp/voyager-s1.json results.0.id)
status=$(curl -s -o /tmp/voyager-detail.json -w '%{http_code}' \
  "$SEARCH/v1/search/$search_id/results/$result_id")
assert 'result detail'               "$status" 200
assert 'detail carries a seat map'   "$(python3 -c "
import json
doc = json.load(open('/tmp/voyager-detail.json'))
print('yes' if doc.get('seatmap') else 'no')")" yes

status=$(curl -s -o /tmp/voyager-gone.json -w '%{http_code}' \
  "$SEARCH/v1/search/srch_01DEADBEEFDEADBEEFDEADBEEF/results")
assert 'unknown search id is 410' "$status" 410
assert 'and names the error type'  "$(field /tmp/voyager-gone.json error.type)" \
  SearchResultExpiredError

section 'Rejected criteria'

body='{"origin":"LHR","destination":"LHR","departDate":"'"$(day 14)"'"}'
status=$(curl -s -o /tmp/voyager-bad.json -w '%{http_code}' -X POST \
  "$SEARCH/v1/search/flights" -H 'content-type: application/json' -d "$body")
assert 'same origin and destination is 400' "$status" 400
assert 'error type is stable' "$(field /tmp/voyager-bad.json error.type)" \
  InvalidSearchCriteriaError

body=$(flight_body LHR JFK 2020-01-01)
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$SEARCH/v1/search/flights" -H 'content-type: application/json' -d "$body")
assert 'a date in the past is 400' "$status" 400

body=$(flight_body LHR JFK "$(day 400)")
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$SEARCH/v1/search/flights" -H 'content-type: application/json' -d "$body")
assert 'beyond the 360-day window is 400' "$status" 400

# -------------------------------------------------------------------- chaos --

section 'Chaos flags'

chaos_set redis_disabled true
sleep 3
body=$(flight_body LHR JFK "$(day 14)")
post /tmp/voyager-nocache.json "$SEARCH/v1/search/flights" "$body" >/dev/null
assert 'redis_disabled forces a cache miss' \
  "$(field /tmp/voyager-nocache.json cacheHit)" False
assert_at_least 'and the search still succeeds' \
  "$(field /tmp/voyager-nocache.json resultCount)" 10
chaos_del redis_disabled
sleep 3

offers=$(python3 -c "
import json
depart = '$(day 30)'
print(json.dumps({'offers': [
    {'id': f'o{i}', 'productType': 'flights', 'origin': 'LHR',
     'destination': 'JFK', 'departDate': depart, 'fareClass': 'ECOFLEX',
     'cabin': 'economy', 'baseAmountCents': 25000 + i, 'currency': 'GBP'}
    for i in range(50)]}))")

indexed_ms=$(post /tmp/voyager-indexed.json "$PRICING/v1/price/batch" "$offers")
assert 'indexed path is the default' "$(field /tmp/voyager-indexed.json hotPath)" False

chaos_set pricing_hot_path true
sleep 3
hot_ms=$(post /tmp/voyager-hot.json "$PRICING/v1/price/batch" "$offers")
chaos_del pricing_hot_path

assert 'pricing_hot_path bypasses the index' "$(field /tmp/voyager-hot.json hotPath)" True
assert 'and evaluates every rule' \
  "$(field /tmp/voyager-hot.json quotes.0.rulesEvaluated)" \
  "$(field /tmp/voyager-hot.json rulesInMemory)"
assert 'but produces identical prices' "$(python3 -c "
import json
a = json.load(open('/tmp/voyager-indexed.json'))['quotes']
b = json.load(open('/tmp/voyager-hot.json'))['quotes']
print([q['totalAmountCents'] for q in a] == [q['totalAmountCents'] for q in b])")" True

if (( hot_ms > indexed_ms * 5 )); then
  ok "hot path is measurably slower (${indexed_ms}ms -> ${hot_ms}ms)"
else
  bad "hot path should dominate the indexed path (${indexed_ms}ms -> ${hot_ms}ms)"
fi

# -------------------------------------------------------------- concurrency --

section 'Ten concurrent cold searches'

rm -f /tmp/voyager-conc-*.json
index=0
for route in LHR:JFK LHR:CDG JFK:LAX LHR:DXB AMS:BCN SFO:NRT LHR:JFK LHR:CDG JFK:LAX LHR:DXB; do
  index=$((index + 1))
  body=$(flight_body "${route%%:*}" "${route##*:}" "$(day $((40 + index)))")
  curl -s -o "/tmp/voyager-conc-$index.json" -X POST "$SEARCH/v1/search/flights" \
    -H 'content-type: application/json' -d "$body" &
done
wait

succeeded=0
for index in $(seq 1 10); do
  count=$(field "/tmp/voyager-conc-$index.json" resultCount)
  [[ "$count" =~ ^[0-9]+$ ]] && (( count >= 10 )) && succeeded=$((succeeded + 1))
done
assert 'all ten returned a full page' "$succeeded" 10

for service in search-service pricing-service; do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$service" 2>/dev/null)
  assert "$service is still healthy" "$state" healthy

  used_mb=$(docker stats --no-stream --format '{{.MemUsage}}' "$service" | python3 -c "
import re, sys
raw = sys.stdin.read().split('/')[0].strip()
value = float(re.sub(r'[A-Za-z]+$', '', raw))
unit = re.search(r'[A-Za-z]+$', raw).group()
print(round(value * {'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024, 'B': 1 / 1048576}[unit]))")
  assert_under "$service stays under its 512m limit" "$used_mb" 512 MiB
done

# ------------------------------------------------------------------ summary --

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
(( fail == 0 )) || exit 1
