# Runbook — EC2 deployment

The real steps, in order, for taking a fresh instance to a working demo.
`README.md § 6` is the short version; this is the one to follow while doing it.

---

## What is untested, and why

**Nothing in this runbook has been run against a real EC2 instance.** The
machine Phase 13 was built on has no AWS credentials, so none of the following
has been executed even once:

| Artefact | State |
|---|---|
| `infra/ec2/userdata.sh` | Shell-checked and read. Never run on an Ubuntu 22.04 instance. The Docker apt repository steps are the standard documented ones and are the most likely thing to have drifted. |
| Let's Encrypt issuance | Never exercised. Locally, `PUBLIC_HOSTNAME=localhost` makes Caddy sign with its own CA instead, which takes a completely different code path in Caddy — the ACME client is not involved at all. |
| Security-group behaviour | Asserted against the *rendered Compose configuration* (`scripts/verify-edge.sh`), not against a port scan from outside a VPC. |
| `infra/ec2/deploy.sh` | Every step has been read; the `git pull`, build, restart, migrate and healthcheck sequence has not been run end to end on a host with an existing stack. The SHA read-back has been verified locally. |
| The 30-minute claim | `README.md § 6` and the Phase 13 exit criteria say launch-to-demo in under thirty minutes. Unverified. `make build` and `make seed` alone are advertised at roughly 12 and 4 minutes on `m5.xlarge`, which leaves little room, and neither has been timed on that instance type. |

Everything that *could* be verified without AWS was: the edge's routing and
port posture, the dev-overlay refusal, the commit-stamp read-back, the four
test suites, and `make healthcheck` in both its passing and failing states. See
the Phase 13 notes for the evidence.

---

## 1. Launch

| Setting | Value |
|---|---|
| Instance type | `m5.xlarge` (4 vCPU / 16 GB) |
| AMI | Ubuntu 22.04 LTS |
| Storage | 100 GB gp3, 3000 IOPS |
| Inbound | 22 from your IP only; **80 and 443** from your allowed range |
| Outbound | 443 |
| Elastic IP | Yes |
| User data | `infra/ec2/userdata.sh`, with `VOYAGER_REPO_URL` edited to your repository |

**Do not use a burstable instance.** CPU credit throttling on `t3`/`t4g`
distorts latency and profiler demos in ways that are confusing to debug and
embarrassing to hit live.

Port 80 has to be open even if you only ever visit HTTPS: Caddy answers the
ACME HTTP-01 challenge there, and without it no certificate is ever issued.

Point the A record at the Elastic IP **before** you bring the stack up. Caddy
requests a certificate the first time it starts with a real hostname, and
Let's Encrypt's rate limit is five failures per hostname per week.

Ports that must never be reachable: `4000`–`4930`, `5002`, `5432`, `6379`,
`8080`, `8125`, `8126`, `9092`, `9999`, and `19092`. Only the edge on 80/443.

## 2. Configure

```bash
ssh -i <key>.pem ubuntu@<elastic-ip>
cd /opt/voyager
$EDITOR .env
```

`userdata.sh` has already copied `.env.example` to `.env`. Fill in:

| Variable | Notes |
|---|---|
| `DD_API_KEY` | Required. Nothing reaches Datadog without it. |
| `DD_APP_KEY` | Needed by `make dd-apply`. |
| `DD_SITE` | Must match the org the keys belong to. |
| `DD_GIT_REPOSITORY_URL` | Your repository, without the `.git`. Source Code Integration reads it. |
| `PUBLIC_HOSTNAME` | Your domain. Caddy's site address, and what `make dd-sourcemaps` uses as the public path prefix. |
| `VITE_DD_RUM_APPLICATION_ID`, `VITE_DD_RUM_CLIENT_TOKEN` | From your RUM application. Build-time: changing them later needs a rebuild. |
| `POSTGRES_PASSWORD`, `DD_PG_PASSWORD`, `MOCK_DB_PASSWORD`, `JWT_SECRET`, `ADMIN_SECRET` | `openssl rand -hex 32`, one each. |

**Leave `VOYAGER_DEV_BIND_ADDR` empty.** It is what keeps
`docker-compose.dev.yml` — which publishes Postgres, Redis, Kafka and all
fourteen services on the host's interfaces — from being applied here. Empty,
the overlay refuses to interpolate and Compose aborts with a message pointing
at that file's header. `infra/ec2/deploy.sh` refuses to run if it has been
filled in, because the way it gets filled in is someone running `make
bootstrap` on the server to fix an unrelated problem.

Do not run `make bootstrap` on a deployed host. Setting that variable is the
only thing it does that `userdata.sh` has not already done.

## 3. Bring it up

```bash
make build            # ~12 minutes on m5.xlarge
make up
make migrate
make seed             # ~4 minutes; over 1M rows
make up-full          # the load generators
make healthcheck      # must be green
make dd-apply         # dashboards, monitors, SLOs, synthetics
```

`make up` starts the edge, which requests the certificate. `docker logs edge`
shows the ACME exchange; the line to look for is `certificate obtained
successfully`. If it says `no solvers succeeded`, port 80 is not reachable from
the internet.

Then visit `https://<your-domain>`.

## 4. Updating

```bash
make deploy
```

Which is `infra/ec2/deploy.sh`, and in order:

1. Refuses to run if `VOYAGER_DEV_BIND_ADDR` is set.
2. Asserts the port posture offline, before touching anything.
3. `git pull --ff-only` — a merge commit created here would be a commit that
   exists nowhere else, and every Source Code Integration link from the deploy
   would point at it.
4. Resolves `DD_GIT_COMMIT_SHA` from `git rev-parse HEAD` and `DD_VERSION` from
   the short SHA, and fails if either is not a real commit or the repository
   URL is unknown.
5. Builds, then `up -d`, which recreates only the services whose image or
   configuration changed. The data layer is normally untouched, which is why
   the data survives a deploy. Kafka consumers rejoin from their committed
   offsets, so events are delayed rather than lost.
6. **Reads the commit stamp back out of the running containers** and fails the
   deploy if any of the twelve disagrees. This step exists because a stale
   build cache, or a `docker compose build` run from a shell with no SHA
   exported, produces images whose Error Tracking links silently point at
   nothing. Nine of the twelve images on the development host were in exactly
   that state before Phase 13.
7. Migrates. After the restart, not before: Alembic is idempotent, and a
   migration applied by the old image is a migration the new code has not been
   tested against.
8. Uploads sourcemaps. Non-fatal — a failed upload leaves a working demo with
   minified RUM stack traces, whereas aborting here leaves a half-migrated one.
9. `make healthcheck`, and the deploy is not a success until it passes.

### "Rolling" on one host

`docker compose up -d` replaces a changed container, so that service is briefly
unavailable. On a single instance that is as rolling as it gets, and it is
worth saying plainly rather than implying a blue/green that does not exist.
The edge stays up throughout unless the Caddyfile changed, so a request that
arrives mid-restart gets a 502 from the edge rather than a connection refused.

## 5. Cost

- `m5.xlarge` on demand is roughly $140/month left running. Stopping the
  instance keeps the EBS volume and all Postgres and Kafka data.
- The largest Datadog cost driver is Session Replay at 100%. `make idle-mode`
  drops trace sampling, replay sampling and load intensity together, and
  `make demo-mode` puts them back. Run `idle-mode` when you walk away.
- `make down` stops containers and keeps volumes, so you do not re-seed after
  a restart.
