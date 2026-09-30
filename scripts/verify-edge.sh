#!/usr/bin/env bash
#
# Phase 13 exit criteria for the edge proxy and the port posture it exists to
# make possible.
#
#   scripts/verify-edge.sh                 configuration checks, then live ones
#   scripts/verify-edge.sh --config-only   configuration checks only; needs no
#                                          running stack, so infra/ec2/deploy.sh
#                                          can run it before it builds anything
#
# Requires the edge to be running for the live half:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# Two of these checks are the reason the file exists.
#
# The first is that /api survives the proxy with its prefix. api-gateway mounts
# every route under /api/v1, so a proxy that strips the prefix turns the whole
# API into Fastify 404s that read like an application bug. `handle` preserves
# it and `handle_path` does not, and the difference is invisible until someone
# makes a request. This has already been misdiagnosed once as a gateway bug.
#
# The second is that nothing but the edge is reachable. That check passes by
# absence, and an assertion that passes by absence also passes when nothing was
# measured -- so each one here first proves it can see a published port at all
# by finding the edge's own, and refuses to conclude anything from an empty
# parse.
set -uo pipefail

cd "$(dirname "$0")/.."

env_value() {
  # .env carries inline comments; cut -d= -f2- would capture them.
  sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1
}

PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-$(env_value PUBLIC_HOSTNAME)}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-localhost}
ADMIN_SECRET=${ADMIN_SECRET:-$(env_value ADMIN_SECRET)}
EDGE=${EDGE_URL:-https://$PUBLIC_HOSTNAME}

# -k because a demo host without a domain gets a certificate from Caddy's own
# CA. Whether the certificate chains to a public root is a question for the
# browser, not for a routing test.
CURL=(curl -sk --max-time 20)

# The § 9 deny list, expanded from the port convention in § 1. 19092 joins it
# because docker-compose.dev.yml adds a second Kafka listener that the § 9 list
# predates, and a broker on a public interface is a broker anyone can produce
# to.
FORBIDDEN_PORTS=(4000 4010 4020 4030 4040 4050 4060 4070 4900 4910 4920 4930
                 5002 5432 6379 8080 8125 8126 9092 9999 19092)

config_only=false
[[ ${1:-} == --config-only ]] && config_only=true

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

assert_contains() {
  local label=$1 haystack=$2 needle=$3
  if [[ -z "$haystack" ]]; then
    bad "$label (nothing to search -- the response was empty)"
  elif [[ "$haystack" == *"$needle"* ]]; then
    ok "$label"
  else
    bad "$label (no '$needle' in: $(printf '%.90s' "$haystack"))"
  fi
}

printf '\033[1mPhase 13 verification: the edge proxy and the port posture\033[0m\n'

# ------------------------------------------------- the production posture --

section 'The production compose configuration publishes only the edge'

prod_json=$(docker compose -f docker-compose.yml config --format json 2>/dev/null)

if [[ -z "$prod_json" ]]; then
  bad 'docker compose could not render docker-compose.yml -- every check below would pass vacuously'
else
  read -r service_count publishers edge_ports leaked < <(python3 -c "
import json, sys

doc = json.loads(sys.stdin.read())
services = doc.get('services', {})

published = {}
for name, spec in services.items():
    for mapping in spec.get('ports') or []:
        port = str(mapping.get('published') or '')
        if port:
            published.setdefault(name, set()).add(port)

forbidden = set('''$(printf '%s ' "${FORBIDDEN_PORTS[@]}")'''.split())
leaked = sorted(
    f'{name}:{port}'
    for name, ports in published.items()
    for port in ports
    if port in forbidden
)

print(
    len(services),
    ','.join(sorted(published)) or 'none',
    ','.join(sorted(published.get('edge', ()))) or 'none',
    ','.join(leaked) or 'none',
)
" <<<"$prod_json")

  # The positive control. Everything after it is an absence, and an absence
  # proves nothing unless the parse demonstrably sees a presence.
  assert 'the rendered configuration has all 19 base services' "$service_count" 19
  assert 'the parser can see published ports at all (the edge binds 80 and 443)' "$edge_ports" '443,80'
  assert 'the edge is the only service that binds a host port' "$publishers" edge
  assert 'no port from the 02-TECH-STACK.md § 9 deny list is published' "$leaked" none
fi

section 'The dev overlay cannot be applied on a deployed host'

# A deployed host has VOYAGER_DEV_BIND_ADDR empty, because infra/ec2/userdata.sh
# copies .env.example verbatim and `make bootstrap` -- which is what sets it --
# is never run there. Simulated with a rewritten env file rather than an empty
# shell variable, because Compose's precedence between an empty shell value and
# a populated .env is not something to make a security control depend on.
deployed_env=$(mktemp)
trap 'rm -f "$deployed_env"' EXIT
sed 's/^VOYAGER_DEV_BIND_ADDR=.*/VOYAGER_DEV_BIND_ADDR=/' .env >"$deployed_env" 2>/dev/null

refusal=$(docker compose --env-file "$deployed_env" \
  -f docker-compose.yml -f docker-compose.dev.yml config 2>&1 >/dev/null)
refusal_code=$?

assert 'compose refuses the overlay when VOYAGER_DEV_BIND_ADDR is empty' \
  "$([[ $refusal_code -ne 0 ]] && echo refused || echo accepted)" refused
assert_contains 'the refusal names the file an operator has to go read' \
  "$refusal" 'docker-compose.dev.yml'

# And the other half: armed, the overlay must still bind loopback only. The
# deny list above is about the production file; this is about the local one.
dev_json=$(docker compose -f docker-compose.yml -f docker-compose.dev.yml config --format json 2>/dev/null)
if [[ -z "$dev_json" ]]; then
  bad 'the dev overlay does not render even with VOYAGER_DEV_BIND_ADDR set -- is it set in .env?'
else
  read -r dev_published dev_public < <(python3 -c "
import json, sys

services = json.loads(sys.stdin.read()).get('services', {})
published, public = 0, []
for name, spec in services.items():
    for mapping in spec.get('ports') or []:
        if not mapping.get('published'):
            continue
        published += 1
        host_ip = mapping.get('host_ip') or '0.0.0.0'
        # The edge is supposed to be on every interface. Nothing else is.
        if name != 'edge' and host_ip not in ('127.0.0.1', '::1'):
            public.append(f\"{name}:{mapping['published']}@{host_ip}\")

print(published, ','.join(sorted(public)) or 'none')
" <<<"$dev_json")

  if [[ "${dev_published:-0}" -gt 1 ]]; then
    ok "the armed overlay publishes ports to check ($dev_published of them)"
  else
    bad "the armed overlay published ${dev_published:-0} ports -- the next check would be vacuous"
  fi
  assert 'every port the overlay publishes is on loopback' "$dev_public" none
fi

if [[ $config_only == true ]]; then
  section 'Live checks skipped (--config-only)'
  printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
  [[ $fail -eq 0 ]]
  exit
fi

# ------------------------------------------------------- live, through it --

section 'The edge is up and it is the edge answering'

# Liveness first, and on the internal listener, so that a failure here is
# unambiguously "Caddy is not running" rather than "something is wrong
# downstream". Every check below it would otherwise fail for the wrong reason.
edge_alive=$(docker exec edge wget -q -O - http://127.0.0.1:2019/metrics 2>/dev/null | head -1)
assert_contains 'the edge container answers on its internal metrics listener' \
  "$edge_alive" '#'

http_code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "http://$PUBLIC_HOSTNAME/")
assert 'plain HTTP redirects to HTTPS' "$http_code" 308

server_header=$("${CURL[@]}" -o /dev/null -D - "$EDGE/" | tr -d '\r')
assert_contains 'the response carries the HSTS header' \
  "$server_header" 'strict-transport-security: max-age=31536000'
assert_contains 'the response carries X-Content-Type-Options' \
  "$server_header" 'x-content-type-options: nosniff'

section 'A request through the edge reaches the gateway with /api intact'

# This is the check. api-gateway mounts /api/v1/ref/airports and nothing at
# /v1/ref/airports, so a 200 here is only possible if the prefix arrived
# unchanged. A proxy that stripped it would produce the gateway's own 404.
body=$("${CURL[@]}" -o /tmp/voyager-edge-ref.json -w '%{http_code}' \
  "$EDGE/api/v1/ref/airports?q=LON")
assert 'GET /api/v1/ref/airports through the edge is 200' "$body" 200
assert_contains 'and the gateway answered with real reference data' \
  "$(cat /tmp/voyager-edge-ref.json 2>/dev/null)" '"LHR"'

# The converse: an /api path that does not exist must come back as the
# gateway's JSON envelope, not as the SPA's index.html. If /api/* were falling
# through to web-ui, the check above could still pass from a cached bundle
# while every real API call 404'd.
not_found_type=$("${CURL[@]}" -o /tmp/voyager-edge-404.json -w '%{content_type}' \
  "$EDGE/api/v1/does-not-exist")
assert_contains 'an unknown /api path is answered by the gateway, not the SPA' \
  "$not_found_type" 'application/json'
assert_contains 'and it uses the § 13.2 error envelope' \
  "$(cat /tmp/voyager-edge-404.json 2>/dev/null)" '"code":"not_found"'

# Request headers have to cross the proxy verbatim or the ops console cannot
# authenticate, and /admin is how every scenario in 01-PRD.md § 8 is driven.
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$EDGE/api/v1/admin/chaos")
assert 'the admin API is gated through the edge as well' "$code" 401

if [[ -n "$ADMIN_SECRET" ]]; then
  flags=$("${CURL[@]}" -H "x-voyager-admin: $ADMIN_SECRET" "$EDGE/api/v1/admin/chaos" |
    python3 -c "import json,sys; print(len(json.load(sys.stdin)['flags']))" 2>/dev/null)
  assert 'the X-Voyager-Admin header survives the proxy (all 38 flags)' "${flags:-0}" 38
else
  bad 'ADMIN_SECRET is not set and .env does not define it -- header pass-through untested'
fi

section 'The edge serves the SPA, including deep links'

index=$("${CURL[@]}" -o /tmp/voyager-edge-index.html -w '%{http_code} %{content_type}' "$EDGE/")
assert 'GET / is 200 text/html' "$index" '200 text/html'

# /manage is a React route with no file behind it. Without the SPA fallback
# this is a 404, and every link anyone pastes into Slack during a demo breaks.
deep=$("${CURL[@]}" -o /dev/null -w '%{http_code} %{content_type}' "$EDGE/manage")
assert 'a deep link to a client-side route is 200 text/html' "$deep" '200 text/html'

encoding=$("${CURL[@]}" -H 'Accept-Encoding: gzip, zstd' -o /dev/null -D - "$EDGE/" |
  tr -d '\r' | sed -n 's/^content-encoding: //p')
if [[ "$encoding" == gzip || "$encoding" == zstd ]]; then
  ok "the edge compresses the entry document (content-encoding: $encoding)"
else
  bad "the entry document came back with content-encoding '$encoding', want gzip or zstd"
fi

# The hashed bundle is the only thing safe to cache forever, and it is also
# the positive control for the 404 checks in the next section: if assets did
# not load at all, those 404s would mean nothing.
asset=$(sed -n 's/.*src="\(\/assets\/[^"]*\.js\)".*/\1/p' /tmp/voyager-edge-index.html | head -1)
if [[ -z "$asset" ]]; then
  bad 'index.html references no /assets/*.js bundle -- is this really the SPA?'
else
  asset_headers=$("${CURL[@]}" -o /dev/null -D - -w '%{http_code}' "$EDGE$asset")
  assert_contains "the bundle at $asset is served" "$asset_headers" '200'
  assert_contains 'and is cached immutably' "$(tr -d '\r' <<<"$asset_headers")" 'immutable'
fi

section 'The edge does not serve what must never be public'

if [[ -n "$asset" ]]; then
  map=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$EDGE${asset}.map")
  assert "the sourcemap for $asset is not served" "$map" 404
else
  bad 'no bundle was found, so the sourcemap check has nothing to ask for'
fi

worker=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$EDGE/mockServiceWorker.js")
assert 'the browser fixture worker is not served' "$worker" 404

# Finally, the running stack rather than the rendered file: whatever is up
# right now, only the edge may be on a public interface. True on a workstation
# with the overlay armed and on a deployed host without it, so it cannot go
# stale in one environment while being checked in the other.
read -r bound_count bound_public < <(docker ps --format '{{.Names}}\t{{.Ports}}' |
  python3 -c "
import re, sys

total, public = 0, []
for line in sys.stdin:
    name, _, ports = line.partition('\t')
    for mapping in re.finditer(r'(\S+?):(\d+)->', ports):
        host_ip, port = mapping.group(1), mapping.group(2)
        total += 1
        if name != 'edge' and host_ip not in ('127.0.0.1', '[::1]'):
            public.append(f'{name}:{port}@{host_ip}')

print(total, ','.join(sorted(set(public))) or 'none')
")

if [[ "${bound_count:-0}" -gt 0 ]]; then
  ok "the running stack publishes $bound_count host ports to check"
else
  bad 'no container publishes a host port at all -- is the stack up? the next check would be vacuous'
fi
assert 'only the edge is bound to a public interface' "$bound_public" none

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
