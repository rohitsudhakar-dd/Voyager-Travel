#!/usr/bin/env bash
#
# Push every committed Datadog object to the org that DD_SITE names.
#
#   datadog/apply.sh                     create or update everything
#   datadog/apply.sh --dry-run           validate offline, contact nothing
#   datadog/apply.sh --only monitors     one stage: monitors, composites,
#                                        synthetics, slos, slo-alerts,
#                                        dashboards, notebooks
#
# Reads DD_API_KEY, DD_APP_KEY, DD_SITE and PUBLIC_HOSTNAME from the
# environment, falling back to .env, which is gitignored. It never prints a
# key, and it never passes one on a command line where `ps` could read it.
#
# Safe to run repeatedly: every object is matched to an existing one and
# updated in place rather than duplicated. See datadog/README.md for how that
# matching works and what to name a new file.
set -euo pipefail

cd "$(dirname "$0")/.."

from_env_file() {
  # .env carries inline comments. `cut -d= -f2-` would capture them, giving a
  # DD_SITE of "datadoghq.com  # must match your org" and a DNS failure that
  # looks nothing like the configuration mistake it actually is.
  sed -n "s/^$1=\([^[:space:]#]*\).*/\1/p" .env 2>/dev/null | head -1
}

DD_API_KEY=${DD_API_KEY:-$(from_env_file DD_API_KEY)}
DD_APP_KEY=${DD_APP_KEY:-$(from_env_file DD_APP_KEY)}
DD_SITE=${DD_SITE:-$(from_env_file DD_SITE)}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-$(from_env_file PUBLIC_HOSTNAME)}
export DD_API_KEY DD_APP_KEY DD_SITE PUBLIC_HOSTNAME

dry_run=false
only=all
while (( $# )); do
  case $1 in
    --dry-run) dry_run=true ;;
    --only)
      [[ $# -ge 2 ]] || { echo "--only needs a stage name." >&2; exit 1; }
      only=$2
      shift
      ;;
    -h|--help)
      sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unrecognised argument: $1" >&2
      sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//' >&2
      exit 1
      ;;
  esac
  shift
done

if [[ $dry_run == false ]]; then
  if [[ -z ${DD_API_KEY:-} ]]; then
    echo "DD_API_KEY is not set and .env does not define it." >&2
    echo "Run 'make bootstrap' to create .env, then paste an API key into it." >&2
    exit 1
  fi
  if [[ -z ${DD_APP_KEY:-} ]]; then
    echo "DD_APP_KEY is not set and .env does not define it." >&2
    echo "An application key is separate from an API key: create one under" >&2
    echo "Organisation Settings -> Application Keys in the same org as DD_API_KEY." >&2
    exit 1
  fi
  if [[ -z ${DD_SITE:-} ]]; then
    echo "DD_SITE is not set and .env does not define it." >&2
    echo "It must match the org the keys belong to: datadoghq.com, datadoghq.eu, us5.datadoghq.com, ..." >&2
    exit 1
  fi
fi

# Bash owns the operator contract above -- arguments, key discovery, the error
# messages an operator reads. Everything below is Python because applying these
# objects is a dependency graph, not a loop: a composite monitor needs the IDs
# of its legs, an SLO needs a monitor ID and a Synthetic public ID, a dashboard
# needs SLO IDs. Holding that state across two dozen HTTP calls in bash means
# either a temporary file or a parallel array, and both are how this kind of
# script rots. There is no jq anywhere in Voyager, so Python is doing the JSON
# either way.
DRY_RUN=$dry_run ONLY=$only exec python3 - <<'PY'
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DRY_RUN = os.environ["DRY_RUN"] == "true"
ONLY = os.environ["ONLY"]
SITE = os.environ.get("DD_SITE") or "datadoghq.com"
API = f"https://api.{SITE}"
PUBLIC_HOSTNAME = os.environ.get("PUBLIC_HOSTNAME") or ""

GREEN, YELLOW, RED, BOLD, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[1m", "\033[0m"

created = updated = 0


def die(*lines):
    print(f"\n{RED}{BOLD}apply.sh failed{RESET}", file=sys.stderr)
    for line in lines:
        if line:
            print(f"  {line}", file=sys.stderr)
    sys.exit(1)


def section(text):
    print(f"\n{BOLD}{text}{RESET}")


def note(text):
    print(f"  {text}")


def ok(verb, name):
    colour = GREEN if verb == "created" else YELLOW
    print(f"  {colour}{verb:>8}{RESET} {name}")


def call(method, path, payload=None):
    """One Datadog API call. Keys travel in headers and are never logged."""
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(API + path, data=body, method=method)
    request.add_header("DD-API-KEY", os.environ["DD_API_KEY"])
    request.add_header("DD-APPLICATION-KEY", os.environ["DD_APP_KEY"])
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode()[:1500]
        hints = {
            401: "The API key was rejected. Check DD_API_KEY and that DD_SITE is the site that key belongs to.",
            403: "The application key was rejected. An API key alone cannot write configuration: "
                 "DD_APP_KEY must be a valid application key in the same org, and the user who owns "
                 "it needs the dashboards_write, monitors_write, slos_write and synthetics_write scopes.",
            404: "The object no longer exists in the org. Re-run without --only so the lookup runs again.",
            429: "Rate limited. Wait a minute and re-run; apply.sh is idempotent, so nothing is lost.",
        }
        die(f"{method} {path} returned HTTP {error.code}.", hints.get(error.code), detail)
    except urllib.error.URLError as error:
        die(
            f"Could not reach {API}: {error.reason}.",
            "Check DD_SITE. A wrong site is indistinguishable from a network problem here.",
        )


# ---------------------------------------------------------------- inventory --

def load(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def slug_of(path):
    return os.path.basename(path)[: -len(".json")]


def tags_of(document):
    if "tags" in document:
        return document["tags"]
    return document.get("data", {}).get("attributes", {}).get("tags", [])


def check_slug(path, document):
    """The filename is the identity apply.sh matches on, so it has to agree
    with the tag inside the file. A file renamed without its tag being updated
    would be applied as a brand new object, silently leaving the old one behind
    to keep alerting."""
    slug = slug_of(path)
    tags = tags_of(document)
    if not tags:
        return
    expected = f"voyager_id:{slug}"
    if expected not in tags:
        die(
            f"{path} does not carry the tag {expected}.",
            "The voyager_id tag must match the filename; apply.sh uses it to find the object it "
            "already created. Either rename the file or fix the tag.",
        )


ids = {"monitor": {}, "slo": {}, "synthetics": {}}

# Populated during a dry run so that placeholder resolution can be checked
# without contacting anything. The values are deliberately not plausible IDs.
DRY_IDS = {"monitor": "0", "slo": "dry-run-slo-id", "synthetics": "dry-run-public-id"}

TOKEN = re.compile(r"\{\{(PUBLIC_HOSTNAME|MONITOR_ID|SLO_ID|SYNTHETICS_PUBLIC_ID)(?::([a-z0-9-]+))?\}\}")
QUOTED_MONITOR_ID = re.compile(r'"\{\{MONITOR_ID:([a-z0-9-]+)\}\}"')

KINDS = {"MONITOR_ID": "monitor", "SLO_ID": "slo", "SYNTHETICS_PUBLIC_ID": "synthetics"}
DIRECTORY_OF = {"monitor": "datadog/monitors", "slo": "datadog/slos", "synthetics": "datadog/synthetics"}


def lookup(kind, slug, path):
    table = KINDS[kind]
    if DRY_RUN:
        source = f"{DIRECTORY_OF[table]}/{slug}.json"
        if not os.path.exists(source):
            die(
                f"{path} refers to {kind}:{slug}, but {source} does not exist.",
                "Placeholders are resolved from committed files, so the slug must name one.",
            )
        return DRY_IDS[table]
    if slug not in ids[table]:
        die(
            f"{path} refers to {kind}:{slug}, which has not been applied yet.",
            "Stages run in dependency order, so this means either the slug is wrong or you used "
            "--only and skipped the stage that creates it. Re-run without --only.",
        )
    return str(ids[table][slug])


def resolve(path, text):
    if "{{PUBLIC_HOSTNAME}}" in text and not PUBLIC_HOSTNAME:
        die(
            f"{path} needs PUBLIC_HOSTNAME and it is not set.",
            "Synthetic tests run from Datadog's managed locations, so they need the public "
            "hostname the stack is served on, not localhost.",
        )

    # A quoted token becomes a bare integer: an SLO's `monitor_ids` is an array
    # of integers, but a placeholder can only be written inside a JSON string.
    text = QUOTED_MONITOR_ID.sub(lambda m: lookup("MONITOR_ID", m.group(1), path), text)
    text = TOKEN.sub(
        lambda m: PUBLIC_HOSTNAME if m.group(1) == "PUBLIC_HOSTNAME" else lookup(m.group(1), m.group(2), path),
        text,
    )

    leftover = re.search(r"\{\{[A-Z_]+[^}]*\}\}", text)
    if leftover:
        die(
            f"{path} still contains the unresolved placeholder {leftover.group(0)} after substitution.",
            "apply.sh understands PUBLIC_HOSTNAME, MONITOR_ID, SLO_ID and SYNTHETICS_PUBLIC_ID only.",
        )
    return text


def parse(path):
    text = load(path)
    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        die(f"{path} is not valid JSON: {error}.")
    check_slug(path, document)
    return json.loads(resolve(path, text))


# -------------------------------------------------------------------- apply --

def apply_monitor(path):
    global created, updated
    document = parse(path)
    slug = slug_of(path)
    if DRY_RUN:
        ok("would apply", document["name"])
        return
    existing = call("GET", f"/api/v1/monitor?monitor_tags=voyager_id:{slug}")
    if existing:
        monitor_id = existing[0]["id"]
        response = call("PUT", f"/api/v1/monitor/{monitor_id}", document)
        updated += 1
        ok("updated", document["name"])
    else:
        response = call("POST", "/api/v1/monitor", document)
        created += 1
        ok("created", document["name"])
    ids["monitor"][slug] = response["id"]


def apply_slo(path):
    global created, updated
    document = parse(path)
    slug = slug_of(path)
    if DRY_RUN:
        ok("would apply", document["name"])
        return
    existing = call("GET", f"/api/v1/slo?tags_query=voyager_id:{slug}").get("data") or []
    if existing:
        slo_id = existing[0]["id"]
        response = call("PUT", f"/api/v1/slo/{slo_id}", document)
        updated += 1
        ok("updated", document["name"])
    else:
        response = call("POST", "/api/v1/slo", document)
        created += 1
        ok("created", document["name"])
    ids["slo"][slug] = response["data"][0]["id"]


def apply_synthetic(path):
    global created, updated
    document = parse(path)
    slug = slug_of(path)
    kind = "browser" if document["type"] == "browser" else "api"
    if DRY_RUN:
        ok("would apply", document["name"])
        return
    tests = call("GET", "/api/v1/synthetics/tests").get("tests") or []
    match = next((t for t in tests if f"voyager_id:{slug}" in (t.get("tags") or [])), None)
    if match:
        response = call("PUT", f"/api/v1/synthetics/tests/{kind}/{match['public_id']}", document)
        updated += 1
        ok("updated", document["name"])
    else:
        response = call("POST", f"/api/v1/synthetics/tests/{kind}", document)
        created += 1
        ok("created", document["name"])
    ids["synthetics"][slug] = response["public_id"]


def apply_dashboard(path):
    global created, updated
    document = parse(path)
    if DRY_RUN:
        ok("would apply", document["title"])
        return
    # Dashboards have no tag field the list endpoint can filter on, so the
    # title is the identity. That is why the six titles are fixed in
    # 01-PRD.md § 7 and asserted by scripts/verify-datadog-config.sh: renaming
    # one here means the next apply creates a duplicate rather than updating.
    existing = call("GET", "/api/v1/dashboard").get("dashboards") or []
    match = next((d for d in existing if d.get("title") == document["title"]), None)
    if match:
        call("PUT", f"/api/v1/dashboard/{match['id']}", document)
        updated += 1
        ok("updated", document["title"])
    else:
        call("POST", "/api/v1/dashboard", document)
        created += 1
        ok("created", document["title"])


def apply_notebook(path):
    global created, updated
    document = parse(path)
    name = document["data"]["attributes"]["name"]
    if DRY_RUN:
        ok("would apply", name)
        return
    # Notebooks carry no tags either, so this matches on name as well.
    existing = call("GET", f"/api/v1/notebooks?query={urllib.parse.quote(name)}").get("data") or []
    match = next((n for n in existing if n.get("attributes", {}).get("name") == name), None)
    if match:
        call("PUT", f"/api/v1/notebooks/{match['id']}", document)
        updated += 1
        ok("updated", name)
    else:
        call("POST", "/api/v1/notebooks", document)
        created += 1
        ok("created", name)


def monitors_of_type(*types):
    chosen = []
    for path in sorted(glob.glob("datadog/monitors/*.json")):
        document = json.loads(load(path))
        if document.get("type") in types:
            chosen.append(path)
    return chosen


def plain_monitors():
    return [p for p in sorted(glob.glob("datadog/monitors/*.json")) if p not in monitors_of_type("composite", "slo alert")]


# Ordered by dependency, not by preference. Composite monitors need their legs'
# IDs, SLOs need a monitor ID and a Synthetic public ID, the SLO burn-rate
# alerts need an SLO ID, and the dashboards need SLO IDs for their status
# tiles. Reordering this list breaks a clean-org apply.
STAGES = [
    ("monitors", "Monitors", plain_monitors, apply_monitor),
    ("composites", "Composite monitors", lambda: monitors_of_type("composite"), apply_monitor),
    ("synthetics", "Synthetic tests", lambda: sorted(glob.glob("datadog/synthetics/*.json")), apply_synthetic),
    ("slos", "Service level objectives", lambda: sorted(glob.glob("datadog/slos/*.json")), apply_slo),
    ("slo-alerts", "Error budget burn alerts", lambda: monitors_of_type("slo alert"), apply_monitor),
    ("dashboards", "Dashboards", lambda: sorted(glob.glob("datadog/dashboards/*.json")), apply_dashboard),
    ("notebooks", "Notebooks", lambda: sorted(glob.glob("datadog/notebooks/*.json")), apply_notebook),
]

names = [stage[0] for stage in STAGES]
if ONLY != "all" and ONLY not in names:
    die(f"Unknown stage '{ONLY}'.", "Stages are: " + ", ".join(names) + ".")

if DRY_RUN:
    print(f"{BOLD}Dry run: nothing will be sent to {API}.{RESET}")

for key, title, files, apply in STAGES:
    if ONLY not in ("all", key):
        continue
    paths = files()
    if not paths:
        continue
    section(f"{title} ({len(paths)})")
    for path in paths:
        apply(path)

if DRY_RUN:
    print(f"\n{BOLD}Every file parses and every placeholder resolves.{RESET}")
    print("Nothing was created. Re-run without --dry-run once DD_APP_KEY is valid.")
else:
    print(f"\n{BOLD}{created} created, {updated} updated{RESET}")
    if ONLY == "all":
        note("The checkout availability SLO needs one manual check: confirm that a passing")
        note("Synthetic run is tagged status:0 on synthetics.test_runs. See datadog/README.md.")
PY
