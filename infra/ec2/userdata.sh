#!/usr/bin/env bash
#
# EC2 user data for a fresh Ubuntu 22.04 instance (02-TECH-STACK.md § 9.2).
# Paste it into the "User data" field when launching, or pass it with
# `aws ec2 run-instances --user-data file://infra/ec2/userdata.sh`.
#
# It installs Docker, clones the repository, and stops. It deliberately does
# not build or start anything: the stack cannot come up until .env has a
# Datadog API key in it, and a user-data script that fails halfway through a
# build leaves an instance whose state nobody can describe.
#
# Set VOYAGER_REPO_URL below before launching, or export it in the user-data
# environment. Everything else has a working default.
#
# Output goes to /var/log/voyager-userdata.log as well as the console, because
# user data runs before anyone can SSH in and the console log is the only
# record of why it failed.
set -euo pipefail

VOYAGER_REPO_URL=${VOYAGER_REPO_URL:-https://github.com/example/voyager.git}
VOYAGER_DIR=${VOYAGER_DIR:-/opt/voyager}
VOYAGER_USER=${VOYAGER_USER:-ubuntu}

exec > >(tee -a /var/log/voyager-userdata.log) 2>&1
echo "=== voyager user-data starting $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- packages --

apt-get update
apt-get install -y ca-certificates curl gnupg git make jq

# Docker Engine from Docker's own repository rather than Ubuntu's, which ships
# docker.io without the Compose plugin. Voyager is driven entirely through
# `docker compose`, and the standalone v1 `docker-compose` does not honour the
# `<<: [*a, *b]` merge lists in docker-compose.yml.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  >/etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# ------------------------------------------------------- container logging --

# Two reasons this has to be json-file with a size cap, and they pull in
# opposite directions:
#
#   The Datadog Agent collects container logs by reading the files the
#   json-file driver writes (the /var/lib/docker/containers mount in
#   docker-compose.yml). Switch the driver to journald or local and log
#   collection silently returns nothing.
#
#   Uncapped, those same files fill a 100 GB volume in a few weeks of
#   continuous load generation, and Postgres is the process that notices first.
mkdir -p /etc/docker
cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
JSON

systemctl enable --now docker
systemctl restart docker

usermod -aG docker "$VOYAGER_USER"

# ------------------------------------------------------------------- repo --

if [[ -d "$VOYAGER_DIR/.git" ]]; then
  echo "$VOYAGER_DIR already holds a checkout; leaving it alone"
else
  git clone "$VOYAGER_REPO_URL" "$VOYAGER_DIR"
fi
chown -R "$VOYAGER_USER:$VOYAGER_USER" "$VOYAGER_DIR"

# A verbatim copy, and never `make bootstrap`. Bootstrap sets
# VOYAGER_DEV_BIND_ADDR, which is what arms docker-compose.dev.yml; running it
# here would hand a deployed host the ability to publish Postgres and Redis on
# its own interfaces. .env.example ships that value empty, so the overlay
# refuses to load on this machine. See the header of docker-compose.dev.yml.
if [[ ! -f "$VOYAGER_DIR/.env" ]]; then
  cp "$VOYAGER_DIR/.env.example" "$VOYAGER_DIR/.env"
  chown "$VOYAGER_USER:$VOYAGER_USER" "$VOYAGER_DIR/.env"
  chmod 600 "$VOYAGER_DIR/.env"
fi

echo "=== voyager user-data finished $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="

cat <<EOF

--------------------------------------------------------------------------
Voyager is checked out at $VOYAGER_DIR. Nothing is running yet.

  ssh -i <key>.pem $VOYAGER_USER@<elastic-ip>
  cd $VOYAGER_DIR
  \$EDITOR .env

Fill in, at minimum:

  DD_API_KEY                       nothing reaches Datadog without it
  DD_APP_KEY                       needed by 'make dd-apply'
  DD_SITE                          must match the org the keys belong to
  DD_GIT_REPOSITORY_URL            $VOYAGER_REPO_URL, without the .git
  PUBLIC_HOSTNAME                  your domain; Caddy gets a certificate for it
  POSTGRES_PASSWORD, DD_PG_PASSWORD, MOCK_DB_PASSWORD, JWT_SECRET, ADMIN_SECRET
                                   openssl rand -hex 32, one each
  VITE_DD_RUM_APPLICATION_ID, VITE_DD_RUM_CLIENT_TOKEN
                                   from your Datadog RUM application

Leave VOYAGER_DEV_BIND_ADDR empty. It is what keeps docker-compose.dev.yml --
which publishes Postgres, Redis, Kafka and every service on the host -- from
being applied here.

Then, in order (README.md § 6.2):

  make build            ~12 minutes
  make up
  make migrate
  make seed             ~4 minutes
  make up-full
  make healthcheck      must be green before you show anyone
  make dd-apply

Point an A record at this instance's Elastic IP before 'make up'. Caddy
answers the ACME challenge on port 80, so that port has to be open to the
internet even if you only ever use HTTPS.

Log out and back in first if 'docker ps' says permission denied -- the
$VOYAGER_USER account was added to the docker group after your session opened.
--------------------------------------------------------------------------
EOF
