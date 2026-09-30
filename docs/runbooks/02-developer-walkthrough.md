# Runbook — Developer / APM walkthrough (25 minutes)

The narrative from `06-USER-FLOWS.md § 9.2`. The audience is people who will
have to instrument their own code, so the point of every act is *how little
there is of it*.

**Before you start:** `make healthcheck` green, `make demo-mode` run, load
generator at `1x`. An editor open on the repository, and Datadog beside it.

---

## Act 1 — "Instrumentation is four files" (6 min)

Open these four, in this order. Nothing else.

1. `services/booking-service/app/tracing.py` — the Python tracer. Then the
   Dockerfile `CMD`, and the `ddtrace-run` in front of `uvicorn`.
2. `services/api-gateway/src/tracer.ts` and the `--require` flag in its
   Dockerfile.

   *Load order is the whole story here. An `import` at the top of the
   entrypoint is still hoisted below Fastify's, and the only symptom is a
   service that reports no HTTP spans. Not an error. No spans.*

3. `services/search-service/internal/trace/trace.go` — six lines, plus the
   contrib wiring where each client is built.
4. `apps/web-ui/src/datadog/rum.ts`, and specifically `allowedTracingUrls`.

   *That one option is what connects the browser to the backend trace. Without
   it you have two disconnected products.*

Land it: four languages, four small files, one trace.

---

## Act 2 — "Custom spans that mean something" (6 min)

1. Open `services/booking-service/app/domain/booking.py`. Show
   `booking.acquire_hold_lock`, `booking.hold_inventory`,
   `booking.state_transition`.
2. Show the tags that go with them: `booking.id`, `booking.state`, `usr.tier`.
3. Find that exact trace in Datadog and point at the spans you just read in the
   editor.
4. Search traces for `@booking.state:CONFIRMED @usr.tier:platinum`.

   *That is a business question, answered from trace tags, with no new
   instrumentation and no query language anyone had to learn.*

Worth saying out loud: the tags are set on each service's **local root span**,
not on a child. A tag on a child span can only be found by someone who already
knows which span to open.

---

## Act 3 — "Errors that group correctly" (5 min)

1. Open the typed error hierarchy (`05-FUNCTIONALITY.md § 13.1` and the
   `errors` module in any service). Explain why `error.type` is a class name
   and the message is a constant.
2. Ops console → **S2: Payment provider brownout**.
3. Error Tracking: a handful of clean issue groups.

   *Interpolate a booking ID into that message and this screen has one issue
   per request on it. Which is the same as having no screen.*

4. Show that declines are a **tagged outcome** —
   `payment.decline_code:insufficient_funds` — and not a span error, and why
   that keeps the error rate and the SLO honest: a declined card is the payment
   system working.
5. **Revert S2.**

---

## Act 4 — "Logs and traces are the same thing" (4 min)

1. Open `05-FUNCTIONALITY.md § 12` — one schema, four languages.
2. Take a trace ID from any span. Search logs for it. Every line from every
   service, in order, across all four runtimes.
3. Click a log line back to the trace. Click the span through to the code on
   the default branch.

---

## Act 5 — "It's all in CI" (4 min)

1. Open the GitHub Actions run for the latest commit on `main`. Four suites:
   `web`, `node`, `python`, `go` — all reporting to Test Optimization.
2. Open `services/loyalty-service/tests/flaky.test.ts` in the editor. It is a
   wall-clock assertion with two milliseconds of headroom, and the comment at
   the top says so.

   *Every codebase has three of these. The difference is whether you know
   which three.*

   Then show it in Datadog with its pass/fail history.
3. Pipeline Visibility: build durations per job, and which job is the long pole.
4. Close on `make deploy`. It resolves `DD_VERSION` and `DD_GIT_COMMIT_SHA`
   from the git SHA, bakes them into the images, reads them back out to check
   they took, uploads the sourcemaps, and then refuses to call the deploy done
   until `make healthcheck` passes. A deployment marker appears in APM as a
   result.

---

## If you have five more minutes

`make idle-mode` and `make demo-mode`, and the reason they exist: sampling
rates are read once, at tracer start, so this is a mode you set before a demo
rather than a dial you turn during one. `02-TECH-STACK.md § 8` has the numbers
and what each one costs.
