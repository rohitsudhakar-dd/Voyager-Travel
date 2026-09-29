#!/usr/bin/env bash
#
# The operator's front end to the chaos control plane.
#
#   scripts/chaos.sh status              what is active right now
#   scripts/chaos.sh reset               clear everything, undo side effects
#   scripts/chaos.sh scenarios           list the ten composite scenarios
#   scripts/chaos.sh apply S4            apply one
#   scripts/chaos.sh revert S4           unwind just that one
#   scripts/chaos.sh set gds_latency_ms 1500
#
# Everything goes through the admin API rather than redis-cli, because a reset
# is more than clearing a hash: it also rebuilds the index `db_drop_index`
# dropped, and redis-cli cannot do that.
set -euo pipefail

cd "$(dirname "$0")/.."

GATEWAY=${GATEWAY_URL:-http://localhost:4000}
ADMIN=$GATEWAY/api/v1/admin
SECRET=${ADMIN_SECRET:-$(grep -E '^ADMIN_SECRET=' .env 2>/dev/null | cut -d= -f2-)}

if [[ -z "$SECRET" ]]; then
  echo "ADMIN_SECRET is not set and .env does not define it." >&2
  exit 1
fi

call() {
  local method=$1 path=$2 body=${3:-}
  local args=(-fsS -X "$method" -H "x-voyager-admin: $SECRET")
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' -d "$body")
  if ! curl "${args[@]}" "$ADMIN$path"; then
    echo "api-gateway did not answer on ${GATEWAY}." >&2
    echo "Start it with: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d" >&2
    exit 1
  fi
}

show() { python3 "scripts/lib/chaos_format.py" "$1"; }

case "${1:-status}" in
  status)
    call GET /chaos | show status
    ;;
  reset)
    call POST /chaos/reset | show reset
    ;;
  scenarios)
    call GET /scenarios | show scenarios
    ;;
  apply)
    [[ $# -ge 2 ]] || { echo "usage: $0 apply <S1..S10>" >&2; exit 1; }
    call POST "/scenarios/${2}/apply" | show applied
    ;;
  revert)
    [[ $# -ge 2 ]] || { echo "usage: $0 revert <S1..S10>" >&2; exit 1; }
    call POST "/scenarios/${2}/revert" | show status
    ;;
  set)
    [[ $# -ge 3 ]] || { echo "usage: $0 set <flag> <value>" >&2; exit 1; }
    # Numbers and booleans go in unquoted so the gateway's type validation
    # sees what the flag actually expects; anything else is a JSON string.
    body=$(python3 -c '
import json, sys
name, raw = sys.argv[1], sys.argv[2]
if raw.lower() in ("true", "false"):
    value = raw.lower() == "true"
else:
    try:
        value = int(raw)
    except ValueError:
        try:
            value = float(raw)
        except ValueError:
            value = raw
print(json.dumps({name: value}))' "$2" "$3")
    call PUT /chaos "$body" | show status
    ;;
  status-json)
    call GET /chaos
    ;;
  *)
    sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
