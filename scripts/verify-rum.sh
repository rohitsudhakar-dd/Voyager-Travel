#!/usr/bin/env bash
#
# Phase 9 exit criteria, as assertions.
#
# Browser RUM is the one product in this stack whose configuration cannot be
# verified by reading anything on disk. `VITE_*` values are substituted at build
# time, so the repository and the served bundle can disagree; and a bundle that
# contains the SDK still proves nothing about whether `init` ran, what it was
# given, or whether Datadog accepted the result. So the checks come from three
# places, each answering something the others cannot:
#
#   1. The served bundle, read out of the running container. Proves the build
#      args reached Vite rather than being passed as runtime environment.
#   2. One real browser session, driven by scripts/lib/rum_probe.mjs inside the
#      Playwright image. Proves the SDK initialised, what it was configured
#      with, which headers it attaches, and what the intake answered.
#   3. The gateway, over curl. Proves the server side of correlation -- that a
#      RUM-originated trace is accepted through CORS, adopted as the parent, and
#      written into the service log as dd.trace_id.
#
# Several assertions here pass by the absence of something (no unmasked card
# field, no leaked chaos flag, no trace header on a same-origin request). Every
# one of those is preceded by a check that the thing being searched was captured
# at all, because "found nothing" and "looked at nothing" are the same string in
# a grep and only one of them is a pass.
#
# Read-only against the stack apart from the chaos flags, which are set and then
# reset to prove the projection is live.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
GATEWAY=${GATEWAY_URL:-http://localhost:4000}
NETWORK=${VOYAGER_NETWORK:-voyager}
PROBE_IMAGE=${PROBE_IMAGE:-voyager-loadgen-browser}
PROBE_JSON=/tmp/voyager-rum-probe.json

env_value() { sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1; }

ADMIN_SECRET=${ADMIN_SECRET:-$(env_value ADMIN_SECRET)}
ADMIN_HEADER="x-voyager-admin: ${ADMIN_SECRET}"
EXPECTED_APP_ID=${EXPECTED_APP_ID:-$(env_value VITE_DD_RUM_APPLICATION_ID)}

passed=0
failed=0

pass() { printf '  ok    %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; failed=$((failed + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() {
  local label=$1 condition=$2
  if [[ $condition == true ]]; then pass "$label"; else fail "$label"; fi
}

# Read one field out of the probe's JSON. Prints nothing and returns non-zero if
# the path is missing, so a renamed field shows up as a failed assertion rather
# than as the string "None" silently satisfying a comparison.
probe_field() {
  python3 - "$1" <<'PY' 2>/dev/null
import json, sys
value = json.load(open('/tmp/voyager-rum-probe.json'))
for part in sys.argv[1].split('.'):
    if isinstance(value, list):
        value = value[int(part)]
    else:
        value = value[part]
if isinstance(value, bool):
    print('true' if value else 'false')
elif isinstance(value, (dict, list)):
    print(json.dumps(value, sort_keys=True))
else:
    print(value)
PY
}

printf '\033[1mPhase 9 -- Browser RUM, Session Replay and RUM/APM correlation\033[0m\n'

# ------------------------------------------------- 1. build-time wiring --

section 'Build-time configuration'

if [[ -z $EXPECTED_APP_ID ]]; then
  fail 'VITE_DD_RUM_APPLICATION_ID is not set in .env (nothing to verify against)'
  EXPECTED_APP_ID='__unset__'
else
  pass 'VITE_DD_RUM_APPLICATION_ID is present in .env'
fi

# Vite inlines VITE_* at build time. Declaring them under `environment` looks
# correct, restarts cleanly, and ships a bundle with an empty application id --
# so the absence of that mistake is itself an exit criterion.
runtime_vite=$("${COMPOSE[@]}" config --format json 2>/dev/null | python3 -c "
import json, sys
try:
    service = json.load(sys.stdin)['services']['web-ui']
except Exception:
    print('UNREADABLE'); raise SystemExit
env = service.get('environment') or {}
names = [n for n in env if n.startswith('VITE_')]
args = [n for n in (service.get('build', {}).get('args') or {}) if n.startswith('VITE_')]
print('UNREADABLE' if not args else ','.join(names) or 'NONE')
")

if [[ $runtime_vite == UNREADABLE ]]; then
  fail 'could not read the web-ui service (or it declares no VITE_* build args)'
else
  check 'VITE_* reach the bundle as build args, never as runtime environment' \
    "$([[ $runtime_vite == NONE ]] && echo true || echo "false # $runtime_vite")"
fi

bundle_dir=/usr/share/nginx/html/assets
bundle_hits=$(docker exec web-ui sh -c \
  "grep -rl '$EXPECTED_APP_ID' $bundle_dir 2>/dev/null | wc -l" 2>/dev/null | tr -d ' \r')
bundle_hits=${bundle_hits:-0}
check 'the real RUM application id is compiled into the served bundle' \
  "$([[ $bundle_hits -ge 1 ]] && echo true || echo false)"

# The client token too, and it must be a public one. A missing token leaves the
# SDK constructed but silent, and an API key pasted here instead would be a
# secret shipped to every visitor.
token=$(env_value VITE_DD_RUM_CLIENT_TOKEN)
token_hits=0
if [[ $token == pub* ]]; then
  token_hits=$(docker exec web-ui sh -c \
    "grep -rl '$token' $bundle_dir 2>/dev/null | wc -l" 2>/dev/null | tr -d ' \r')
fi
check 'a public (pub-prefixed) RUM client token is compiled into the bundle' \
  "$([[ ${token_hits:-0} -ge 1 ]] && echo true || echo false)"

# Sourcemaps are built for the Datadog upload and must not be reachable.
served_maps=$(docker exec web-ui sh -c \
  "find /usr/share/nginx/html -name '*.map' | wc -l" 2>/dev/null | tr -d ' \r')
check 'sourcemaps are built but not served' \
  "$([[ ${served_maps:-1} -eq 0 ]] && echo true || echo false)"

# --------------------------------------------------- 2. the live session --

section 'Live browser session'

if ! docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1; then
  fail "the $PROBE_IMAGE image is missing (run 'make build'); no live checks can run"
  printf '\n  %s passed, %s failed\n' "$passed" "$failed"
  exit 1
fi

printf '  driving one browser session (about 30s)\n'
# Mounted under /app rather than at the root because Node resolves `playwright`
# by walking up from the importing file, and the image's node_modules is /app's.
docker run --rm --network "$NETWORK" -w /app \
  -v "$PWD/scripts/lib:/app/probe:ro" \
  -e WEB_BASE_URL="${WEB_BASE_URL:-http://web-ui:8080}" \
  --entrypoint node "$PROBE_IMAGE" probe/rum_probe.mjs >"$PROBE_JSON" 2>/tmp/voyager-rum-probe.err

if [[ ! -s $PROBE_JSON ]] || ! python3 -c 'import json;json.load(open("'"$PROBE_JSON"'"))' 2>/dev/null; then
  fail 'the browser probe produced no parsable output (the checks below cannot be trusted)'
  sed -n '1,12p' /tmp/voyager-rum-probe.err | sed 's/^/        /'
  printf '\n  %s passed, %s failed\n' "$passed" "$failed"
  exit 1
fi

fatal=$(probe_field fatal)
if [[ -n $fatal ]]; then
  fail "the browser probe could not reach a RUM session: ${fatal:0:200}"
  printf '\n  %s passed, %s failed\n' "$passed" "$failed"
  exit 1
fi
pass 'the browser probe completed a RUM session'

expect_field() {
  local label=$1 path=$2 want=$3 got
  got=$(probe_field "$path")
  if [[ $got == "$want" ]]; then pass "$label"; else fail "$label (got '${got:-<missing>}')"; fi
}

expect_field 'window.DD_RUM initialised with the real application id' \
  config.applicationId "$EXPECTED_APP_ID"
expect_field 'the client token is a public RUM token' config.clientTokenPrefix pub
expect_field 'service is voyager-web' config.service voyager-web
expect_field 'views are started manually (route patterns, not URLs)' \
  config.trackViewsManually true
expect_field 'user interactions are tracked' config.trackUserInteractions true
expect_field 'resources are tracked' config.trackResources true
expect_field 'long tasks are tracked' config.trackLongTasks true
expect_field 'browser logs are collected as voyager-web' config.logsService voyager-web
expect_field 'front-end errors are forwarded to logs' config.logsForwardErrors true

session_id=$(probe_field config.sessionId)
check 'the session was sampled in (a session id exists)' \
  "$([[ -n $session_id && $session_id != None ]] && echo true || echo false)"

# ------------------------------------------------------------ 3. privacy --

section 'Privacy'

expect_field "defaultPrivacyLevel is 'mask-user-input'" \
  config.defaultPrivacyLevel mask-user-input

# Every payment input, found by its autocomplete token rather than by a list of
# file names, so a new card field added to a new component is covered too. The
# count is asserted first: with no inputs found, "none of them is unmasked" is
# true and meaningless.
payment_inputs=$(grep -rn "autoComplete=\"cc-\(number\|csc\|exp\)\"" \
  apps/web-ui/src --include='*.tsx' | wc -l | tr -d ' ')
check 'the card number, expiry and CVC inputs were found in the source' \
  "$([[ $payment_inputs -ge 3 ]] && echo true || echo false)"

if [[ $payment_inputs -ge 3 ]]; then
  unmasked=$(grep -rl 'autoComplete="cc-' apps/web-ui/src --include='*.tsx' |
    while read -r file; do
      python3 - "$file" <<'PY'
import re, sys
source = open(sys.argv[1]).read()
for match in re.finditer(r'<input\b.*?/?>', source, re.S):
    tag = match.group(0)
    if re.search(r'autoComplete="cc-(number|csc|exp)"', tag) and 'data-dd-privacy="mask"' not in tag:
        print(f"{sys.argv[1]}: {' '.join(tag.split())[:80]}")
PY
    done)
  check 'every card number, expiry and CVC input carries data-dd-privacy="mask"' \
    "$([[ -z $unmasked ]] && echo true || echo false)"
  [[ -n $unmasked ]] && printf '%s\n' "$unmasked" | sed 's/^/        /'
fi

# The SDK must never be handed a card number, CVC, password or token to log.
leaky=$(grep -rn "datadogRum\.\|datadogLogs\.\|trackAction(\|setViewAttribute(" \
  apps/web-ui/src --include='*.ts' --include='*.tsx' |
  grep -i 'cardnumber\|cvc\|password\|accesstoken\|refreshtoken\|passportnumber')
check 'no card, CVC, password, token or passport value is passed to the SDK' \
  "$([[ -z $leaky ]] && echo true || echo false)"
[[ -n $leaky ]] && printf '%s\n' "$leaky" | sed 's/^/        /'

# ---------------------------------------------------- 4. views & timings --

section 'View names and custom timings'

# The funnel's view names, from 06-USER-FLOWS.md § 2. Each must be a literal in
# the bundle: a view name assembled at runtime from location.pathname would put
# a booking id or search id into the name and shatter the funnel into one view
# per session.
for view in /home /search/flights /search/hotels /results/flights /results/hotels \
            /detail /checkout/review /checkout/passengers /checkout/payment \
            /confirmation /manage /manage/detail /account /login /signup /admin; do
  hit=$(docker exec web-ui sh -c "grep -rl '\"$view\"' $bundle_dir 2>/dev/null | wc -l" | tr -d ' \r')
  check "view name $view ships in the bundle" \
    "$([[ ${hit:-0} -ge 1 ]] && echo true || echo false)"
done

for timing in time_to_first_result time_to_interactive_results \
              checkout_step_duration time_to_confirmation support_first_token; do
  hit=$(docker exec web-ui sh -c "grep -rl '$timing' $bundle_dir 2>/dev/null | wc -l" | tr -d ' \r')
  check "custom timing $timing ships in the bundle" \
    "$([[ ${hit:-0} -ge 1 ]] && echo true || echo false)"
done

observed=$(probe_field views)
check 'the probe recorded at least one named view' \
  "$([[ $observed == *'"view"'* && $observed != *'"view": null'* ]] && echo true || echo false)"

# A view name carrying an id means the name was built from the URL.
check 'no observed view name contains a generated id' \
  "$(python3 - <<'PY'
import json, re
views = json.load(open('/tmp/voyager-rum-probe.json')).get('views') or []
named = [v for v in views if v.get('view')]
if not named:
    print('false')
else:
    bad = [v for v in named if re.search(r'(srch_|bk_|_01[A-Z0-9]{8})', v['view'])]
    print('false' if bad else 'true')
PY
)"

# --------------------------------------------------- 5. RUM/APM handshake --

section 'RUM to APM correlation'

traced=$(probe_field propagation.tracedHeaders)
control=$(probe_field propagation.controlHeaders)

check 'RUM attached x-datadog-trace-id to the gateway request' \
  "$([[ $traced == *'x-datadog-trace-id'* ]] && echo true || echo false)"
check 'RUM attached the W3C traceparent to the gateway request' \
  "$([[ $traced == *traceparent* ]] && echo true || echo false)"
check 'the request is marked as RUM-originated (x-datadog-origin: rum)' \
  "$([[ $traced == *'"x-datadog-origin": "rum"'* ]] && echo true || echo false)"

# The control. Asserted only once the positive case has captured something,
# otherwise an interception that never fired would pass both directions.
if [[ $traced == *'x-datadog-trace-id'* ]]; then
  check 'a same-origin asset request carries no trace headers (allowedTracingUrls is narrow)' \
    "$([[ $control != *'x-datadog-'* && $control != *traceparent* ]] && echo true || echo false)"
else
  fail 'no trace headers were captured at all, so the same-origin control proves nothing'
fi

# The two ids must describe one trace, not two. traceparent's is hex, the
# Datadog header's is decimal.
check 'traceparent and x-datadog-trace-id name the same trace' \
  "$(python3 - <<'PY'
import json
headers = (json.load(open('/tmp/voyager-rum-probe.json'))
           .get('propagation', {}).get('tracedHeaders') or {})
parent, datadog = headers.get('traceparent'), headers.get('x-datadog-trace-id')
if not parent or not datadog:
    print('false')
else:
    print('true' if int(parent.split('-')[1][-16:], 16) == int(datadog) else 'false')
PY
)"

# The server side. A browser-shaped request is replayed over curl with a trace id
# chosen here, then looked for in the gateway's log. The probe's own request
# cannot be used: it is cross-origin from the probe's hostname, so the preflight
# stops it before the gateway ever sees it. What matters is the same thing either
# way -- the gateway adopting a RUM trace id and writing it as dd.trace_id.
trace_id=$(python3 -c 'import random; print(random.getrandbits(63))')
hex_id=$(printf '%032x' "$trace_id")
curl -s -o /dev/null -H "x-datadog-trace-id: $trace_id" \
  -H 'x-datadog-parent-id: 1234567890123456' \
  -H 'x-datadog-origin: rum' -H 'x-datadog-sampling-priority: 1' \
  -H "traceparent: 00-$hex_id-0123456789abcdef-01" \
  "$GATEWAY/api/v1/ref/airlines"

sleep 3
gateway_log=$(docker logs --since 60s api-gateway 2>&1 | grep -F "$trace_id")
check 'the gateway joined the browser trace and logged it as dd.trace_id' \
  "$([[ $gateway_log == *'"trace_id":"'"$trace_id"'"'* ]] && echo true || echo false)"

# CORS. A preflight that drops these headers fails silently: the browser simply
# never sends the real request, so traces look unsampled rather than blocked.
preflight=$(curl -s -D - -o /dev/null -X OPTIONS \
  -H 'Origin: http://localhost:8080' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-datadog-trace-id,x-datadog-parent-id,x-datadog-origin,x-datadog-sampling-priority,traceparent,tracestate' \
  "$GATEWAY/api/v1/bff/home" | tr -d '\r' | tr 'A-Z' 'a-z')

if [[ $preflight != *access-control-allow-headers* ]]; then
  fail 'the preflight returned no access-control-allow-headers (nothing to check against)'
else
  allowed=$(printf '%s' "$preflight" | sed -n 's/^access-control-allow-headers: *//p')
  for header in x-datadog-trace-id x-datadog-parent-id x-datadog-origin \
                x-datadog-sampling-priority traceparent tracestate; do
    check "CORS allows $header" \
      "$([[ $allowed == *"$header"* ]] && echo true || echo false)"
  done
fi

# --------------------------------------------- 6. intake & session replay --

section 'Datadog intake and Session Replay'

beacons=$(probe_field beacons)
check 'the browser sent beacons to the Datadog intake' \
  "$([[ $beacons == *browser-intake* || $beacons == *'/api/v2/'* ]] && echo true || echo false)"

# 202 is the difference between "sent" and "accepted". A revoked client token
# produces an identical resource entry with a 403.
check 'every RUM beacon was accepted (202) by the intake' \
  "$(python3 - <<'PY'
import json
beacons = json.load(open('/tmp/voyager-rum-probe.json')).get('beacons') or []
rum = [b for b in beacons if b['endpoint'].endswith('/rum')]
print('true' if rum and all(b['status'] == 202 for b in rum) else 'false')
PY
)"

check 'Session Replay uploaded at least one accepted segment' \
  "$(python3 - <<'PY'
import json
beacons = json.load(open('/tmp/voyager-rum-probe.json')).get('beacons') or []
replay = [b for b in beacons if b['endpoint'].endswith('/replay')]
print('true' if replay and all(b['status'] == 202 for b in replay) else 'false')
PY
)"

replay_link=$(probe_field replayLink)
check 'the session has a replay link (the recording is addressable)' \
  "$([[ $replay_link == https://*/rum/replay/sessions/* ]] && echo true || echo false)"

# -------------------------------------------- 7. frontend chaos projection --

section 'Frontend chaos projection'

code=$(curl -s -o /tmp/voyager-rum-chaos.json -w '%{http_code}' "$GATEWAY/api/v1/chaos/frontend")
check 'GET /api/v1/chaos/frontend needs no credentials' \
  "$([[ $code == 200 ]] && echo true || echo false)"

flag_names=$(python3 -c "
import json
try:
    flags = json.load(open('/tmp/voyager-rum-chaos.json'))['flags']
except Exception:
    print(''); raise SystemExit
print(','.join(sorted(flags)))
" 2>/dev/null)

if [[ -z $flag_names ]]; then
  fail 'the projection returned no flags (the leak check below cannot be trusted)'
else
  check 'the projection exposes exactly the four frontend_* flags' \
    "$([[ $flag_names == 'frontend_blocking_js,frontend_heavy_assets,frontend_js_error_rate,frontend_layout_shift' ]] \
      && echo true || echo "false # $flag_names")"

  leaked=$(grep -Eo 'gds_latency_ms|db_n_plus_one|payment_decline_rate|kafka_[a-z_]+|scenario|injection' \
    /tmp/voyager-rum-chaos.json)
  check 'the projection leaks none of the other 34 chaos flags' \
    "$([[ -z $leaked ]] && echo true || echo false)"
fi

for method in PUT POST DELETE PATCH; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" \
    -H 'content-type: application/json' -d '{"frontend_heavy_assets":true}' \
    "$GATEWAY/api/v1/chaos/frontend")
  check "the projection refuses $method" \
    "$([[ $code == 404 || $code == 405 ]] && echo true || echo false)"
done

# The projection must read live Redis, not a compiled-in default -- and the
# "hides a non-frontend flag" assertion is only worth anything if that flag is
# genuinely switched on, so the write is confirmed through the admin view before
# either check is trusted.
curl -s -o /dev/null -X PUT -H "$ADMIN_HEADER" -H 'content-type: application/json' \
  -d '{"frontend_heavy_assets":true,"gds_latency_ms":1500}' \
  "$GATEWAY/api/v1/admin/chaos"
sleep 3

admin_view=$(curl -s -H "$ADMIN_HEADER" "$GATEWAY/api/v1/admin/chaos")
armed=$(python3 -c "
import json, sys
try:
    flags = {entry['name']: entry['value'] for entry in json.load(sys.stdin)['flags']}
except Exception:
    print('false'); raise SystemExit
print('true' if flags.get('frontend_heavy_assets') is True and flags.get('gds_latency_ms') == 1500 else 'false')
" <<<"$admin_view")

if [[ $armed != true ]]; then
  fail 'could not arm the chaos flags through the admin API (the two checks below would be vacuous)'
else
  pass 'armed frontend_heavy_assets and gds_latency_ms through the admin API'
  reflects=$(curl -s "$GATEWAY/api/v1/chaos/frontend")
  check 'the projection reflects a flag set through the admin API' \
    "$([[ $reflects == *'"frontend_heavy_assets":true'* ]] && echo true || echo false)"
  check 'the projection still hides a non-frontend flag that is switched on' \
    "$([[ $reflects != *gds_latency_ms* && $reflects != *1500* ]] && echo true || echo false)"
fi

curl -s -o /dev/null -X PUT -H "$ADMIN_HEADER" -H 'content-type: application/json' \
  -d '{"frontend_heavy_assets":false,"gds_latency_ms":0}' \
  "$GATEWAY/api/v1/admin/chaos"

printf '\n  %s passed, %s failed\n' "$passed" "$failed"
[[ $failed -eq 0 ]]
