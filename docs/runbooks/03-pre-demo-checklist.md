# Runbook — Pre-demo checklist and recovery

From `06-USER-FLOWS.md § 10` and `§ 11`. Ten minutes of checks beats a dead
demo.

---

## The checklist

```
[ ] make healthcheck          all green, zero active chaos flags
[ ] make up-full              load generator running
[ ] Load generator has been at 1x for >= 30 minutes (dashboards need shape)
[ ] make demo-mode            sampling at 100%, load at 2x
[ ] Complete one manual booking end to end; note the PNR
[ ] Confirm that booking's trace has >= 40 spans
[ ] Confirm its Session Replay exists and the card field is masked
[ ] All 6 dashboards open in tabs, no "no data" widgets
[ ] Ops console open in its own tab, Reset All Chaos visible
[ ] Signed in as power1@voyager.demo / demo1234 in a second tab, for S3
[ ] Apply and revert one scenario as a smoke test, then reset
[ ] Browser zoom at 110-125% so the room can read it
[ ] Notifications and Slack silenced
```

`make healthcheck` covers the first line and several of the others on its own.
It asserts, and exits non-zero on any of them:

- every container up and healthy, and `kafka-init` exited cleanly
- every service's `/ready` green, via the gateway's `/admin/status`
- all 38 chaos flags off, no scenario applied, and
  `idx_bookings_user_id_created_at` back in place
- seed data floors met, including the 20 power users S3 needs
- every image stamped with a commit that exists in this repository
- the edge routing `/api` to the gateway with the prefix intact
- the Agent taking traces from all three backend runtimes, with a key Datadog
  accepts

What it does **not** check, because nothing can from a terminal: that Session
Replay recorded, that the card field is masked, and that the dashboards have
shape rather than merely data. Those three are yours.

---

## Recovery, mid-demo

| Symptom | Do this |
|---|---|
| Traces look truncated | Check `DD_TRACE_PROPAGATION_STYLE` on the service where the trace *stops*, not where it starts. This is the cause the overwhelming majority of the time. |
| A service is unhealthy | `make up-one s=<service>`. About twenty seconds. Keep talking. |
| Chaos will not revert | `make chaos-reset`, then hard-reload the Ops console. If an index is still missing, `make migrate` recreates it. |
| Dashboards are empty | `make ps` — are `loadgen-api` and `loadgen-browser` running? `make up-full` starts them. |
| RUM sessions missing | Check the client token and `VITE_DD_RUM_APPLICATION_ID` are baked into the build, and that you are on HTTPS. |
| Postgres was OOM-killed | `make up-one s=postgres`; the data is in the volume. Then `make healthcheck`. |
| The memory-leak scenario wedged the box | `docker compose restart booking-service`. S7 is the one scenario that needs a restart, and it is documented as such in `01-PRD.md § 8`. |
| The edge is serving 502 on `/api` | `make logs s=api-gateway`. The edge resolves `api-gateway` per request, so a 502 is the gateway being down, not a proxy misconfiguration. |
| Everything is confusing | `make reset`. Five minutes to a clean, seeded, healthy system. Say you are resetting the environment; nobody minds. |

**The honest move:** if something breaks and you cannot fix it in thirty
seconds, say so and pivot to a dashboard or a saved trace. An operator who
debugs their own demo calmly is more convincing than one whose demo never
breaks — especially when the product you are selling is the thing that would
have told them what went wrong.

---

## Afterwards

```
make chaos-reset     # whatever you left on
make idle-mode       # sampling and replay back down; this is the cost control
```

`make idle-mode` is the difference between a demo environment and a bill.
Session Replay at 100% is the single most expensive setting in the stack
(`02-TECH-STACK.md § 8`).
