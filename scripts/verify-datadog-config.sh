#!/usr/bin/env bash
#
# Phase 12 exit criteria, as written in 03-EXECUTION-ORDER.md.
#
# Entirely static: it reads the committed JSON, the specification documents and
# docker-compose.yml, and needs no running stack, no Datadog keys and no
# network. Run it before every apply.
#
# What it is really for: a dashboard that queries `voyager.bookings.created`
# when the service emits `voyager.booking.created` does not error. It draws an
# empty graph, and the first person to notice is whoever is presenting. Every
# name checked below is a name that fails silently when it is wrong.
set -uo pipefail

cd "$(dirname "$0")/.."

# Python sorts by codepoint and `comm` sorts by locale. Left alone on a machine
# with a UTF-8 locale the two disagree and comm reports differences that are not
# there, which would make every name check below meaningless.
export LC_ALL=C

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

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

# Naming the offenders matters more than counting them. "3 unknown metrics"
# sends someone hunting; "voyager.bookings.created" is the whole answer.
assert_none() {
  local label=$1 offenders=$2
  if [[ -z "$offenders" ]]; then
    ok "$label"
  else
    bad "$label"
    while IFS= read -r line; do
      [[ -n "$line" ]] && printf '       \033[31m%s\033[0m\n' "$line"
    done <<< "$offenders"
  fi
}

assert_file_has() {
  local label=$1 file=$2 needle=$3
  if grep -qF -- "$needle" "$file" 2>/dev/null; then ok "$label"
  else bad "$label (no '$needle' in $file)"; fi
}

count() { wc -l < "$1" | tr -d ' '; }

printf '\033[1mPhase 12 verification: dashboards, monitors, SLOs, synthetics\033[0m\n'

# ------------------------------------------------------ reference catalogues --
#
# Derived from the documents rather than typed out again, so that adding a metric
# to 05-FUNCTIONALITY.md § 14 is enough to make it usable here, and nothing in
# this script can drift away from the specification it is checking.

python3 - "$tmp" <<'PY'
import os
import re
import sys

out = sys.argv[1]


def write(name, values):
    with open(os.path.join(out, name), "w", encoding="utf-8") as handle:
        for value in sorted(set(values)):
            handle.write(value + "\n")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def part(text, heading, stop):
    start = text.index(heading)
    return text[start:text.index(stop, start)]


functionality = read("Project Requirements/05-FUNCTIONALITY.md")
flows = read("Project Requirements/06-USER-FLOWS.md")
order = read("Project Requirements/03-EXECUTION-ORDER.md")
compose = read("docker-compose.yml")

# § 14 is the metric catalogue; every name appears in backticks.
write("cat-metrics", re.findall(r"`(voyager\.[a-z0-9_.]+)`", part(functionality, "## 14.", "\n## 15.")))

# § 11 is the complete chaos flag catalogue: 38 rows, first column backticked
# and sometimes bolded.
flags = part(functionality, "## 11.", "\n## 12.")
write("cat-flags", re.findall(r"^\|\s*\**`([a-z0-9_]+)`\**\s*\|", flags, re.M))

# § 2 of 06-USER-FLOWS.md: the RUM view name is the third table column, and two
# rows carry a pair of names.
views = []
for row in re.findall(r"^\|[^|]+\|[^|]+\|([^|]+)\|", part(flows, "## 2.", "\n## 3."), re.M):
    views += re.findall(r"`(/[a-z/]*)`", row)
write("cat-rum-views", views)

# § 7: action names are the first column, several per row where they share a
# context. § 7.1: the five custom timings.
actions = part(flows, "## 7. RUM action taxonomy", "### 7.2")
write("cat-rum-actions", re.findall(r"`([A-Z][A-Za-z0-9 ]*)`", actions))
write("cat-rum-timings", re.findall(r"`([a-z_]+)`", part(flows, "### 7.1", "### 7.2")))

# Phase 8 item 6 of 03-EXECUTION-ORDER.md is the canonical custom span list.
write("cat-spans", re.findall(r"`([a-z]+\.[a-z_]+)`", part(order, "## Phase 8", "## Phase 9")))

# DD_SERVICE in docker-compose.yml is the only authority on service names. The
# tables in the documents disagree with it: voyager-api-gateway does not exist,
# the gateway reports voyager-gateway. voyager-web is the exception, because the
# RUM application has no container and Phase 9 owns it.
write("cat-services", re.findall(r"DD_SERVICE:\s*([a-z0-9-]+)", compose) + ["voyager-web"])
PY

# Datadog-provided metrics, each checked by hand against the `metadata.csv` files
# in DataDog/integrations-core. This list exists because
# `postgresql.queries.duration` -- the metric 01-PRD.md § 6.2 originally named --
# does not exist: the real family is .count, .time, .rows, .duration.max and
# .duration.sum. A monitor on the wrong name never fires and never complains.
cat > "$tmp/cat-integration-metrics" <<'EOF'
container.cpu.usage
container.memory.oom_events
container.memory.rss
kafka.consumer_lag
postgresql.active_waiting_queries
postgresql.deadlocks.count
postgresql.index_scans
postgresql.locks
postgresql.percent_usage_connections
postgresql.queries.count
postgresql.queries.rows
postgresql.queries.time
postgresql.seq_scans
redis.keys.evicted
redis.mem.used
redis.net.clients
redis.net.instantaneous_ops_per_sec
redis.stats.keyspace_hits
redis.stats.keyspace_misses
synthetics.test_runs
EOF
sort -o "$tmp/cat-integration-metrics" "$tmp/cat-integration-metrics"

# The entry-point span name is a property of the runtime, not of the service, and
# Voyager has exactly one per runtime. Trace metrics are namespaced by it, so a
# wrong name yields an empty graph rather than an error. Reading the list out of
# § 5.2 rather than repeating it here means the document stays the authority, and
# that the several dashboards and notebook cells citing § 5.2 cite something real.
python3 - "$tmp" <<'PY'
import os
import re
import sys

with open("Project Requirements/02-TECH-STACK.md", encoding="utf-8") as handle:
    text = handle.read()
start = text.index("### 5.2 Entry-point span names")
table = text[start:text.index("### 5.3", start)]
spans = re.findall(r"^\|[^|]+\|\s*`([a-z]+\.request)`\s*\|", table, re.M)
with open(os.path.join(sys.argv[1], "cat-entry-spans"), "w", encoding="utf-8") as handle:
    for span in sorted(set(spans)):
        handle.write(span + "\n")
PY

# Snake_case tokens that appear in prose and are not chaos flags. Keeping this
# list explicit is what lets the flag check stay strict; a check that has to
# guess which tokens to ignore is a check someone eventually switches off.
#
# In order: the five decline codes of 05-FUNCTIONALITY.md § 5 (a closed set,
# any of which `payment_decline_mix` can favour); `p99_tail`, which is a *value*
# of the `gds_latency_mode` flag rather than a flag; tag keys and log attributes;
# the four custom timings of 06-USER-FLOWS.md § 7.1 that are named in prose; the
# two database identifiers the chaos flags act on; and one metric query function.
cat > "$tmp/allow-prose-tokens" <<'EOF'
card_declined
do_not_honor
expired_card
fraud_suspected
insufficient_funds
p99_tail
cache_hit
consumer_group
decline_code
error_kind
evicted_keys
failure_reason
query_signature
resource_name
checkout_step_duration
support_first_token
time_to_confirmation
time_to_first_result
time_to_interactive_results
idx_bookings_user_id_created_at
inventory_holds
clamp_min
EOF
sort -o "$tmp/allow-prose-tokens" "$tmp/allow-prose-tokens"

# ----------------------------------------------------------- what we committed --

python3 - "$tmp" <<'PY'
import glob
import json
import os
import re
import sys

out = sys.argv[1]


def write(name, values):
    with open(os.path.join(out, name), "w", encoding="utf-8") as handle:
        for value in sorted(set(str(v) for v in values)):
            handle.write(value + "\n")


def walk(node, wanted, found):
    """Collect every value stored under a given key, at any depth."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == wanted:
                found.append(value)
            walk(value, wanted, found)
    elif isinstance(node, list):
        for item in node:
            walk(item, wanted, found)


def documents(pattern):
    for path in sorted(glob.glob(pattern)):
        with open(path, encoding="utf-8") as handle:
            yield path, json.load(handle)


ALL = (
    "datadog/dashboards/*.json",
    "datadog/monitors/*.json",
    "datadog/slos/*.json",
    "datadog/synthetics/*.json",
    "datadog/notebooks/*.json",
)

# Metric names are read only from query strings, never from prose. Several
# descriptions deliberately name a metric that does not exist in order to warn
# the reader off it, and a checker that read those would report the warning as
# the bug.
METRIC = re.compile(r"(?:^|[,(\s])(?:[a-z0-9_]+:)?([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\{")

queries = []
for pattern in ALL[:3] + (ALL[4],):
    for path, document in documents(pattern):
        found = []
        walk(document, "query", found)
        queries += [value for value in found if isinstance(value, str)]

metrics, services, spans = [], [], []
for query in queries:
    metrics += METRIC.findall(query)
    services += [s for s in re.findall(r"service:([A-Za-z0-9_.$-]+)", query) if not s.startswith("$")]
    spans += re.findall(r"operation_name:([a-z]+\.[a-z_]+)", query)

write("used-metrics", [m for m in metrics if m.startswith("voyager.")])
write("used-integration-metrics", [m for m in metrics if not m.startswith(("voyager.", "trace."))])
write("used-services", services)
write("used-spans", spans)

# A trace metric is `trace.<entry span>` with an optional statistic suffix.
entry = set()
for metric in (m for m in metrics if m.startswith("trace.")):
    stem = metric[len("trace."):]
    for suffix in (".hits", ".errors", ".apdex", ".duration"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    entry.add(stem)
write("used-entry-spans", entry)

# RUM view names, action names and custom timings are plain strings that match
# nothing when they are wrong, which is the worst kind of wrong.
views, actions, timings = [], [], []


def funnel_steps(node):
    if isinstance(node, dict):
        if isinstance(node.get("facet"), str) and isinstance(node.get("value"), str):
            yield node["facet"], node["value"]
        for value in node.values():
            for pair in funnel_steps(value):
                yield pair
    elif isinstance(node, list):
        for item in node:
            for pair in funnel_steps(item):
                yield pair


for path, document in documents("datadog/dashboards/*.json"):
    for facet, value in funnel_steps(document):
        if facet == "@view.name":
            views.append(value)
        elif facet == "@action.name":
            actions.append(value)
    raw = json.dumps(document)
    timings += re.findall(r"@view\.custom_timings\.([a-z_]+)", raw)

write("used-rum-views", views)
write("used-rum-actions", actions)
write("used-rum-timings", timings)

# Chaos flags are named in prose, so prose is where they have to be checked.
CANDIDATE = re.compile(r"`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`")
prose = []
for pattern in ALL:
    for path, document in documents(pattern):
        for key in ("message", "description", "content", "text"):
            found = []
            walk(document, key, found)
            prose += [value for value in found if isinstance(value, str)]
write("used-prose-tokens", CANDIDATE.findall("\n".join(prose)))

# Structural facts, written out for the shell to assert on.
REQUIRED = {"env", "service", "route", "user_tier"}
titles, missing, defaults = [], [], []
for path, document in documents("datadog/dashboards/*.json"):
    titles.append(document.get("title", "<untitled %s>" % path))
    variables = document.get("template_variables") or []
    names = set(v["name"] for v in variables)
    for absent in sorted(REQUIRED - names):
        missing.append("%s: no %s template variable" % (path, absent))
    # A dashboard scoped by $service.value opens on the variable's default, so a
    # typo there empties every widget on arrival while the query itself is fine.
    for variable in variables:
        if variable["name"] != "service":
            continue
        defaults += variable.get("defaults") or []
        if isinstance(variable.get("default"), str):
            defaults.append(variable["default"])
write("dash-titles", titles)
write("dash-missing-variables", missing)
write("dash-service-defaults", [d for d in defaults if d != "*"])

unscoped, names, types = [], [], []
for path, document in documents("datadog/monitors/*.json"):
    names.append(document["name"])
    types.append("%s\t%s" % (document["type"], os.path.basename(path)))
    if document["type"] in ("composite", "slo alert"):
        continue
    if "env:demo" not in document["query"]:
        unscoped.append("%s: query is not scoped to env:demo" % path)
write("monitor-unscoped", unscoped)
write("monitor-names", names)
write("monitor-types", types)

mismatched = []
for pattern in ("datadog/monitors/*.json", "datadog/slos/*.json", "datadog/synthetics/*.json"):
    for path, document in documents(pattern):
        slug = os.path.basename(path)[: -len(".json")]
        if "voyager_id:%s" % slug not in (document.get("tags") or []):
            mismatched.append("%s: missing tag voyager_id:%s" % (path, slug))
write("id-mismatched", mismatched)

rows = []
for path, document in documents("datadog/synthetics/*.json"):
    rows.append("\t".join([
        os.path.basename(path)[: -len(".json")],
        document["type"],
        document.get("subtype", "-"),
        str(document["options"].get("tick_every")),
        document.get("status", "live"),
    ]))
write("synthetics", rows)

rows = []
for path, document in documents("datadog/slos/*.json"):
    threshold = document["thresholds"][0]
    rows.append("\t".join([document["type"], threshold["timeframe"], str(threshold["target"])]))
write("slos", rows)
PY

# ------------------------------------------------------------------ the files --

section 'Files and JSON validity'
assert_at_least 'six or more dashboards committed' "$(ls datadog/dashboards/*.json 2>/dev/null | wc -l | tr -d ' ')" 6
assert_at_least 'monitors committed' "$(ls datadog/monitors/*.json 2>/dev/null | wc -l | tr -d ' ')" 15
assert 'three SLOs committed' "$(ls datadog/slos/*.json 2>/dev/null | wc -l | tr -d ' ')" 3
assert 'five synthetic tests committed' "$(ls datadog/synthetics/*.json 2>/dev/null | wc -l | tr -d ' ')" 5
assert 'one notebook committed' "$(ls datadog/notebooks/*.json 2>/dev/null | wc -l | tr -d ' ')" 1

invalid=$(
  for file in $(find datadog -name '*.json' | sort); do
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$file" 2>/dev/null || echo "$file"
  done
)
assert_none 'every committed JSON file parses' "$invalid"

assert_at_least 'the § 14 metric catalogue was readable' "$(count "$tmp/cat-metrics")" 25
assert 'the § 11 chaos flag catalogue has 38 flags' "$(count "$tmp/cat-flags")" 38
assert_at_least 'DD_SERVICE values were read from docker-compose.yml' "$(count "$tmp/cat-services")" 10
assert_at_least 'the Phase 8 custom span list was readable' "$(count "$tmp/cat-spans")" 16

# ------------------------------------------------------------- the dashboards --

section 'The six dashboards from 01-PRD.md § 7'
for title in \
  'Voyager — Business Health' \
  'Voyager — Service Overview' \
  'Voyager — Checkout Deep Dive' \
  'Voyager — Data Layer' \
  'Voyager — Frontend Experience' \
  'Voyager — AI Support'
do
  if grep -qxF "$title" "$tmp/dash-titles"; then ok "$title"
  else bad "$title is missing (apply.sh matches on title, so a rename creates a duplicate)"; fi
done
assert_none 'every dashboard carries env, service, route and user_tier' "$(cat "$tmp/dash-missing-variables")"

# ---------------------------------------------------------------- the monitors --

section 'Monitors required by 01-PRD.md § 6.2'
for signal in latency errors throughput; do
  assert_at_least "per-service $signal monitors exist" \
    "$(grep -l "signal:$signal" datadog/monitors/*.json | wc -l | tr -d ' ')" 2
done

assert 'exactly one composite monitor' "$(grep -c $'^composite\t' "$tmp/monitor-types")" 1
assert_file_has 'the composite is named "Checkout degraded"' "$tmp/monitor-names" '[Voyager] Checkout degraded'
assert 'the composite has two legs' \
  "$(grep -o '{{MONITOR_ID:[a-z-]*}}' datadog/monitors/composite-checkout-degraded.json | sort -u | wc -l | tr -d ' ')" 2
assert_none 'both composite legs are committed as their own monitors' "$(
  for leg in $(grep -o '{{MONITOR_ID:[a-z-]*}}' datadog/monitors/composite-checkout-degraded.json |
      sed 's/{{MONITOR_ID:\(.*\)}}/\1/' | sort -u); do
    [[ -f "datadog/monitors/$leg.json" ]] || echo "datadog/monitors/$leg.json"
  done
)"

assert 'a DBM query monitor exists' "$(ls datadog/monitors/dbm-*.json 2>/dev/null | wc -l | tr -d ' ')" 1
assert 'a Data Streams consumer lag monitor exists' "$(ls datadog/monitors/kafka-consumer-lag-*.json 2>/dev/null | wc -l | tr -d ' ')" 1
assert 'a log monitor exists' "$(grep -c $'^log alert\t' "$tmp/monitor-types")" 1
assert 'a service check monitor exists for the Kafka broker' "$(grep -c $'^service check\t' "$tmp/monitor-types")" 1
assert 'a Redis eviction monitor exists' "$(ls datadog/monitors/integration-redis-evictions.json 2>/dev/null | wc -l | tr -d ' ')" 1
assert 'two error budget burn alerts exist' "$(grep -c $'^slo alert\t' "$tmp/monitor-types")" 2

assert_file_has 'the lag monitor watches voyager.notifications.outbound' \
  datadog/monitors/kafka-consumer-lag-notifications.json 'topic:voyager.notifications.outbound'
assert_file_has 'the lag monitor threshold is 1000, as § 6.2 requires' \
  datadog/monitors/kafka-consumer-lag-notifications.json '> 1000'
assert_file_has 'the Kafka broker monitor uses the kafka.can_connect service check' \
  datadog/monitors/integration-kafka-broker-down.json 'kafka.can_connect'

assert_none 'every metric, log and check monitor is scoped to env:demo' "$(cat "$tmp/monitor-unscoped")"

# ------------------------------------------------------------------ the names --
#
# Everything from here down is the part that catches a silent no-data failure.

section 'Metric names (05-FUNCTIONALITY.md § 14)'
assert_none 'every voyager.* metric in a query is in the § 14 catalogue' \
  "$(comm -23 "$tmp/used-metrics" "$tmp/cat-metrics")"
assert_at_least 'voyager.* metrics are actually being queried' "$(count "$tmp/used-metrics")" 20
assert_none 'every Datadog integration metric was verified against integrations-core' \
  "$(comm -23 "$tmp/used-integration-metrics" "$tmp/cat-integration-metrics")"

# The reverse direction. A metric the services go to the trouble of emitting and
# that no dashboard ever draws is wasted instrumentation nobody will notice is
# wasted, so the catalogue and the dashboards are held to agree both ways.
assert_none 'every § 14 metric appears on at least one dashboard or monitor' \
  "$(comm -13 "$tmp/used-metrics" "$tmp/cat-metrics")"

section 'Span names'
assert 'all three runtimes have an entry span in 02-TECH-STACK.md § 5.2' "$(count "$tmp/cat-entry-spans")" 3
assert_none 'every trace.* metric uses a documented entry-point span' \
  "$(comm -23 "$tmp/used-entry-spans" "$tmp/cat-entry-spans")"
assert_none 'every custom span queried is in 03-EXECUTION-ORDER.md Phase 8 item 6' \
  "$(comm -23 "$tmp/used-spans" "$tmp/cat-spans")"
assert_at_least 'custom spans are actually being queried' "$(count "$tmp/used-spans")" 10

section 'Service names (DD_SERVICE in docker-compose.yml)'
assert_none 'every service: in a query matches a real DD_SERVICE' \
  "$(comm -23 "$tmp/used-services" "$tmp/cat-services")"
assert_at_least 'services are pinned in queries, not left to the variable alone' \
  "$(count "$tmp/used-services")" 6
assert_none 'every dashboard service template default matches a real DD_SERVICE' \
  "$(comm -23 "$tmp/dash-service-defaults" "$tmp/cat-services")"

section 'RUM names (06-USER-FLOWS.md § 2, § 7, § 7.1)'
assert_none 'every RUM view name is in § 2' "$(comm -23 "$tmp/used-rum-views" "$tmp/cat-rum-views")"
assert_none 'every RUM action name is in § 7' "$(comm -23 "$tmp/used-rum-actions" "$tmp/cat-rum-actions")"
# The three checks above pass trivially if nothing was extracted, which is what
# would happen if a future edit renamed the funnel widget's step structure. These
# floors are the eight funnel steps of 06-USER-FLOWS.md § 8, split by facet.
assert_at_least 'the funnel names RUM views' "$(count "$tmp/used-rum-views")" 3
assert_at_least 'the funnel names RUM actions' "$(count "$tmp/used-rum-actions")" 5
assert_none 'every custom timing is one of the five in § 7.1' \
  "$(comm -23 "$tmp/used-rum-timings" "$tmp/cat-rum-timings")"
assert 'all five custom timings are on a dashboard' "$(count "$tmp/used-rum-timings")" 5

section 'Chaos flags named in prose (05-FUNCTIONALITY.md § 11)'
sort -u "$tmp/cat-flags" "$tmp/allow-prose-tokens" > "$tmp/known-tokens"
assert_none 'every flag-shaped token in a message is a real chaos flag' \
  "$(comm -23 "$tmp/used-prose-tokens" "$tmp/known-tokens")"
assert_at_least 'monitor messages name real chaos flags' \
  "$(comm -12 "$tmp/used-prose-tokens" "$tmp/cat-flags" | wc -l | tr -d ' ')" 20

# A monitor that reports a symptom without saying how to reverse it, or which
# dashboard answers the question, is the failure this phase exists to prevent, so
# every message is checked individually rather than in aggregate.
#
# The Kafka broker check is the one monitor with no flag behind it: all four queue
# flags act on clients, so nothing in § 11 stops the broker. Saying so explicitly
# is the correct answer to "which flag reverses this", and the check accepts it.
assert_none 'every monitor message says how to reverse or rule out chaos' "$(
  for file in datadog/monitors/*.json; do
    grep -qE 'scripts/chaos\.sh|make chaos-reset|No chaos flag causes this' "$file" || echo "$file"
  done
)"
assert_none 'every monitor message names a dashboard to open' "$(
  for file in datadog/monitors/*.json; do
    grep -qF 'Voyager — ' "$file" || echo "$file"
  done
)"

# ----------------------------------------------------------------------- SLOs --

section 'SLOs and error budget alerts (01-PRD.md § 6.2)'
assert 'a metric SLO at 99.0% over 30 days' "$(grep -c $'^metric\t30d\t99.0$' "$tmp/slos")" 1
assert 'a monitor SLO over 7 days' "$(grep -c $'^monitor\t7d\t' "$tmp/slos")" 1
assert 'a time-slice SLO over 30 days' "$(grep -c $'^time_slice\t30d\t' "$tmp/slos")" 1
assert_file_has 'the booking SLO measures confirmed against failed' \
  datadog/slos/booking-success-rate.json 'voyager.booking.failed'
assert_file_has 'the search SLO is built on the p95 latency monitor' \
  datadog/slos/search-latency-p95.json '{{MONITOR_ID:apm-latency-search-p95}}'
assert_file_has 'the checkout SLO is built on the browser synthetic' \
  datadog/slos/checkout-availability.json '{{SYNTHETICS_PUBLIC_ID:browser-checkout-funnel}}'
assert_file_has 'the fast-burn alert is on the booking SLO' \
  datadog/monitors/slo-booking-success-fast-burn.json '{{SLO_ID:booking-success-rate}}'
assert_file_has 'the slow-burn alert is on the booking SLO' \
  datadog/monitors/slo-booking-success-slow-burn.json '{{SLO_ID:booking-success-rate}}'
assert 'the two burn alerts use different long windows' \
  "$(grep -ho 'long_window([^)]*)' datadog/monitors/slo-booking-success-*.json | sort -u | wc -l | tr -d ' ')" 2

# ----------------------------------------------------------------- synthetics --

section 'The five synthetic tests from 01-PRD.md § 6.2'
assert 'a one-minute API test on the health endpoint' \
  "$(grep -c $'^api-gateway-health\tapi\thttp\t60\t' "$tmp/synthetics")" 1
assert 'an API test on flight search' "$(grep -c $'^api-search-flights-latency\tapi\thttp\t' "$tmp/synthetics")" 1
assert 'a multistep API test' "$(grep -c $'\tapi\tmulti\t' "$tmp/synthetics")" 1
assert 'two browser tests' "$(grep -c $'\tbrowser\t' "$tmp/synthetics")" 2
assert_file_has 'the search test asserts a latency ceiling' \
  datadog/synthetics/api-search-flights-latency.json '"responseTime"'
assert_file_has 'the search test asserts that results came back' \
  datadog/synthetics/api-search-flights-latency.json '$.resultCount'
assert_at_least 'the multistep test chains the booking id between steps' \
  "$(grep -c '{{ BOOKING_ID }}' datadog/synthetics/api-multistep-booking.json)" 4
assert_file_has 'the checkout browser test reaches a PNR' \
  datadog/synthetics/browser-checkout-funnel.json 'confirmation-pnr-value'
assert_file_has 'the manage browser test looks a booking up by PNR' \
  datadog/synthetics/browser-manage-booking.json 'lookup-pnr'

# Browser steps are addressed by data-testid, so every selector has to exist in
# the committed UI. A typo here produces a red synthetic that reads as an outage.
python3 - "$tmp" <<'PY'
import glob
import json
import os
import re
import sys

out = sys.argv[1]

# The UI spells a test id four ways, and the synthetics depend on all of them: a
# literal JSX attribute; a quoted key inside an `inputProps` object; a `testId`
# prop, either as an attribute or as a field in an options array; and a template
# literal such as `passenger-${index}-first-name` or, inside CopyChip,
# `${testId}-value`. A checker that only understood the first would report nine
# correct selectors as missing, and being told repeatedly that a correct thing is
# wrong is how a verification script loses its audience.
ATTRIBUTE = re.compile(
    r"'?data-testid'?\s*[=:]\s*(?:\{`([^`]+)`\}|\"([^\"]+)\"|\{'([^']+)'\}|'([^']+)')")
PROP = re.compile(r"testId\s*[=:]\s*(?:\"([^\"]+)\"|\{`([^`]+)`\}|\{?'([^']+)'\}?)")

literals, templates, suffixes = set(), [], set()
for path in glob.glob("apps/web-ui/src/**/*.tsx", recursive=True):
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    for match in ATTRIBUTE.finditer(source):
        raw = next(group for group in match.groups() if group is not None)
        if "${testId}" in raw or "${prefix}" in raw:
            suffixes.add(re.sub(r"\$\{\w+\}", "", raw))
        elif "${" in raw:
            templates.append(re.compile("^" + re.sub(
                r"\\\$\\\{\w+\\\}", "[A-Za-z0-9_-]+", re.escape(raw)) + "$"))
        else:
            literals.add(raw)
    for match in PROP.finditer(source):
        raw = next(group for group in match.groups() if group is not None)
        if "${" not in raw:
            literals.add(raw)

available = set(literals)
for stem in literals:
    for suffix in suffixes:
        available.add(stem + suffix)


def known(selector):
    return selector in available or any(t.match(selector) for t in templates)


used = set()
for path in sorted(glob.glob("datadog/synthetics/browser-*.json")):
    with open(path, encoding="utf-8") as handle:
        used |= set(re.findall(r"data-testid='([a-z0-9-]+)'", handle.read()))

with open(os.path.join(out, "unknown-selectors"), "w", encoding="utf-8") as handle:
    for selector in sorted(used - set(s for s in used if known(s))):
        handle.write(selector + "\n")
with open(os.path.join(out, "used-selectors"), "w", encoding="utf-8") as handle:
    handle.write("%d\n" % len(used))
PY
assert_at_least 'the browser tests address the UI by data-testid' "$(cat "$tmp/used-selectors")" 15
assert_none 'every browser-test selector exists in apps/web-ui/src' "$(cat "$tmp/unknown-selectors")"

# ------------------------------------------------------- apply.sh and hygiene --

section 'apply.sh: idempotency and secret hygiene'
assert_none 'every tagged object carries voyager_id matching its filename' "$(cat "$tmp/id-mismatched")"
assert 'apply.sh is executable' "$([[ -x datadog/apply.sh ]] && echo yes || echo no)" yes
# Naming a key variable in a diagnostic is fine and necessary; interpolating its
# value into output is what puts a credential in a terminal scrollback or a CI log.
# Only the sigil distinguishes the two, so only the sigil is matched here.
assert 'apply.sh never interpolates a key into output' \
  "$(grep -cE '(echo|printf|print)[^|]*\$\{?DD_(API|APP)_KEY' datadog/apply.sh)" 0
assert 'apply.sh never enables shell tracing' "$(grep -c 'set -x' datadog/apply.sh)" 0
# Comment lines are excluded because apply.sh explains in prose why it is not
# using jq, and a checker that cannot tell a warning from the thing it warns about
# is worse than no checker.
assert 'apply.sh does not invoke jq' \
  "$(grep -vE '^[[:space:]]*#' datadog/apply.sh | grep -cE '(^|[|;&(]| )jq( |$)')" 0
assert 'no committed JSON contains a 32-character hexadecimal key' \
  "$(grep -rlE '[0-9a-f]{32}' datadog --include='*.json' | wc -l | tr -d ' ')" 0
assert 'datadog/README.md explains the layout' "$([[ -f datadog/README.md ]] && echo yes || echo no)" yes

if ./datadog/apply.sh --dry-run >"$tmp/dry-run.log" 2>&1; then
  ok 'apply.sh --dry-run resolves every placeholder offline'
else
  bad 'apply.sh --dry-run failed'
  sed 's/^/       /' "$tmp/dry-run.log"
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
(( fail == 0 )) || exit 1
