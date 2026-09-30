#!/usr/bin/env bash
#
# Deploy the current branch onto a host that is already running Voyager
# (03-EXECUTION-ORDER.md Phase 13). Invoked as `make deploy`.
#
#   infra/ec2/deploy.sh                 pull, build, restart, migrate, verify
#   infra/ec2/deploy.sh --no-pull       deploy the working tree as it stands
#   infra/ec2/deploy.sh --skip-sourcemaps
#
# The one thing this script exists to guarantee is that the images carry a real
# commit. DD_VERSION and DD_GIT_COMMIT_SHA are baked in at build time, because
# the running container has no git to ask, and if they are wrong there is no
# error anywhere: Error Tracking simply produces stack-frame links that 404,
# and the deployment markers in APM all say `dev`. So the SHA is resolved here,
# passed explicitly, and then read back out of the built images before the
# script will call the deploy a success.
#
# Untested against a real EC2 instance -- see docs/runbooks/04-ec2-deploy.md.
set -euo pipefail

cd "$(dirname "$0")/../.."

pull=true
sourcemaps=true
while (( $# )); do
  case $1 in
    --no-pull) pull=false ;;
    --skip-sourcemaps) sourcemaps=false ;;
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unrecognised argument: $1" >&2; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

env_value() {
  sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1
}

# ------------------------------------------------------------- preflight --

step 'Preflight'

[[ -f .env ]] || die '.env does not exist. Copy .env.example and fill it in.'

# A deployed host must not be able to apply the dev overlay. That is enforced
# by the overlay itself -- it refuses to interpolate an empty
# VOYAGER_DEV_BIND_ADDR -- but the enforcement only holds while the value stays
# empty, and the way it stops being empty is someone re-running `make
# bootstrap` here to fix an unrelated problem.
if [[ -n "$(env_value VOYAGER_DEV_BIND_ADDR)" ]]; then
  die "VOYAGER_DEV_BIND_ADDR is set in .env. On a deployed host that arms
docker-compose.dev.yml, which publishes Postgres, Redis, Kafka and every
service on this machine's interfaces. Blank it before deploying.
See the header of docker-compose.dev.yml."
fi

# The port posture, asserted against the rendered configuration rather than
# trusted. Offline, so it runs before anything is built or restarted.
./scripts/verify-edge.sh --config-only >/dev/null ||
  die 'scripts/verify-edge.sh --config-only failed. Run it directly for the detail.'
echo '  port posture: only the edge publishes a host port'

if [[ $pull == true ]]; then
  step 'Pulling'
  # --ff-only: a merge commit created on a demo box is a commit that exists
  # nowhere else, and every Source Code Integration link from this deploy
  # would point at it.
  git pull --ff-only
fi

# ------------------------------------------------ source code integration --

step 'Resolving the version'

DD_GIT_COMMIT_SHA=$(git rev-parse HEAD)
[[ "$DD_GIT_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  die "git rev-parse HEAD returned '$DD_GIT_COMMIT_SHA', which is not a commit."

# The remote is the first choice because it is the URL that actually resolves.
# .env is the fallback for a checkout with no remote, which is what a repository
# copied onto a host with scp looks like.
DD_GIT_REPOSITORY_URL=$(git config --get remote.origin.url 2>/dev/null || true)
DD_GIT_REPOSITORY_URL=${DD_GIT_REPOSITORY_URL:-$(env_value DD_GIT_REPOSITORY_URL)}
[[ -n "$DD_GIT_REPOSITORY_URL" ]] ||
  die 'No git remote and no DD_GIT_REPOSITORY_URL in .env. Source Code
Integration needs a repository URL; without one, every stack frame in Error
Tracking is a dead end. Set DD_GIT_REPOSITORY_URL in .env.'

# Short SHA, because DD_VERSION is what APM prints on a deployment marker and
# on every version-comparison axis, and forty characters does not fit.
DD_VERSION=$(git rev-parse --short=7 HEAD)

if [[ -n "$(git status --porcelain)" ]]; then
  # Not fatal: a demo host often carries a locally-edited .env or Caddyfile.
  # But the images will claim a commit that does not describe them.
  printf '\033[33m  warning: the working tree is dirty. The images will be stamped\n'
  printf '  %s, which does not include those edits.\033[0m\n' "$DD_VERSION"
fi

export DD_GIT_COMMIT_SHA DD_GIT_REPOSITORY_URL DD_VERSION
echo "  version:    $DD_VERSION"
echo "  commit:     $DD_GIT_COMMIT_SHA"
echo "  repository: $DD_GIT_REPOSITORY_URL"

# ------------------------------------------------------------------ build --

# Only the base file, never the dev overlay. Every target below inherits this.
COMPOSE=(docker compose -f docker-compose.yml)

step 'Building'
"${COMPOSE[@]}" build

step 'Restarting changed services'
# Compose recreates only the services whose image or configuration changed, and
# leaves the rest running. That is as rolling as a single host gets: a service
# being replaced is briefly unavailable, and the Kafka consumers rejoin their
# groups from their committed offsets, so no event is lost -- only delayed.
# postgres, redis and kafka are normally untouched, which is why the data
# survives a deploy.
"${COMPOSE[@]}" up -d --remove-orphans

step 'Verifying the images carry this commit'

# The read-back. Everything above could be correct and the images still be
# stamped from a stale build cache or an earlier `docker compose build` run
# from a shell that had no SHA exported.
stale=()
for container in api-gateway search-service pricing-service booking-service \
                 payment-service loyalty-service notification-worker \
                 ai-support-service mock-gds mock-payments mock-email mock-llm; do
  # docker inspect, not docker exec: the Go images have no shell.
  actual=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null |
    sed -n 's/^DD_GIT_COMMIT_SHA=//p' | head -1)
  [[ "$actual" == "$DD_GIT_COMMIT_SHA" ]] || stale+=("$container=${actual:-unset}")
done
if (( ${#stale[@]} )); then
  die "These containers are not running $DD_GIT_COMMIT_SHA: ${stale[*]}
Source Code Integration would link at the wrong code, or at nothing. Try
'docker compose -f docker-compose.yml build --no-cache' for the services named."
fi
echo "  all 12 tracer-instrumented images carry $DD_VERSION"

# --------------------------------------------------------------- migrate --

step 'Migrating'
# booking-service owns the schema for the whole database (Phase 1). Running
# this after the restart rather than before is deliberate: Alembic is
# idempotent, and a migration applied by the old image is a migration the new
# code has not been tested against.
"${COMPOSE[@]}" run --rm --no-deps booking-service alembic upgrade head

if [[ $sourcemaps == true ]]; then
  step 'Uploading sourcemaps'
  # Not fatal. A deploy that succeeded except for the sourcemap upload leaves a
  # working demo with minified RUM stack traces; a deploy aborted at this point
  # leaves a half-migrated one.
  ./scripts/dd-sourcemaps.sh ||
    printf '\033[33m  sourcemap upload failed; RUM stack traces will be minified\033[0m\n'
fi

step 'Healthcheck'
./scripts/healthcheck.sh
