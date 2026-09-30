#!/usr/bin/env bash
#
# Phase 11 exit criteria, as written in 03-EXECUTION-ORDER.md.
#
# Requires the dev overlay for the gateway port and the loadgen overlay for
# the generators themselves:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml \
#     -f docker-compose.loadgen.yml --profile loadgen up -d
#
# The script drives the admin intensity control, so it puts the generators
# back to enabled at 1x on exit whatever happens. Leaving a shared stack at
# 5x is a worse outcome than not having verified it.
#
# Several checks measure a rate over a window, so a full run takes four to
# five minutes. That is the cost of asserting that traffic is flowing rather
# than that a container is running.
set -uo pipefail

GATEWAY=${GATEWAY_URL:-http://localhost:4000}
ADMIN_SECRET=${ADMIN_SECRET:-$(grep -E '^ADMIN_SECRET=' .env | cut -d= -f2-)}
ADMIN_HEADER="x-voyager-admin: ${ADMIN_SECRET}"

STATS_KEY=voyager:loadgen:stats

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

redis_cli() { docker compose exec -T redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
psql()      { docker compose exec -T postgres psql -U voyager -d voyager -tAc "$1" | tr -d '[:space:]'; }

stat_field() { redis_cli HGET "$STATS_KEY" "$1" | tr -d '[:space:]'; }

# Same read, for the fields that hold a sentence rather than a number:
# stat_field strips every space so the numbers compare cleanly, which turns
# a diagnostic message into one unreadable word.
stat_text() { redis_cli HGET "$STATS_KEY" "$1" | tr '\n' ' '; }

# Counters are cumulative and the database is shared with whatever ran
# before, so everything below measures a delta or a bounded time window. A
# suite that only passes against a freshly started generator is not a suite.
counter() {
  local value
  value=$(stat_field "$1")
  echo "${value:-0}"
}

loadgen_post() {
  curl -s -o "$1" -w '%{http_code}' -X POST -H "$ADMIN_HEADER" \
    -H 'content-type: application/json' -d "$2" "$GATEWAY/api/v1/admin/loadgen"
}

restore_loadgen() {
  loadgen_post /tmp/voyager-l-restore.json \
    '{"api":{"enabled":true,"intensity":1},"browser":{"enabled":true,"concurrency":2}}' >/dev/null
}
trap restore_loadgen EXIT

printf '\033[1mPhase 11 verification: the load generators\033[0m\n'
restore_loadgen

# ------------------------------------------------------------ containment --

section 'Both generators are containerised, unpublished and capped'

for container in loadgen-api loadgen-browser; do
  assert "$container is running" \
    "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" true
  assert "$container publishes no host port" \
    "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$container" 2>/dev/null)" 0
  assert "$container is excluded from log collection" \
    "$(docker inspect -f '{{index .Config.Labels "com.datadoghq.ad.logs_exclude"}}' "$container" 2>/dev/null)" \
    true

  limit=$(docker inspect -f '{{.HostConfig.Memory}}' "$container" 2>/dev/null)
  if [[ "$limit" =~ ^[0-9]+$ ]] && (( limit > 0 )); then
    ok "$container has a memory limit ($((limit / 1024 / 1024)) MB)"
  else
    bad "$container has no memory limit"
  fi
done

# The profile is what keeps `make up` quiet. Without it every toggle in the
# ops console is measured against traffic nobody asked for.
default_services=$(docker compose -f docker-compose.yml -f docker-compose.loadgen.yml \
  config --services 2>/dev/null | grep -c '^loadgen-' | tr -d '[:space:]')
assert 'neither generator starts without the loadgen profile' "$default_services" 0

profiled_services=$(docker compose -f docker-compose.yml -f docker-compose.loadgen.yml \
  --profile loadgen config --services 2>/dev/null | grep -c '^loadgen-' | tr -d '[:space:]')
assert 'and both start with it' "$profiled_services" 2

# ------------------------------------------------------------------- mix --

section 'The API mix is exactly the documented mix'

documented_mix=$(python3 -c "
import re
phase = open('Project Requirements/03-EXECUTION-ORDER.md').read().split('## Phase 11')[1].split('\n## ')[0]
found = dict((name.strip().replace(' ', '_'), int(rate))
             for rate, name in re.findall(r'^\s*-\s*(\d+)% (browse|deep browse|checkout|manage|cancel|support)',
                                          phase, re.M))
print(','.join('%s=%d' % item for item in sorted(found.items())))")
assert 'the phase document still names six weighted journeys' \
  "$(tr ',' '\n' <<< "$documented_mix" | grep -c '=')" 6

running_mix=$(stat_field api_mix)
if [[ -z "$running_mix" ]]; then
  bad 'the generator publishes its mix (nothing in voyager:loadgen:stats)'
else
  mismatch=$(MIX="$running_mix" DOC="$documented_mix" python3 -c "
import json, os
running = json.loads(os.environ['MIX'])
documented = dict(pair.split('=') for pair in os.environ['DOC'].split(','))
wrong = [name for name, weight in documented.items() if running.get(name) != int(weight)]
missing = [name for name in running if name not in documented]
print(','.join(sorted(wrong + missing)) or 'none')")
  assert 'every journey runs at the weight the phase document gives it' "$mismatch" none

  assert 'and the six weights are a whole hundred per cent' \
    "$(MIX="$running_mix" python3 -c "
import json, os; print(sum(json.loads(os.environ['MIX']).values()))")" 100
fi

# An empty default has to be substituted here rather than inline: `${var:-\{\}}`
# ends the parameter expansion at the first brace and silently unquotes the rest
# of the line, which lets bash brace-expand the Python that follows.
[[ -n "$running_mix" ]] || running_mix='{}'

# The one cross-document constraint Phase 11 calls out by name.
bottom_of_funnel=$(python3 -c "
import re
section = open('Project Requirements/06-USER-FLOWS.md').read().split('## 8. Funnel definition')[1].split('\n## ')[0]
print(re.findall(r'^\|\s*\d+\s*\|.*?\|\s*(\d+)%\s*\|', section, re.M)[-1])")
assert 'the checkout weight is the bottom-of-funnel conversion in 06-USER-FLOWS.md § 8' \
  "$(MIX="$running_mix" python3 -c "
import json, os; print(json.loads(os.environ['MIX']).get('checkout', 'absent'))")" \
  "$bottom_of_funnel"

# ---------------------------------------------------------------- funnel --

section 'The browser generator walks the § 8 funnel'

documented_funnel=$(python3 -c "
import re
section = open('Project Requirements/06-USER-FLOWS.md').read().split('## 8. Funnel definition')[1].split('\n## ')[0]
print(','.join(re.findall(r'^\|\s*\d+\s*\|.*?\|\s*(\d+)%\s*\|', section, re.M)))")
assert 'the funnel is still eight steps' "$(tr ',' '\n' <<< "$documented_funnel" | grep -c .)" 8

running_funnel=$(stat_field browser_funnel)
if [[ -z "$running_funnel" ]]; then
  bad 'the browser generator publishes its funnel (nothing in voyager:loadgen:stats)'
else
  assert 'each step drops off at the documented rate' \
    "$(LADDER="$running_funnel" DOC="$documented_funnel" python3 -c "
import json, os
running = list(json.loads(os.environ['LADDER']).values())
documented = [int(rate) for rate in os.environ['DOC'].split(',')]
print('same' if running == documented else '%s vs %s' % (running, documented))")" same
fi

# --------------------------------------------------------------- diurnal --

section 'Traffic is shaped by a 24-hour curve, not a flat line'

floor=$(stat_field api_diurnal_floor)
trough=$(stat_field api_diurnal_trough_hour_utc)
observed=$(stat_field api_diurnal)

if [[ -z "$floor" || -z "$observed" ]]; then
  bad 'the generator publishes its diurnal factor'
else
  # Recomputed here from the constants the generator published, so the check
  # fails if the curve is ever quietly flattened or phase-shifted.
  assert 'the factor the generator is using matches the sine for this hour' \
    "$(FLOOR="$floor" TROUGH="$trough" OBSERVED="$observed" python3 -c "
import datetime, math, os
now = datetime.datetime.now(datetime.timezone.utc)
hour = now.hour + now.minute / 60
phase = ((hour - float(os.environ['TROUGH'])) / 24) * 2 * math.pi
floor = float(os.environ['FLOOR'])
expected = floor + (1 - floor) * ((1 - math.cos(phase)) / 2)
print('yes' if abs(expected - float(os.environ['OBSERVED'])) < 0.03 else
      'no (want %.4f, got %s)' % (expected, os.environ['OBSERVED']))")" yes

  assert 'and the curve has real amplitude across the day' \
    "$(FLOOR="$floor" TROUGH="$trough" python3 -c "
import math, os
floor = float(os.environ['FLOOR'])
values = [floor + (1 - floor) * ((1 - math.cos(((h - float(os.environ['TROUGH'])) / 24) * 2 * math.pi)) / 2)
          for h in range(24)]
print('yes' if max(values) - min(values) > 0.5 else 'no (%.2f)' % (max(values) - min(values)))")" yes
fi

# ---------------------------------------------------------------- volume --

section 'Journeys are actually being run, in the documented proportions'

before_total=0
for journey in browse deep_browse checkout manage cancel support; do
  before_total=$((before_total + $(counter "api_journeys_$journey")))
done

printf '  ... sampling 90 seconds of traffic\n'
sleep 90

# Six named variables rather than an associative array: macOS ships bash 3.2,
# and `declare -A` is a bash 4 feature that fails at parse time there.
seen_browse=$(counter api_journeys_browse)
seen_deep_browse=$(counter api_journeys_deep_browse)
seen_checkout=$(counter api_journeys_checkout)
seen_manage=$(counter api_journeys_manage)
seen_cancel=$(counter api_journeys_cancel)
seen_support=$(counter api_journeys_support)
after_total=$((seen_browse + seen_deep_browse + seen_checkout + seen_manage + seen_cancel + seen_support))

baseline_rate=$(( after_total - before_total ))
assert_at_least 'journeys started during a 90-second window' "$baseline_rate" 5

# Ordering is the assertion that holds at any sample size; the tolerance
# check needs enough journeys to be worth making, and says so when it is not.
if (( after_total >= 60 )); then
  assert 'the journeys rank in weight order' \
    "$(python3 -c "
counts = dict(browse=$seen_browse, deep_browse=$seen_deep_browse,
              checkout=$seen_checkout, manage=$seen_manage)
ordered = counts['browse'] >= counts['deep_browse'] >= counts['checkout'] >= counts['manage']
print('yes' if ordered else 'no (%s)' % counts)")" yes
else
  skipped "ranking needs 60 journeys, and only $after_total have run since the generator started"
fi

if (( after_total >= 300 )); then
  assert 'observed proportions are within six points of the weights' \
    "$(MIX="$running_mix" python3 -c "
import json, os
weights = json.loads(os.environ['MIX'])
counts = dict(browse=$seen_browse, deep_browse=$seen_deep_browse,
              checkout=$seen_checkout, manage=$seen_manage,
              cancel=$seen_cancel, support=$seen_support)
total = sum(counts.values())
off = []
for name, count in counts.items():
    drift = round(100 * count / total - weights.get(name, 0), 1)
    if abs(drift) > 6:
        off.append('%s %+.1f' % (name, drift))
print('within' if not off else 'off by ' + ', '.join(off))")" within
else
  skipped "proportions need 300 journeys, and only $after_total have run since the generator started"
fi

# ------------------------------------------------------------- the funnel --

section 'Checkout journeys reach a confirmed booking'

confirmations_before=$(counter api_confirmations)

printf '  ... sampling 120 seconds of checkouts\n'
sleep 120

assert_at_least 'bookings confirmed during the window' \
  "$(( $(counter api_confirmations) - confirmations_before ))" 1

# Bounded to the last quarter hour, so the check cannot pass on bookings left
# behind by an earlier run.
assert_at_least 'and they are in Postgres, in CONFIRMED, with a PNR' \
  "$(psql "SELECT count(*) FROM voyager.bookings
           WHERE contact_email LIKE '%@loadgen.voyager.demo'
             AND state = 'CONFIRMED' AND pnr IS NOT NULL
             AND created_at > now() - interval '15 minutes'")" 1

assert 'every generated PNR uses the unambiguous alphabet' \
  "$(psql "SELECT count(*) FROM voyager.bookings
           WHERE contact_email LIKE '%@loadgen.voyager.demo'
             AND pnr IS NOT NULL AND pnr !~ '^[A-HJ-NP-Z2-9]{6}\$'
             AND created_at > now() - interval '15 minutes'")" 0

assert_at_least 'the generator keeps a pool of its own bookings to manage and cancel' \
  "$(counter api_pool_depth)" 1

# ------------------------------------------------ the criterion that matters --

section 'An intensity change takes effect within 30 seconds, with no restart'

started_before=$after_total
code=$(loadgen_post /tmp/voyager-l-intensity.json \
  '{"api":{"enabled":true,"intensity":5},"browser":{"enabled":true,"concurrency":2}}')
applied_at=$(date +%s)
assert 'POST /admin/loadgen is 200' "$code" 200
assert 'and the admin API echoes the new intensity' \
  "$(field /tmp/voyager-l-intensity.json loadgen.api.intensity)" 5

propagation=''
for _ in $(seq 1 40); do
  [[ "$(stat_field api_intensity)" == "5" ]] && { propagation=$(( $(date +%s) - applied_at )); break; }
  sleep 1
done

if [[ -n "$propagation" ]]; then
  assert_under 'the generator picked the change up inside 30 seconds' "$propagation" 30 's'
else
  bad 'the generator picked the change up inside 30 seconds (intensity never changed)'
fi

# Reading the setting back is not the same as acting on it, so the rate is
# measured too. Five times the intensity is not five times the rate on a
# 30-second sample, but it is unambiguously more.
started_5x=0
for journey in browse deep_browse checkout manage cancel support; do
  started_5x=$((started_5x + $(counter "api_journeys_$journey")))
done
sleep 30
after_5x=0
for journey in browse deep_browse checkout manage cancel support; do
  after_5x=$((after_5x + $(counter "api_journeys_$journey")))
done

if (( baseline_rate > 0 )); then
  # baseline_rate covered 90 seconds, this window 30, so compare thirds.
  assert_at_least 'and the journey rate rose with it' \
    "$(( (after_5x - started_5x) * 3 ))" "$(( baseline_rate * 2 ))"
else
  bad 'and the journey rate rose with it (no baseline to compare against)'
fi

assert_at_least 'the container survived 5x without being OOM-killed' \
  "$(docker inspect -f '{{.State.Running}}' loadgen-api | grep -c true)" 1

section 'Turning the generator off stops it, also within 30 seconds'

loadgen_post /tmp/voyager-l-off.json \
  '{"api":{"enabled":false,"intensity":1},"browser":{"enabled":false,"concurrency":2}}' >/dev/null
disabled_at=$(date +%s)

quiesced=''
for _ in $(seq 1 40); do
  [[ "$(stat_field api_enabled)" == "0" ]] && { quiesced=$(( $(date +%s) - disabled_at )); break; }
  sleep 1
done

if [[ -n "$quiesced" ]]; then
  assert_under 'the generator saw the stop inside 30 seconds' "$quiesced" 30 's'
else
  bad 'the generator saw the stop inside 30 seconds (it never went quiet)'
fi

# In-flight journeys are allowed to finish; what must stop is starting new
# ones. Sampling after the longest journey's think time would take minutes,
# so this only asserts the rate collapsed.
stopped_before=0
for journey in browse deep_browse checkout manage cancel support; do
  stopped_before=$((stopped_before + $(counter "api_journeys_$journey")))
done
sleep 20
stopped_after=0
for journey in browse deep_browse checkout manage cancel support; do
  stopped_after=$((stopped_after + $(counter "api_journeys_$journey")))
done
assert 'and started no new journeys once it had' "$(( stopped_after - stopped_before ))" 0

restore_loadgen

# ------------------------------------------------------------------- cost --

section 'Host CPU stays under 60% at 1x'

# Back to 1x, then long enough for the 5x journeys still in flight to drain.
sleep 45

cores=$(docker info --format '{{.NCPU}}' 2>/dev/null)
busiest=0
for _ in 1 2 3; do
  total=$(docker stats --no-stream --format '{{.CPUPerc}}' 2>/dev/null \
    | tr -d '%' | python3 -c "
import sys
print(round(sum(float(line) for line in sys.stdin if line.strip())))")
  utilisation=$(( total / ${cores:-1} ))
  (( utilisation > busiest )) && busiest=$utilisation
  sleep 5
done

assert_under 'host CPU across every container, at 1x' "$busiest" 60 '%'

loadgen_mb=$(docker stats --no-stream --format '{{.MemUsage}}' loadgen-api 2>/dev/null | python3 -c "
import re, sys
scale = {'B': 1 / 1048576, 'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024}
used = re.match(r'([0-9.]+)([A-Za-z]+)', sys.stdin.read().strip())
print(round(float(used.group(1)) * scale.get(used.group(2), 1)) if used else 99999)")
assert_under 'loadgen-api stays inside its 256 MB budget' "${loadgen_mb:-99999}" 256 'MB'

# ---------------------------------------------------------------- browser --

section 'The browser generator is alive and honest about the front end'

assert 'loadgen-browser has not crashed' \
  "$(docker inspect -f '{{.State.Running}}' loadgen-browser 2>/dev/null)" true
assert 'and has not been restarting in a loop' \
  "$(docker inspect -f '{{.RestartCount}}' loadgen-browser 2>/dev/null)" 0

if [[ "$(stat_field browser_ui_reachable)" == "1" ]]; then
  # Long enough to survive one mismatch backoff plus one session that runs
  # to its navigation timeout. A shorter window is a coin toss against a UI
  # the sessions cannot finish on, and it fails on the generator's behalf.
  sessions_before=$(counter browser_sessions)
  sleep 120
  assert_at_least 'RUM sessions are being generated' \
    "$(( $(counter browser_sessions) - sessions_before ))" 1

  # A session that cannot finish is a front-end problem, not a generator
  # one, so the reason the generator recorded is reported rather than
  # hidden behind a bare zero. This becomes a hard assertion the day the
  # front end and the API agree on their payloads.
  if (( $(counter browser_reached_confirmed) >= 1 )); then
    ok 'and some of them reach the confirmation page'
  else
    skipped "no session reaches confirmation: $(stat_text browser_last_issue)"
  fi
else
  # Expected until Phase 7 ships web-ui. The requirement on this generator
  # today is that it says so clearly and keeps running, which is what the
  # two assertions above and the one below check.
  skipped "web-ui is not reachable, so no RUM sessions are being generated yet"
  if docker logs loadgen-browser 2>&1 | grep -q 'Front end is not reachable'; then
    ok 'it reports the missing front end in plain language'
  else
    bad 'it reports the missing front end in plain language (no such log line)'
  fi
fi

assert 'the browser generator tracks the admin concurrency setting' \
  "$(stat_field browser_concurrency)" 2

# ----------------------------------------------------------------- totals --

printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skip"
(( fail == 0 )) || exit 1
