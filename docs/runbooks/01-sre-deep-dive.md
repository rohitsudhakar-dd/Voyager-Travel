# Runbook — SRE / Platform deep dive (45 minutes)

The narrative from `06-USER-FLOWS.md § 9.1`, as something to hold while you
talk. Every step is an action; the italics are what to say while it lands.

**Before you start:** `make healthcheck` green, `make demo-mode` run, load
generator at `1x` for at least thirty minutes. Full list in
[`03-pre-demo-checklist.md`](03-pre-demo-checklist.md).

**Window layout**

| Window | Contents |
|---|---|
| Left | Voyager storefront, signed out, on `/home` |
| Right | Datadog, Service Map open |
| Third tab | Ops console at `/admin`, **Reset all chaos** visible |
| Fourth tab | Signed in as `power1@voyager.demo` / `demo1234`, on `/account` — for Act 3 |

Every act ends by reverting. If you skip a revert the next act's story is two
stories, and the audience will believe the wrong one.

---

## Act 1 — "Here is the system" (7 min)

1. Open the **Service Map**. Thirteen services, four runtimes, plus Postgres,
   Redis and Kafka. Say nothing for a few seconds and let them read it.
2. In the left window, complete one flight booking by hand. `LHR → JFK`, about
   three weeks out, one adult. Use the card `4242 4242 4242 4242`.
3. Copy the PNR from the confirmation page.
4. In Datadog, search traces for that PNR: `@booking.pnr:<PNR>`. Open the
   trace.
5. Walk the waterfall in this order, because it is the order the time was
   spent: the parallel GDS fan-out, the pricing call, `booking.acquire_hold_lock`,
   the payment, then the Kafka handoff to two independent consumers.

   *One trace. Four languages. No correlation IDs written by hand anywhere in
   this application.*

6. Point at the two Kafka consumers hanging off the end. *Those are separate
   services, on separate consumer groups. Nothing in the checkout waits for
   them, and the trace still knows they happened.*

---

## Act 2 — "Something is slow and it isn't us" (8 min) — S1

1. Ops console → **S1: Third-party degradation**.
2. Run three or four flight searches in the left window. *Notice it is slow,
   but not every time.*
3. Datadog → APM → `voyager-search`. Search p95 climbs; p50 barely moves.

   *That shape is the whole diagnosis. If we were slow, p50 would move.*

4. Open a slow trace. The time is in `mock-gds`, not in Voyager's own spans.
5. Metrics explorer: `voyager.search.provider_latency` broken down by
   `provider`. One provider is the entire tail.
6. Check **Watchdog** for an automatically surfaced anomaly on the service.
7. **Revert S1.**

---

## Act 3 — "The missing index" (10 min) — S3

This is the act the room remembers. Do not rush it.

1. Switch to the fourth tab, signed in as `power1@voyager.demo`. Reload
   `/account`. It is fast. Note roughly how fast out loud.
2. Ops console → **S3: The missing index**.
3. Reload `/account`. It crawls.
4. APM → `voyager-booking` → the `/bookings/mine` endpoint. p95 has jumped by
   more than 10×. Open a trace: nearly all of it is one Postgres span.
5. Click through into **Database Monitoring**. Same query, same normalised
   text, and the execution plan has flipped from Index Scan to Seq Scan, with
   rows scanned in the hundreds of thousands.
6. Put the two plans side by side. The saved "before" plan is committed at
   [`docs/explain-plans/bookings-mine-with-index.txt`](../explain-plans/bookings-mine-with-index.txt)
   if you want it on screen without waiting for DBM to sample.
7. **Revert S3** and watch it recover live.

   *The fix was one toggle. Finding it was the hard part, and that is the part
   you just watched take ninety seconds.*

If the index does not come back, `make migrate` recreates it.

---

## Act 4 — "The cascade" (12 min) — S4

1. Ops console → **S4: Cache stampede**, then raise load to `2x` on the Load
   tab.
2. Narrate the cascade from the dashboards as it unfolds, in this order — it is
   the order it actually happens:
   cache hit ratio → 0; GDS call volume up roughly 20×; rate-limit 429s appear;
   search errors climb; holds start expiring; booking success rate falls;
   the revenue widget dives.
3. Monitors fire. The composite **Checkout degraded** monitor triggers.
4. Declare an incident from the monitor. Add the dashboard and one trace as
   evidence.
5. Show the booking SLO's error budget burning down in real time.
6. **Revert S4**, drop load back to `1x`, and watch recovery. Close the
   incident and show the postmortem notebook template.

---

## Act 5 — "Where is the CPU going?" (8 min) — S6

1. Ops console → **S6: The hot deploy**. This sets `version_override=v2-bad`
   and turns on `pricing_hot_path`.
2. APM → `voyager-pricing`. p95 regresses right at the deployment marker.
   Compare `v2-bad` against the previous version side by side.
3. **Continuous Profiler** → the flame graph is dominated by
   `evaluateFareRules` and `regexp.MustCompile`.
4. **Code Hotspots** links the span straight to the line. Source Code
   Integration opens it on the default branch.
5. **Revert S6.**

---

## Closing (optional)

If they are still leaning forward, either:

- **S5: Slow consumer** → Data Streams Monitoring, showing which hop is behind
  and the DLQ filling, or
- **S10: Lock contention** → the wait profile and DBM's blocking sessions
  converging on the same advisory lock.

Then **Reset all chaos** and `make healthcheck` before you close the laptop, so
the next person to open it finds a healthy system.
