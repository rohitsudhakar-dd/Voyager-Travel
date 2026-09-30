#!/usr/bin/env bash
#
# Switch between the two ingestion modes in 02-TECH-STACK.md § 8.
#
#   make demo-mode      everything sampled, replay on, load at 2x
#   make idle-mode      20% sampled, replay at 20%, load at 1x
#
# This is the one control in Voyager that is not a chaos flag, and it is not
# one for a reason: DD_TRACE_SAMPLE_RATE and DD_TRACE_SAMPLING_RULES are read
# by each tracer once, at process start. So the values are written to .env and
# the application containers are recreated. That takes about half a minute and
# it is why this is a mode you set before a demo rather than during one.
#
# The load-generator intensity is the exception -- the generators poll
# voyager:loadgen, so that part takes effect within a few seconds and needs no
# restart.
set -euo pipefail

cd "$(dirname "$0")/.."

# The same file set the rest of the operator interface uses, exported by the
# Makefile. A deployed host resolves this to the base file alone, because
# VOYAGER_DEV_BIND_ADDR is empty there.
read -ra COMPOSE <<<"${VOYAGER_COMPOSE:-docker compose -f docker-compose.yml}"

# This script rebuilds web-ui, so it has to resolve the commit stamp the same
# way the Makefile and deploy.sh do. Rebuilding without it would quietly strip
# Source Code Integration from the bundle.
if [[ -z "${DD_GIT_COMMIT_SHA:-}" ]] && git rev-parse HEAD >/dev/null 2>&1; then
  DD_GIT_COMMIT_SHA=$(git rev-parse HEAD)
  export DD_GIT_COMMIT_SHA
fi

env_value() {
  sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1
}

mode=${1:-}
case "$mode" in
  demo|idle) ;;
  *) echo "usage: $0 <demo|idle>" >&2; exit 1 ;;
esac

[[ -f .env ]] || { echo ".env does not exist. Run 'make bootstrap'." >&2; exit 1; }

# § 16 excludes /health and /ready from trace sampling, and that exclusion
# belongs in both modes: roughly twenty probes a minute per service, carrying
# no information about the product, is not something demo-mode wants back in
# APM. § 8 previously described demo-mode as having no rules at all, which
# contradicted § 16; § 8 now says this, and these two rules are the difference.
HEALTH_RULES='{"service":"*","resource":"GET /health","sample_rate":0.0},{"service":"*","resource":"GET /ready","sample_rate":0.0}'

if [[ "$mode" == demo ]]; then
  sample_rate=1.0
  # Compact, and with no '#' anywhere in it: Compose strips an inline comment
  # from the first ' #' in a .env value, and a truncated JSON array is a
  # sampling configuration the tracer rejects at boot.
  sampling_rules="[$HEALTH_RULES]"
  replay_rate=100
  intensity=2
else
  sample_rate=0.2
  # Booking and payment stay at 1.0 because they are the two services whose
  # traces anyone ever goes looking for after the fact, and 20% of a checkout
  # is a trace with holes in it.
  sampling_rules="[$HEALTH_RULES,{\"service\":\"voyager-booking\",\"sample_rate\":1.0},{\"service\":\"voyager-payment\",\"sample_rate\":1.0},{\"service\":\"*\",\"sample_rate\":0.2}]"
  replay_rate=20
  intensity=1
fi

printf '\033[1mSwitching to %s-mode\033[0m\n' "$mode"

# Rewritten in Python rather than with sed: the rules are JSON, so the
# replacement text is full of the characters sed treats as syntax.
python3 - "$sample_rate" "$sampling_rules" "$replay_rate" <<'PY'
import re
import sys

sample_rate, sampling_rules, replay_rate = sys.argv[1:4]
wanted = {
    'DD_TRACE_SAMPLE_RATE': sample_rate,
    'DD_TRACE_SAMPLING_RULES': sampling_rules,
    'RUM_SESSION_REPLAY_SAMPLE_RATE': replay_rate,
}

with open('.env') as handle:
    lines = handle.read().splitlines()

seen = set()
for index, line in enumerate(lines):
    match = re.match(r'^([A-Z0-9_]+)=', line)
    if not match or match.group(1) not in wanted:
        continue
    name = match.group(1)
    seen.add(name)
    # The trailing comment is the only documentation these variables have in
    # .env, so it is preserved rather than rewritten.
    comment = re.search(r'\s+(#.*)$', line)
    lines[index] = f'{name}={wanted[name]}' + (f'  {comment.group(1)}' if comment else '')

for name in wanted:
    if name not in seen:
        lines.append(f'{name}={wanted[name]}')

with open('.env', 'w') as handle:
    handle.write('\n'.join(lines) + '\n')

for name, value in wanted.items():
    print(f'  {name}={value}')
PY

printf '\n  recreating the containers whose tracers read those values\n'
"${COMPOSE[@]}" up -d

# web-ui needs a rebuild rather than a restart: Vite substitutes
# RUM_SESSION_REPLAY_SAMPLE_RATE into the bundle at build time, so a container
# restarted with a new value keeps serving the compiled-in one -- which reads
# as a caching bug rather than a configuration mistake.
printf '\n  rebuilding web-ui, whose replay sampling is compiled in\n'
"${COMPOSE[@]}" up -d --build web-ui

# ------------------------------------------------------------- loadgen --

ADMIN_SECRET=${ADMIN_SECRET:-$(env_value ADMIN_SECRET)}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-$(env_value PUBLIC_HOSTNAME)}
EDGE=${EDGE_URL:-https://${PUBLIC_HOSTNAME:-localhost}}
concurrency=${LOADGEN_BROWSER_CONCURRENCY:-$(env_value LOADGEN_BROWSER_CONCURRENCY)}

printf '\n  setting load intensity to %sx\n' "$intensity"
if ! curl -sk --max-time 15 -o /dev/null -w '' -X POST \
  -H "x-voyager-admin: ${ADMIN_SECRET}" -H 'content-type: application/json' \
  -d "{\"api\":{\"enabled\":true,\"intensity\":$intensity},\"browser\":{\"enabled\":true,\"concurrency\":${concurrency:-2}}}" \
  "$EDGE/api/v1/admin/loadgen"; then
  printf '\033[33m  the gateway did not accept the loadgen setting; sampling is still applied\033[0m\n'
fi

if ! docker ps --format '{{.Names}}' | grep -qx loadgen-api; then
  printf '\033[33m  loadgen-api is not running -- the intensity is stored and will\n'
  printf '  apply as soon as you start it with `make up-full`\033[0m\n'
fi

printf '\n\033[32m%s-mode active.\033[0m Verify with: make healthcheck\n' "$mode"
