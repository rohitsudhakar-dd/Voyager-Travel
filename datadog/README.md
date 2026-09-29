# Voyager observability as code

Every dashboard, monitor, SLO, synthetic test and notebook in the Voyager demo
org is defined by a file in this directory. Nothing is configured by hand in the
Datadog UI. `./apply.sh` pushes the whole set; `make dd-apply` wraps it.

The reason to work this way in a demo stack is the same as in production, only
sharper: the demo is torn down and rebuilt, and a dashboard that only exists in
one org's UI does not survive that. It also means a review can catch a wrong
metric name before an audience does.

## Layout

| Path | Datadog API | Contents |
| --- | --- | --- |
| `dashboards/` | `/api/v1/dashboard` | The six dashboards of `01-PRD.md § 7`, one file each, prefixed `d1`–`d6` in the order that document lists them |
| `monitors/` | `/api/v1/monitor` | Every monitor in `01-PRD.md § 6.2`, including the `composite-` monitor and the two `slo-` burn-rate alerts |
| `slos/` | `/api/v1/slo` | The three service level objectives |
| `synthetics/` | `/api/v1/synthetics/tests` | The five synthetic tests: two single-step API, one multistep API, two browser |
| `notebooks/` | `/api/v1/notebooks` | The incident postmortem template |
| `apply.sh` | — | Idempotent create-or-update for all of the above |

Monitor filenames carry a prefix naming the signal source rather than the
service, because that is how you look for them: `apm-`, `business-`, `log-`,
`integration-`, `dbm-`, `kafka-`, `composite-`, `slo-`.

## How `apply.sh` achieves idempotency

`apply.sh` must be safe to run repeatedly — on a rebuilt stack, from a
half-finished previous run, or twice by accident. It never creates a second copy
of anything. How it recognises an object it has already created depends on what
the API gives it to work with:

**Monitors, SLOs and synthetic tests** are matched on a tag, `voyager_id:<slug>`,
where `<slug>` is the filename without its `.json` extension. Every one of those
files must carry that tag, and `apply.sh` refuses to push a file where the tag
and the filename disagree — a mismatch means two files are competing to own one
Datadog object, and the symptom is a monitor that silently reverts every time
someone applies. `verify-datadog-config.sh` checks the same thing statically.

**Dashboards and notebooks** have no tag field in their API schema, so they are
matched on exact `title` (dashboards) or `name` (notebooks). This is the weaker
strategy and the one to be careful with: **renaming a dashboard creates a
second dashboard** rather than renaming the existing one. If you rename one,
delete the old one in the UI, or accept that you now have two.

Because identity is derived from the file, the numeric IDs Datadog assigns are
never committed. Where one object has to reference another — a composite monitor
naming its legs, an SLO built on a monitor, a dashboard widget showing an SLO —
the file holds a placeholder that `apply.sh` resolves at push time:

| Placeholder | Resolves to |
| --- | --- |
| `{{MONITOR_ID:<slug>}}` | The numeric id of the monitor from `monitors/<slug>.json` |
| `{{SLO_ID:<slug>}}` | The id of the SLO from `slos/<slug>.json` |
| `{{SYNTHETICS_PUBLIC_ID:<slug>}}` | The public id of the test from `synthetics/<slug>.json` |
| `{{PUBLIC_HOSTNAME}}` | `PUBLIC_HOSTNAME` from the environment or `.env` |

This is why `apply.sh` pushes in stages, in dependency order: plain monitors,
then composites, then synthetics, then SLOs, then burn-rate alerts, then
dashboards, then notebooks. Running a later stage alone will fail on an
unresolvable placeholder rather than push a broken object.

## Running it

```
make dd-apply                # everything
./apply.sh --dry-run         # parse, resolve placeholders, make no network calls
./apply.sh dashboards        # one stage
./apply.sh --help
```

`DD_API_KEY` and `DD_APP_KEY` are read from the environment, falling back to
`.env` (gitignored). They travel only in request headers, are never echoed, and
are never passed as command-line arguments. The app key must be an *application*
key from Organisation Settings, in the same org as the API key; an API key in
that slot produces a 403 that reads like a permissions problem.

Always run `../scripts/verify-datadog-config.sh` first. It is entirely static —
no keys, no network, no running stack — and it checks the class of mistake that
the Datadog API will happily accept: a metric, span, service, RUM view or chaos
flag that does not exist. Those do not error. They draw an empty graph.

## Adding a dashboard

1. Copy the nearest existing file in `dashboards/`. Give it the next `dN-` prefix.
2. Set a `title` beginning `Voyager — `. This is the idempotency key, so treat it
   as permanent.
3. Keep all four template variables: `env`, `service`, `route`, `user_tier`.
   `route` maps to the APM `resource_name` tag and `user_tier` to `tier`; the
   names differ from the tag keys because a dot in a template variable name
   breaks `$var` interpolation in queries.
4. Wire a template variable into a widget only where the underlying metric
   really carries that tag. Scoping a series by a tag it does not have empties
   the widget, which looks identical to an outage.
5. Put the reasoning in each widget's `description`. JSON cannot carry comments,
   and the description is visible in the UI where it is actually useful.
6. Use only names that exist: metrics from `05-FUNCTIONALITY.md § 14`, custom
   spans from `03-EXECUTION-ORDER.md` Phase 8, entry-point spans from
   `02-TECH-STACK.md § 5.2`, services from `DD_SERVICE` in `docker-compose.yml`,
   RUM views and actions from `06-USER-FLOWS.md § 2` and `§ 7`. Introducing a
   name means adding it to the owning document in the same change.
7. Run `../scripts/verify-datadog-config.sh`, then `./apply.sh --dry-run`.

## Two things to know before you trust a number

**The checkout availability SLO depends on an unverified tag value.** It counts
`synthetics.test_runs{status:0}` as passing runs. Datadog's public documentation
does not state the tag value for a passing run, so if `0` is wrong this SLO
reads 0% rather than reading slightly wrong — which is the failure mode to
prefer, but check it against the live metric the first time data flows.

**`browser-manage-booking` ships paused.** It needs a booking that exists and
stays confirmed, which seeded data does not guarantee. Set the `MANAGE_PNR` and
`MANAGE_SURNAME` config variables to a real seeded booking, then set `status` to
`live`. Left as shipped it would be permanently red for a data reason, and a
permanently red synthetic teaches everyone to ignore synthetics.
