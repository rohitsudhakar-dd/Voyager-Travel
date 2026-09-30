/**
 * A deliberately flaky test (03-EXECUTION-ORDER.md Phase 13).
 *
 * It exists so Datadog's flaky-test detection has something to find, and so
 * the CI act of the developer demo (06-USER-FLOWS.md § 9.2) can open a real
 * flake with real history rather than a screenshot of one. It asserts nothing
 * about Voyager; deleting it would cost the suite no coverage at all.
 *
 * The flake is the commonest kind there is: a wall-clock assertion with a
 * budget barely above the thing it measures. A coin flip would have been
 * easier to tune, but it would also be a fake flake -- it fails at the same
 * rate on an idle runner as on a loaded one, whereas this fails more often
 * exactly when CI is busy, which is what makes the real ones so hard to
 * reproduce and so tempting to re-run and ignore.
 *
 * `retry` is what keeps the pipeline green. It also means the pass Datadog
 * records has retried attempts behind it, which is the signal flaky detection
 * reads -- a test that simply passed on the first try is not flaky, however
 * unstable it is.
 */
import { describe, expect, it } from 'vitest';

const DELAY_MS = 8;

// setTimeout promises "at least" DELAY_MS and nothing about the ceiling. Two
// milliseconds of headroom is enough on an idle machine and not enough on a
// runner with three other jobs on it.
const BUDGET_MS = DELAY_MS + 2;

describe('flaky by design (a CI fixture, not a Voyager assertion)', () => {
  it('settles a short timer inside a budget it only just fits', { retry: 3 }, async () => {
    const startedAt = performance.now();
    await new Promise((resolve) => {
      setTimeout(resolve, DELAY_MS);
    });

    expect(performance.now() - startedAt).toBeLessThan(BUDGET_MS);
  });
});
