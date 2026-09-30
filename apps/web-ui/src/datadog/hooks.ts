/**
 * The React-side glue for the RUM timings and view attributes. Configuration
 * stays in `rum.ts`; this file only decides *when* to call it.
 */

import { useEffect } from 'react';
import { setViewAttribute, startTiming, stopTiming } from './rum';

/**
 * `time_to_first_result` and `time_to_interactive_results`, plus the results
 * view attributes from 06-USER-FLOWS.md § 3 Step 2.
 *
 * Both clocks start in the search panel, which is on the previous view, and
 * stop here. They are separate because a results page that has painted its
 * first row is not yet usable: the filter panel needs the airline reference
 * list and the price bounds of the whole page, and the gap between the two is
 * exactly what scenario S8 widens.
 */
export function useResultsTelemetry(input: {
  route: string;
  cabin: string;
  resultCount: number;
  cacheHit: boolean | undefined;
  firstResultPainted: boolean;
  filtersUsable: boolean;
}): void {
  const { route, cabin, resultCount, cacheHit, firstResultPainted, filtersUsable } = input;

  useEffect(() => {
    if (!firstResultPainted) return;
    stopTiming('time_to_first_result');
  }, [firstResultPainted]);

  useEffect(() => {
    if (!filtersUsable) return;
    stopTiming('time_to_interactive_results');
  }, [filtersUsable]);

  useEffect(() => {
    setViewAttribute('route', route);
    setViewAttribute('cabin', cabin);
  }, [route, cabin]);

  useEffect(() => {
    if (cacheHit === undefined) return;
    setViewAttribute('result_count', resultCount);
    setViewAttribute('cache_hit', cacheHit);
  }, [resultCount, cacheHit]);
}

/**
 * `checkout_step_duration`. Restarted on every step so the three steps are
 * measured separately rather than as one total; the value is reported by the
 * step's own submit handler, so an abandoned step contributes nothing, which
 * is what makes the number comparable across sessions.
 */
export function useCheckoutStepTiming(step: number): void {
  useEffect(() => {
    startTiming('checkout_step_duration');
  }, [step]);
}
