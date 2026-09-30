#!/usr/bin/env bash
#
# Upload the web-ui sourcemaps so RUM Error Tracking shows un-minified stack
# traces (03-EXECUTION-ORDER.md Phase 9 item 9, wired into `make deploy`).
#
#   make dd-sourcemaps
#   scripts/dd-sourcemaps.sh --dry-run     resolve and validate, upload nothing
#
# Three values have to agree exactly or the upload is accepted and then never
# matches anything:
#
#   service            voyager-web, the same DD_SERVICE the RUM SDK reports
#   version            DD_VERSION, the same value compiled into the bundle
#   path prefix        the public URL the bundle is served from
#
# The maps come out of the image's build stage rather than a separate build on
# this machine. apps/web-ui/Dockerfile deletes them from the runtime stage on
# purpose -- they are for Datadog, not for the internet -- but the build stage
# still has them, and extracting from there is the only way to be certain the
# maps describe the bundle that is actually being served rather than a
# lookalike produced by a second, differently-cached build.
set -euo pipefail

cd "$(dirname "$0")/.."

env_value() {
  sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1
}

DD_API_KEY=${DD_API_KEY:-$(env_value DD_API_KEY)}
DD_SITE=${DD_SITE:-$(env_value DD_SITE)}
DD_SITE=${DD_SITE:-datadoghq.com}
DD_VERSION=${DD_VERSION:-$(env_value DD_VERSION)}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-$(env_value PUBLIC_HOSTNAME)}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-localhost}

dry_run=false
[[ ${1:-} == --dry-run ]] && dry_run=true

die() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

if [[ $dry_run == false && -z "$DD_API_KEY" ]]; then
  die 'DD_API_KEY is not set and .env does not define it.'
fi

if [[ -z "$DD_VERSION" || "$DD_VERSION" == dev ]]; then
  die "DD_VERSION is '${DD_VERSION:-unset}'. Sourcemaps are matched to a
version, so uploading against 'dev' overwrites the previous deploy's maps and
resolves nothing. infra/ec2/deploy.sh sets it from the git SHA; to upload by
hand, export it the same way:

  DD_VERSION=\$(git rev-parse --short=7 HEAD) make dd-sourcemaps"
fi

# The public origin the browser fetched the bundle from. It has to match the
# `file` field in the maps' eventual resolution, which is why it is derived
# from PUBLIC_HOSTNAME rather than configured separately -- two sources for one
# value is two values.
MINIFIED_PREFIX="https://$PUBLIC_HOSTNAME/"

printf '\033[1mSourcemaps for voyager-web %s -> %s\033[0m\n' "$DD_VERSION" "$DD_SITE"
printf '  path prefix: %s\n' "$MINIFIED_PREFIX"

# ---------------------------------------------------------------- extract --

# Read the build args out of the rendered Compose configuration instead of
# restating them. Restated, they drift, and the symptom is a bundle hash that
# does not match anything Datadog holds.
# Read with a loop rather than mapfile: macOS ships bash 3.2, where mapfile does
# not exist, and under `set -e` its absence aborts the script before the upload.
build_args=()
while IFS= read -r build_arg; do
  build_args+=("$build_arg")
done < <(docker compose -f docker-compose.yml config --format json |
  python3 -c "
import json, sys

args = json.load(sys.stdin)['services']['web-ui'].get('build', {}).get('args') or {}
for name, value in sorted(args.items()):
    print(f'--build-arg={name}={value if value is not None else \"\"}')
")

if (( ${#build_args[@]} == 0 )); then
  die 'Could not read web-ui build args from the Compose configuration.'
fi

stage_image=voyager-web-sourcemaps
printf '\n  building the web-ui build stage (cached if the image was just built)\n'
# --target: the classic builder supports it, which matters because this daemon
# has no buildx. Cached, this is a no-op and the dist it yields is the same
# layer the runtime image copied from.
docker build --target build -t "$stage_image" \
  -f apps/web-ui/Dockerfile "${build_args[@]}" . >/dev/null

# Inside the repo, not $TMPDIR. Colima shares $HOME with the VM and nothing else,
# so a macOS temp directory bind-mounts as an empty one -- the upload then reports
# "no sourcemaps detected" having been handed 32 of them.
mkdir -p tmp
workdir=$(mktemp -d "$PWD/tmp/sourcemaps.XXXXXX")
trap 'rm -rf "$workdir"; docker rm -f "$stage_container" >/dev/null 2>&1 || true' EXIT
stage_container=$(docker create "$stage_image" true)
docker cp "$stage_container:/app/dist" "$workdir/dist"

maps=$(find "$workdir/dist" -name '*.map' | wc -l | tr -d ' ')
if [[ "$maps" -eq 0 ]]; then
  die "The build stage produced no .map files. vite.config.ts must keep
build.sourcemap: true."
fi
printf '  extracted %s sourcemaps\n' "$maps"

# ----------------------------------------------------------------- upload --

# datadog-ci runs in a container for the same reason everything else does:
# there is no Node on the host (02-TECH-STACK.md § 11 notwithstanding, the
# deployed host has only Docker).
#
# The key is passed under both names because datadog-ci reads DD_API_KEY for the
# upload but its own telemetry reads DATADOG_API_KEY, and that second reader runs
# first -- including under --dry-run, where it otherwise aborts before validating
# anything.
upload_args=(sourcemaps upload /work/dist
  --service voyager-web
  --release-version "$DD_VERSION"
  --minified-path-prefix "$MINIFIED_PREFIX")
[[ $dry_run == true ]] && upload_args+=(--dry-run)

printf '\n'
docker run --rm \
  -v "$workdir:/work" \
  -e DD_API_KEY="$DD_API_KEY" \
  -e DATADOG_API_KEY="$DD_API_KEY" \
  -e DATADOG_SITE="$DD_SITE" \
  node:20.17-alpine \
  npx --yes @datadog/datadog-ci@2 "${upload_args[@]}"
