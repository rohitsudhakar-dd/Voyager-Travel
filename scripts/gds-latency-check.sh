#!/usr/bin/env bash
#
# Latency distribution check for mock-gds (phase 2 exit criterion):
# 1,000 requests at default settings should land near p50 180 ms,
# p95 600 ms, p99 1800 ms.
#
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#   ./scripts/gds-latency-check.sh [sample-count]
#
# The run is paced. Each provider allows 60 requests per minute, so four
# providers allow 240; going faster just measures the rate limiter. A full
# 1,000-sample run therefore takes a little over four minutes.
#
# Clear the chaos hash first -- any injected latency is measured too, which
# is correct behaviour and a confusing result.

set -uo pipefail

GDS=${GDS_URL:-http://localhost:4900}
SAMPLES=${1:-1000}
DEPART_DATE=$(date -u -v+14d +%Y-%m-%d 2>/dev/null || date -u -d '+14 days' +%Y-%m-%d)

PROVIDERS=(AMDS SABR TRVP DRCT)
ROUND_DELAY=1  # seconds per round of four requests -> 240/min

samples=$(mktemp)
trap 'rm -f "$samples"' EXIT

rounds=$(( (SAMPLES + 3) / 4 ))
printf 'Sampling %d requests across %d providers, %d rounds, ~%d s.\n\n' \
  "$((rounds * 4))" "${#PROVIDERS[@]}" "$rounds" "$((rounds * ROUND_DELAY))"

rejected=0
for round in $(seq 1 "$rounds"); do
  for provider in "${PROVIDERS[@]}"; do
    body='{"provider":"'$provider'","origin":"LHR","destination":"JFK","departDate":"'$DEPART_DATE'","cabin":"economy"}'
    read -r code seconds < <(curl -s -o /dev/null \
      -w '%{http_code} %{time_total}' \
      -X POST "$GDS/gds/v2/flights/availability" \
      -H 'content-type: application/json' -d "$body")
    if [ "$code" = "200" ]; then
      python3 -c "print(int(float('$seconds') * 1000))" >>"$samples"
    else
      rejected=$((rejected + 1))
    fi
  done
  if [ $(( round % 25 )) -eq 0 ]; then
    printf '  %d/%d rounds\n' "$round" "$rounds"
  fi
  sleep "$ROUND_DELAY"
done

python3 - "$samples" "$rejected" <<'PY'
import statistics
import sys

path, rejected = sys.argv[1], int(sys.argv[2])
values = sorted(int(line) for line in open(path) if line.strip())

def percentile(p: float) -> int:
    if not values:
        return 0
    # Nearest-rank, which is what a latency percentile normally means.
    index = min(len(values) - 1, max(0, round(p / 100 * len(values) + 0.5) - 1))
    return values[index]

# Targets from 03-EXECUTION-ORDER.md phase 2. The tolerances are wide on
# purpose: these are draws from a distribution, not fixed numbers, and a
# thousand samples leaves real variance in the p99.
targets = [("p50", percentile(50), 180, 0.45),
           ("p95", percentile(95), 600, 0.50),
           ("p99", percentile(99), 1800, 0.60)]

print(f"\n  samples   {len(values)}")
print(f"  rejected  {rejected} (rate limited or injected failures)")
print(f"  min/max   {values[0]} / {values[-1]} ms")
print(f"  mean      {round(statistics.mean(values))} ms\n")

failures = 0
for label, actual, target, tolerance in targets:
    low, high = target * (1 - tolerance), target * (1 + tolerance)
    verdict = "PASS" if low <= actual <= high else "FAIL"
    if verdict == "FAIL":
        failures += 1
    colour = "32" if verdict == "PASS" else "31"
    print(f"  \033[{colour}m{verdict}\033[0m  {label}  {actual:>5} ms "
          f"(target {target} ms, accepted {round(low)}-{round(high)})")

print()
sys.exit(1 if failures else 0)
PY
