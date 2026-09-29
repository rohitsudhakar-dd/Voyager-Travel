#!/usr/bin/env bash
#
# Phase 10 deliverable 9, as assertions: LLM Observability in ai-support-service.
#
# The exit criterion is "LLM Observability shows traced chains with tool calls,
# token counts and cost; llm_degrade_tools=true shows tool-call failures". None
# of that can be asked of the Datadog API without an application key, and none
# of it is visible in the Agent's status either -- LLM Observability spans do
# not travel with the traces. The tracer keeps them in a second writer and
# posts them as JSON through the Agent's EVP proxy, and the `_ml_obs.*` tags
# are stripped off the APM payload on the way past, so the token counts and the
# cost exist on that endpoint and nowhere else.
#
# So ai-support-service is run once more against scripts/lib/span_sink.py,
# which speaks both endpoints and prints one JSON line per span. The LLM
# Observability lines are marked `"llmobs": true`; the rest are APM spans.
#
# Requires the dev overlay, for the published port:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# The probe has to stop the real ai-support-service -- it needs the port and
# the `ai-support-service` DNS alias -- and it sets chaos flags. Both are
# undone from an exit trap, so an interrupted run cannot leave the stack short
# of a service or a demo mid-chaos.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
SINK=llmobs-span-sink
PROBE=llmobs-probe
SUPPORT=${SUPPORT_URL:-http://127.0.0.1:4070}
CAPTURE=/tmp/voyager-llmobs.jsonl

# Every flag this script sets, listed once so the trap can clear all of them
# whether or not the phase that set them ran.
FLAGS=(llm_degrade_tools llm_hallucinate llm_latency_ms)

# The generators aim at the real service name, so while the probe holds that
# alias their support traffic lands on it -- which would let an assertion pass
# on a conversation this script did not send.
LOADGEN=(loadgen-api loadgen-browser)

pass=0
fail=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() {
  local label=$1 condition=$2
  if [[ $condition == true ]]; then ok "$label"; else bad "$label"; fi
}

cleanup() {
  docker rm -f "$SINK" "$PROBE" >/dev/null 2>&1
  docker exec redis redis-cli HDEL voyager:chaos "${FLAGS[@]}" >/dev/null 2>&1
  # --force-recreate rather than start: a container stopped while `compose run`
  # held the network comes back detached from it, which presents as a crash
  # loop with "network is unreachable" and is much harder to diagnose after the
  # fact than to prevent here.
  "${COMPOSE[@]}" up -d --force-recreate --no-deps ai-support-service >/dev/null 2>&1
  for generator in "${LOADGEN[@]}"; do
    docker start "$generator" >/dev/null 2>&1
  done
}
trap cleanup EXIT

printf '\033[1mPhase 10 verification: LLM Observability in ai-support-service\033[0m\n'

# ------------------------------------------------------------- the subject --

if ! docker ps --format '{{.Names}}' | grep -qx redis; then
  echo "  the stack is not running -- start it first"
  exit 1
fi

# A real booking, because a tool span that looked nothing up proves nothing
# about the chain. Its PNR and surname are what the model extracts from the
# question and hands to lookup_booking.
read -r PNR LAST_NAME <<<"$(docker exec postgres psql -U voyager -d voyager -At -F' ' -c "
  SELECT b.pnr, p.last_name
  FROM bookings b JOIN passengers p ON p.booking_id = b.id
  WHERE b.state = 'CONFIRMED' AND b.pnr IS NOT NULL
  ORDER BY b.created_at DESC
  LIMIT 1;" 2>/dev/null)"

if [[ -z ${PNR:-} || -z ${LAST_NAME:-} ]]; then
  echo "  no confirmed booking to ask about -- run 'make seed' first"
  exit 1
fi
echo "  asking about booking $PNR / $LAST_NAME"

# ---------------------------------------------------------------- the probe --

for generator in "${LOADGEN[@]}"; do
  docker stop "$generator" >/dev/null 2>&1
done

docker rm -f "$SINK" "$PROBE" >/dev/null 2>&1
docker run -d --name "$SINK" --network voyager \
  -v "$PWD/scripts/lib":/opt/sink:ro \
  python:3.12-slim python /opt/sink/span_sink.py 8126 >/dev/null
sleep 2

"${COMPOSE[@]}" stop ai-support-service >/dev/null 2>&1
# --no-deps so the probe does not recreate half the stack on its way up, and
# --use-aliases so it answers on the name the gateway and the generators use.
"${COMPOSE[@]}" run --rm -d --no-deps --name "$PROBE" --service-ports \
  --use-aliases -e DD_AGENT_HOST="$SINK" ai-support-service >/dev/null 2>&1

ready=false
for _ in $(seq 1 90); do
  if curl -sS -o /dev/null "$SUPPORT/health" 2>/dev/null; then ready=true; break; fi
  sleep 1
done
if [[ $ready != true ]]; then
  echo "  the probe never became ready"
  exit 1
fi

# ------------------------------------------------------------------ drivers --

capture_from=0

snapshot() { capture_from=$(docker logs "$SINK" 2>/dev/null | wc -l | tr -d ' '); }

# Everything the sink printed since the last snapshot. Slicing rather than
# restarting the sink keeps each phase's spans to itself without losing the
# ones still in flight from the phase before.
collect() {
  # The tracers flush on their own schedule; nothing has been sent until they do.
  sleep 8
  docker logs "$SINK" 2>/dev/null | tail -n +$((capture_from + 1)) >"$CAPTURE"
}

ask() {
  local conversation
  conversation=$(curl -sS -X POST "$SUPPORT/v1/support/conversations" \
    -H 'content-type: application/json' -d '{}' 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["conversationId"])' 2>/dev/null)
  [[ -n $conversation ]] || return 1
  curl -sS -N -o /dev/null -X POST \
    "$SUPPORT/v1/support/conversations/$conversation/messages" \
    -H 'content-type: application/json' \
    -d "{\"content\":\"Where is my booking $PNR, last name $LAST_NAME?\"}" 2>/dev/null
}

chaos_set() {
  docker exec redis redis-cli HSET voyager:chaos "$1" "$2" >/dev/null
  sleep 3
  # Read it back rather than assume. voyager:chaos is shared, and a flag
  # cleared out from under the run -- by a concurrent `make chaos-reset`, say
  # -- would fail every assertion in the phase below for a reason that has
  # nothing to do with the code under test.
  [[ $(docker exec redis redis-cli HGET voyager:chaos "$1" | tr -d '\r') == "$2" ]] ||
    bad "chaos flag $1 did not stay set (something else is writing voyager:chaos)"
}

chaos_del() { docker exec redis redis-cli HDEL voyager:chaos "$1" >/dev/null; sleep 3; }

# One `kind|name|status|parent|model|provider|in|out|total|cost|ttft|error_type|tags`
# line per LLM Observability span. Grepping a flat projection is how
# verify-tracing.sh reads the same file, and it keeps the assertions below
# readable as assertions rather than as JSON handling.
llmobs_spans() {
  python3 -c "
import json, sys

events = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get('llmobs'):
        events.append(event)

names = {event['span_id']: event.get('name', '') for event in events}
for event in events:
    meta = event.get('meta') or {}
    metrics = event.get('metrics') or {}
    print('|'.join(str(field) for field in (
        meta.get('span.kind', ''),
        event.get('name', ''),
        event.get('status', ''),
        names.get(event.get('parent_id'), ''),
        meta.get('model_name', ''),
        meta.get('model_provider', ''),
        metrics.get('input_tokens', ''),
        metrics.get('output_tokens', ''),
        metrics.get('total_tokens', ''),
        metrics.get('total_cost', ''),
        metrics.get('time_to_first_token', ''),
        meta.get('error.type', ''),
        ','.join(event.get('tags') or []),
        json.dumps(meta.get('input', {}))[:400],
        json.dumps(meta.get('output', {}))[:400],
    )))
" "$CAPTURE"
}

# `name|service|out.host|<root tags>` per APM span, for the two questions that
# are about the trace rather than about the chain.
apm_spans() {
  python3 -c "
import json, sys

for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get('llmobs'):
        continue
    meta = event.get('meta') or {}
    print('|'.join((
        event.get('name', ''),
        event.get('service', ''),
        meta.get('out.host', ''),
        ';'.join(
            '%s=%s' % (key, value)
            for key, value in sorted(meta.items())
            if key.startswith(('support.', 'usr.', 'llm.', 'chaos.'))
        ),
    )))
" "$CAPTURE"
}

# A field out of the first line matching a kind and a name.
field() {
  local kind=$1 name=$2 column=$3
  grep -m1 "^${kind}|${name}|" <<<"$SPANS" | cut -d'|' -f"$column"
}

positive() { python3 -c "import sys; print('true' if float(sys.argv[1] or 0) > float(sys.argv[2]) else 'false')" "$1" "${2:-0}"; }

# ------------------------------------------------------------ the boot state --

section 'The product is switched on'

# LLMObs.enable() returns quietly when DD_LLMOBS_ENABLED is falsy and the
# decorators then run the functions undecorated, so this is the one failure
# mode that looks exactly like success everywhere else.
check "the service reports LLM Observability enabled" \
  "$(docker logs "$PROBE" 2>&1 | grep -q '"llmobs": {"enabled": true' && echo true || echo false)"

# ------------------------------------------------------------- the chain --

section 'A traced chain, with tool calls, token counts and cost'

snapshot
ask
collect
SPANS=$(llmobs_spans)
APM=$(apm_spans)

if [[ -z $SPANS ]]; then
  bad "the sink captured no LLM Observability spans (nothing below can be trusted)"
else
  for expected in "workflow|support.handle_message" \
                  "retrieval|support.load_history" \
                  "llm|chat.completion" \
                  "tool|lookup_booking" \
                  "task|support.persist_message"; do
    check "span ${expected/|/: }" \
      "$(grep -q "^${expected}|" <<<"$SPANS" && echo true || echo false)"
  done

  # 05-FUNCTIONALITY.md § 9 draws one chain per user message, with everything
  # hanging off the workflow. A step that reparents itself is still a span and
  # is no longer a chain.
  for child in support.load_history chat.completion lookup_booking support.persist_message; do
    check "$child hangs off the workflow" \
      "$(awk -F'|' -v n="$child" '$2 == n && $4 == "support.handle_message"' <<<"$SPANS" | grep -q . && echo true || echo false)"
  done

  check "the turn is two model calls, not four" \
    "$([[ $(grep -c '^llm|' <<<"$SPANS") -eq 2 ]] && echo true || echo false)"

  check "llm spans name the model and the provider" \
    "$([[ $(field llm chat.completion 5) == voyager-support-v1 && $(field llm chat.completion 6) == mock ]] && echo true || echo false)"

  check "llm spans carry input tokens" "$(positive "$(field llm chat.completion 7)")"
  check "llm spans carry output tokens" "$(positive "$(field llm chat.completion 8)")"
  check "llm spans carry total tokens" "$(positive "$(field llm chat.completion 9)")"
  check "llm spans carry an estimated cost" "$(positive "$(field llm chat.completion 10)")"

  check "the tool span records its arguments" \
    "$(grep -m1 '^tool|lookup_booking|' <<<"$SPANS" | grep -q "$PNR" && echo true || echo false)"
  check "the tool span records its result and outcome" \
    "$(grep -m1 '^tool|lookup_booking|' <<<"$SPANS" | grep -q 'outcome:ok' && echo true || echo false)"
  check "the retrieval span returns documents" \
    "$(grep -m1 '^retrieval|support.load_history|' <<<"$SPANS" | grep -q 'documents' && echo true || echo false)"
fi

if [[ -z $APM ]]; then
  bad "the sink captured no APM spans (the two checks below cannot be trusted)"
else
  # Turning the openai integration off is what stops the double-counted llm
  # span above. It must not have cost the service map its edge to the model.
  check "the hop to mock-llm is still traced" \
    "$(grep -q '^http.request|voyager-ai-support|mock-llm|' <<<"$APM" && echo true || echo false)"
  check "the root span carries the support facets" \
    "$(grep -E '^fastapi.request\|' <<<"$APM" | grep -q 'llm.model=voyager-support-v1' && echo true || echo false)"
fi

# --------------------------------------------------------- llm_degrade_tools --

section 'llm_degrade_tools=true shows tool-call failures'

chaos_set llm_degrade_tools true
snapshot
ask
collect
chaos_del llm_degrade_tools
SPANS=$(llmobs_spans)
APM=$(apm_spans)

if [[ -z $SPANS ]]; then
  bad "the degraded turn captured nothing (nothing below can be trusted)"
else
  check "a tool span is recorded for the dropped call" \
    "$(grep -q '^tool|support.tool_call_dropped|' <<<"$SPANS" && echo true || echo false)"
  check "that tool span is an error" \
    "$(grep -q '^tool|support.tool_call_dropped|error|' <<<"$SPANS" && echo true || echo false)"
  check "it is grouped as DroppedToolCallError" \
    "$(grep -m1 '^tool|support.tool_call_dropped|' <<<"$SPANS" | cut -d'|' -f12 | grep -qx DroppedToolCallError && echo true || echo false)"
  # Passes by absence, which is why it only runs once spans are known to exist:
  # the model answering in prose is the whole flag, so a real tool call here
  # would mean mock-llm ignored it.
  check "no booking tool actually ran" \
    "$(grep -q '^tool|lookup_booking|' <<<"$SPANS" && echo false || echo true)"
  check "the model still answered" \
    "$(grep -q '^llm|chat.completion|ok|' <<<"$SPANS" && echo true || echo false)"
fi

if [[ -z $APM ]]; then
  bad "the degraded turn captured no APM spans (the check below cannot be trusted)"
else
  check "the root span names the active flag" \
    "$(grep -q 'chaos.active_flags=llm_degrade_tools' <<<"$APM" && echo true || echo false)"
fi

# ----------------------------------------------------------- llm_hallucinate --

section 'llm_hallucinate=true is visible in the output, not in the metrics'

chaos_set llm_hallucinate true
snapshot
ask
collect
chaos_del llm_hallucinate
SPANS=$(llmobs_spans)

if [[ -z $SPANS ]]; then
  bad "the hallucinating turn captured nothing (nothing below can be trusted)"
else
  check "the workflow is tagged with the unverified reference" \
    "$(grep -m1 '^workflow|support.handle_message|' <<<"$SPANS" | grep -q 'answer_quality:unverified_booking_reference' && echo true || echo false)"
  # The point of the flag: a fast, cheap, well-formed, entirely wrong answer.
  check "the turn is still an apparent success" \
    "$(grep -q '^workflow|support.handle_message|ok|' <<<"$SPANS" && echo true || echo false)"
fi

# ------------------------------------------------------------ llm_latency_ms --

section 'llm_latency_ms moves time to first token'

chaos_set llm_latency_ms 3000
snapshot
ask
collect
chaos_del llm_latency_ms
SPANS=$(llmobs_spans)

if [[ -z $SPANS ]]; then
  bad "the slowed turn captured nothing (nothing below can be trusted)"
else
  # The answering round is the one that streams text, so it is the one with a
  # first token to time. mock-llm applies the delay in jitter mode -- half to
  # one and a half times the configured value -- so the floor is well under 3 s.
  slowest=$(cut -d'|' -f1,11 <<<"$SPANS" | grep '^llm|' | cut -d'|' -f2 | sort -g | tail -1)
  check "time to first token passes 1 s (${slowest}s)" "$(positive "$slowest" 1.0)"
fi

# ------------------------------------------------------------------ reverting --

section 'Clearing the flags restores the chain, with no restart'

snapshot
ask
collect
SPANS=$(llmobs_spans)

if [[ -z $SPANS ]]; then
  bad "the recovered turn captured nothing (nothing below can be trusted)"
else
  check "the booking tool runs again" \
    "$(grep -q '^tool|lookup_booking|ok|' <<<"$SPANS" && echo true || echo false)"
  check "no dropped-call span remains" \
    "$(grep -q '^tool|support.tool_call_dropped|' <<<"$SPANS" && echo false || echo true)"
  fast=$(grep -m1 '^llm|chat.completion|ok|support.handle_message|' <<<"$SPANS" | cut -d'|' -f11)
  check "time to first token is back under 1 s" \
    "$(python3 -c "import sys; print('true' if float(sys.argv[1] or 0) < 1.0 else 'false')" "$fast")"
fi

# --------------------------------------------------------------------- result --

echo
echo "  $pass passed, $fail failed"
[[ $fail -eq 0 ]]
