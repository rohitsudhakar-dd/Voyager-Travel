#!/usr/bin/env bash
#
# The pre-demo gate (03-EXECUTION-ORDER.md Phase 13, 06-USER-FLOWS.md § 10).
# Run it before every demo; it exits non-zero on any failure.
#
#   make healthcheck
#
# It answers seven questions, and it is deliberately the only place that asks
# all seven at once:
#
#   1. Is every container up and healthy?
#   2. Does every service's /ready agree?
#   3. Is every chaos flag off, and did the last scenario's side effects unwind?
#   4. Is the seed data actually there, including the 20 power users S3 needs?
#   5. Are the images stamped with a real commit, so Source Code Integration
#      links resolve?
#   6. Is the edge routing /api to the gateway with the prefix intact?
#   7. Is the Agent taking traces from all three backend runtimes, with a key
#      Datadog accepts?
#
# Several of these pass by absence -- no active flag, no unhealthy container --
# and an assertion that passes by absence also passes when nothing was
# measured. Each one below therefore proves it measured something first: the
# container check counts containers, the trace check drives its own request
# rather than hoping the load generator is running, and the seed check asserts
# floors rather than the absence of an error.
set -uo pipefail

cd "$(dirname "$0")/.."

env_value() {
  sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1
}

PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-$(env_value PUBLIC_HOSTNAME)}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-localhost}
ADMIN_SECRET=${ADMIN_SECRET:-$(env_value ADMIN_SECRET)}
POSTGRES_USER=${POSTGRES_USER:-$(env_value POSTGRES_USER)}
POSTGRES_DB=${POSTGRES_DB:-$(env_value POSTGRES_DB)}
EDGE=${EDGE_URL:-https://$PUBLIC_HOSTNAME}

CURL=(curl -sk --max-time 30)
ADMIN_HEADER="x-voyager-admin: ${ADMIN_SECRET}"

# Every container docker-compose.yml starts and keeps running. kafka-init is
# absent because it is expected to have exited, and seeder because it is behind
# the `tools` profile.
LONG_RUNNING=(postgres redis kafka
              mock-gds mock-payments mock-email mock-llm
              pricing-service search-service booking-service payment-service
              loyalty-service notification-worker ai-support-service
              api-gateway web-ui edge datadog-agent)

# The four services one flight search must touch. They are asserted by name
# because this script drives that search itself, so their absence from the
# Agent's receiver means the pipeline is broken rather than that the demo
# happened to be quiet.
TRACED_BY_A_SEARCH=(voyager-gateway voyager-search voyager-pricing mock-gds)

# Tracer-instrumented containers, which must carry a real commit SHA. web-ui is
# absent on purpose: its SHA is compiled into the bundle at build time and
# shown in the footer, so the container has no environment variable to read.
SCI_CONTAINERS=(api-gateway search-service pricing-service booking-service
                payment-service loyalty-service notification-worker
                ai-support-service mock-gds mock-payments mock-email mock-llm)

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
  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual >= floor )); then
    ok "$label ($actual >= $floor)"
  else
    bad "$label (got '$actual', want >= $floor)"
  fi
}

printf '\033[1mVoyager healthcheck -- %s\033[0m\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"

if [[ -z "$ADMIN_SECRET" ]]; then
  printf '\n\033[31mADMIN_SECRET is not set and .env does not define it.\033[0m\n'
  printf 'Most checks below read the admin API. Run `make bootstrap` first.\n'
  exit 1
fi

# --------------------------------------------------------------- the edge --

# First, because it is also how traffic gets generated for the trace check at
# the bottom: the Agent's receiver reports a rolling window, and the checks in
# between give that window time to fill.
section 'The edge routes to the gateway with the /api prefix intact'

# api-gateway serves /api/v1/ref/airports and nothing at /v1/ref/airports, so a
# 200 here is only reachable if the proxy left the prefix alone.
code=$("${CURL[@]}" -o /tmp/voyager-hc-ref.json -w '%{http_code}' \
  "$EDGE/api/v1/ref/airports?q=LON")
assert 'GET /api/v1/ref/airports through the edge is 200' "$code" 200

depart=$(date -u -v+30d +%Y-%m-%d 2>/dev/null || date -u -d '+30 days' +%Y-%m-%d)
search_body=$(printf '{"origin":"LHR","destination":"CDG","departDate":"%s","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}' "$depart")
code=$("${CURL[@]}" -o /tmp/voyager-hc-search.json -w '%{http_code}' \
  -X POST "$EDGE/api/v1/search/flights" \
  -H 'content-type: application/json' -d "$search_body")
assert 'a flight search through the edge is 200' "$code" 200
assert_at_least 'and it returned priced results' \
  "$(python3 -c "
import json
print(len(json.load(open('/tmp/voyager-hc-search.json')).get('results', [])))" 2>/dev/null || echo 0)" 10

# ------------------------------------------------------------ containers --

section 'Every container is up and healthy'

ps_json=$(docker compose -f docker-compose.yml ps --all --format json 2>/dev/null)

if [[ -z "$ps_json" ]]; then
  bad 'docker compose reported no containers at all -- is the stack up? every check below is vacuous'
else
  # `ps --format json` emits one object per line, not an array.
  states=$(python3 -c "
import json, sys

rows = [json.loads(line) for line in sys.stdin if line.strip()]
by_name = {row['Service']: row for row in rows}

expected = '''$(printf '%s ' "${LONG_RUNNING[@]}")'''.split()
missing  = [name for name in expected if name not in by_name]
unhealthy = sorted(
    f\"{name}={by_name[name].get('Health') or by_name[name].get('State')}\"
    for name in expected
    if name in by_name and by_name[name].get('Health') not in ('healthy', '')
)
# A service with no healthcheck reports an empty Health; for those, running is
# the strongest claim available.
not_running = sorted(
    f\"{name}={by_name[name].get('State')}\"
    for name in expected
    if name in by_name and by_name[name].get('State') != 'running'
)
init = by_name.get('kafka-init', {})

print(len(rows))
print(','.join(missing) or 'none')
print(','.join(unhealthy) or 'none')
print(','.join(not_running) or 'none')
print(f\"{init.get('State', 'absent')}:{init.get('ExitCode', '?')}\")
" <<<"$ps_json")

  assert_at_least 'compose reported containers to inspect' "$(sed -n 1p <<<"$states")" 18
  assert 'every expected container exists' "$(sed -n 2p <<<"$states")" none
  assert 'every container with a healthcheck reports healthy' "$(sed -n 3p <<<"$states")" none
  assert 'every expected container is running' "$(sed -n 4p <<<"$states")" none
  # kafka-init creates the topics and exits. Still running means it is stuck;
  # a non-zero exit means some topic does not exist and a consumer group is
  # silently idle.
  assert 'kafka-init ran to completion' "$(sed -n 5p <<<"$states")" 'exited:0'
fi

# -------------------------------------------------------------- readiness --

section 'Every service agrees it is ready'

code=$("${CURL[@]}" -o /tmp/voyager-hc-status.json -w '%{http_code}' \
  -H "$ADMIN_HEADER" "$EDGE/api/v1/admin/status")
assert 'GET /admin/status is 200' "$code" 200

read -r checked not_ready aggregate index_present < <(python3 -c "
import json

doc = json.load(open('/tmp/voyager-hc-status.json'))
services = doc.get('services', [])
not_ready = sorted(
    f\"{s['service']}={s['status']}\" for s in services if s.get('status') != 'ready'
)
vitals = (doc.get('vitals') or {}).get('postgres') or {}

print(
    len(services),
    ','.join(not_ready) or 'none',
    'yes' if doc.get('healthy') else 'no',
    vitals.get('bookings_index_present', 'unknown'),
)
" 2>/dev/null || echo "0 parse-failed no unknown")

# /admin/status aggregates seven services. Asserting the count first means a
# gateway that suddenly monitors nothing cannot report everything ready.
assert '/admin/status aggregated all seven downstream services' "$checked" 7
assert 'every downstream service returned ready' "$not_ready" none
assert 'the gateway calls the system healthy' "$aggregate" yes

# ------------------------------------------------------------------ chaos --

section 'No chaos is active and its side effects are unwound'

code=$("${CURL[@]}" -o /tmp/voyager-hc-chaos.json -w '%{http_code}' \
  -H "$ADMIN_HEADER" "$EDGE/api/v1/admin/chaos")
assert 'GET /admin/chaos is 200' "$code" 200

read -r catalogue active scenario < <(python3 -c "
import json

doc = json.load(open('/tmp/voyager-hc-chaos.json'))
flags = doc.get('flags', [])
print(
    len(flags),
    ','.join(sorted(f['name'] for f in flags if f.get('active'))) or 'none',
    doc.get('activeScenario') or 'none',
)
" 2>/dev/null || echo "0 parse-failed unknown")

# The catalogue count first. Zero active flags out of zero flags is what a
# gateway that failed to load the catalogue reports, and it looks identical to
# a clean system.
assert 'the catalogue serves all 38 flags' "$catalogue" 38
assert 'no flag is active' "$active" none
assert 'no scenario is applied' "$scenario" none
# S3 drops this index and its reset recreates it. A demo that starts without it
# starts with the punchline already on screen.
assert 'idx_bookings_user_id_created_at exists' "$index_present" 1

# ------------------------------------------------------------ seed data --

section 'The seed data is present, including the power users S3 needs'

psql() { docker compose -f docker-compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER:-voyager}" -d "${POSTGRES_DB:-voyager}" -tAqc "$1" 2>/dev/null; }

counts=$(psql "
  SELECT (SELECT count(*) FROM voyager.bookings),
         (SELECT count(*) FROM voyager.flights),
         (SELECT count(*) FROM voyager.fare_rules),
         (SELECT count(*) FROM voyager.users WHERE email LIKE 'power%@voyager.demo'),
         (SELECT coalesce(min(n), 0) FROM (
            SELECT count(*) AS n FROM voyager.bookings b
              JOIN voyager.users u ON u.id = b.user_id
             WHERE u.email LIKE 'power%@voyager.demo'
             GROUP BY u.id) AS per_user);" | tr -d ' ')

if [[ -z "$counts" ]]; then
  bad 'psql returned nothing -- the counts below cannot be checked'
else
  IFS='|' read -r bookings flights fare_rules power_users min_power_bookings <<<"$counts"
  assert_at_least 'bookings' "$bookings" 400000
  assert_at_least 'flights' "$flights" 150000
  assert_at_least 'fare rules' "$fare_rules" 2000
  assert 'the 20 power users exist' "$power_users" 20
  # 01-PRD.md § 9 says 300-800 each. The floor is what matters: S3's story is
  # a slow query over a large history, and a power user with 40 bookings does
  # not have one.
  assert_at_least 'the thinnest power user has enough history for S3' \
    "$min_power_bookings" 300
fi

# --------------------------------------------- source code integration --

section 'Every image carries a real commit SHA'

# Error Tracking turns a stack frame into a link using these two values. A
# placeholder gets a link that 404s, which is worse than no link: it looks like
# the integration works and the repository is wrong.
# Read through `docker inspect` rather than `docker exec printenv`: the Go
# images have no shell and no coreutils, so exec answers nothing there however
# correctly the variable is set.
sci_checked=0
sci_bad=()
for container in "${SCI_CONTAINERS[@]}"; do
  read -r sha repo < <(docker inspect \
    -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null |
    python3 -c "
import sys
env = dict(
    line.rstrip('\n').split('=', 1)
    for line in sys.stdin if '=' in line
)
print(env.get('DD_GIT_COMMIT_SHA') or 'unset', env.get('DD_GIT_REPOSITORY_URL') or 'unset')
")
  if [[ -z "${sha:-}" ]]; then
    sci_bad+=("$container=uninspectable")
    continue
  fi
  sci_checked=$((sci_checked + 1))
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    sci_bad+=("$container=$sha")
  elif ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    # A well-formed SHA that is not in this repository is a link to nothing.
    sci_bad+=("$container=unknown-commit")
  elif [[ "$repo" == unset ]]; then
    sci_bad+=("$container=no-repository-url")
  fi
done

assert_at_least 'containers inspected for a commit stamp' "$sci_checked" 12
if [[ ${#sci_bad[@]} -eq 0 ]]; then
  ok 'every image was built from a commit that exists in this repository'
else
  bad "images carrying no usable commit stamp: ${sci_bad[*]}"
  printf '       run `make build && make up` (or infra/ec2/deploy.sh) to restamp them\n'
fi

# ---------------------------------------------------------------- datadog --

section 'The Agent is taking traces and Datadog accepts the key'

# The receiver reports a rolling window. The search at the top of this script
# is inside it by now for most runs; one retry covers the rest.
agent_status=/tmp/voyager-hc-agent.json
observed=none
for attempt in 1 2; do
  docker exec datadog-agent agent status -j >"$agent_status" 2>/dev/null
  observed=$(python3 -c "
import json
try:
    doc = json.load(open('$agent_status'))
except Exception:
    print('parse-failed'); raise SystemExit
print(','.join(sorted({r['Service'] for r in doc.get('apmStats', {}).get('receiver', [])})) or 'none')
")
  [[ "$observed" != none && "$observed" != parse-failed ]] && break
  (( attempt == 1 )) && sleep 20
done

if [[ "$observed" == parse-failed || ! -s "$agent_status" ]]; then
  bad 'the Agent did not return a status document -- nothing below could be measured'
else
  # Whitespace-free fields only: the Agent's key status is the sentence "API
  # Key valid", and read splits on spaces.
  read -r reporters spans langs dropped keys key_failures < <(python3 -c "
import json

doc = json.load(open('$agent_status'))
receiver = doc.get('apmStats', {}).get('receiver', [])
forwarder = doc.get('forwarderStats') or {}
statuses = set((forwarder.get('APIKeyStatus') or {}).values())

print(
    len(receiver),
    sum(r.get('SpansReceived', 0) for r in receiver),
    ','.join(sorted({r.get('Lang', '') for r in receiver} - {''})) or 'none',
    sum(sum(r.get('TracesDropped', {}).values()) for r in receiver),
    'valid' if statuses == {'API Key valid'} else ('|'.join(sorted(statuses)) or 'unreported'),
    len(forwarder.get('APIKeyFailure') or {}),
)
")

  assert_at_least 'tracers reporting to the Agent in the last window' "$reporters" 6
  assert_at_least 'spans received' "$spans" 1
  # Three runtimes is the claim the whole demo rests on; two means one language
  # has stopped reporting and the service map has a hole in it.
  assert 'all three backend runtimes are reporting' "$langs" 'go,nodejs,python'
  assert 'no trace was dropped by the Agent' "$dropped" 0
  assert 'Datadog accepts the API key' "$keys" valid
  assert 'the forwarder records no API key failures' "$key_failures" 0

  absent=()
  for service in "${TRACED_BY_A_SEARCH[@]}"; do
    [[ ",$observed," == *",$service,"* ]] || absent+=("$service")
  done
  if [[ ${#absent[@]} -eq 0 ]]; then
    ok 'the search this script made is visible from every service on its path'
  else
    bad "no traces from: ${absent[*]} (this script drove a search through them)"
  fi
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"

if [[ $fail -ne 0 ]]; then
  printf '\033[31mNot demo-ready.\033[0m See README.md § 9, or `make reset` for a clean start.\n'
  exit 1
fi
printf '\033[32mDemo-ready.\033[0m Next: make demo-mode\n'
