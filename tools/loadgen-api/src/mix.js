/**
 * The traffic mix, and the shape of a day.
 *
 * The six weights are the session proportions in 03-EXECUTION-ORDER.md
 * Phase 11. The 17 against `checkout` is the bottom-of-funnel conversion in
 * 06-USER-FLOWS.md § 8, and the two have to stay equal: if API traffic
 * converts at one rate and the RUM funnel at another, every dashboard that
 * mixes the two is quietly lying.
 *
 * The weights double as k6 arrival rates. A `constant-arrival-rate` executor
 * starts `rate` iterations per `timeUnit`, so six scenarios sharing one time
 * unit begin journeys in exactly the ratio of their rates -- 52:20:17:5:3:3,
 * with no rounding anywhere. Deriving per-second rates from a total instead
 * would quantise to whole iterations and leave the mix a fraction off the
 * documented one, which is the single thing this deliverable is asked to get
 * exactly right.
 */

export const WEIGHTS = Object.freeze({
  browse: 52,
  deep_browse: 20,
  checkout: 17,
  manage: 5,
  cancel: 3,
  support: 3,
});

/**
 * Roughly how long a journey occupies a virtual user, think time included.
 * These only size the VU pools. Too low and k6 runs out of virtual users and
 * starts dropping iterations, which silently distorts the mix; too high and
 * idle VU allocations push the container past its 256 MB limit.
 */
const MEAN_SECONDS = Object.freeze({
  browse: 20,
  deep_browse: 35,
  checkout: 70,
  manage: 16,
  cancel: 26,
  support: 26,
});

/** The top of the documented 1x / 2x / 5x range. */
export const MAX_INTENSITY = 5;

export const DIURNAL_FLOOR = 0.25;
export const DIURNAL_TROUGH_HOUR_UTC = 4;

/**
 * A sine over the 24-hour clock, running from DIURNAL_FLOOR at 04:00 UTC up
 * to 1.0 at 16:00 and back. Dashboards asked to show a week of history need a
 * shape: against a flat line, anomaly detection, forecasting and the "is this
 * normal for a Tuesday?" question have nothing to say. The trough is
 * deliberately not zero, because a dead overnight window reads as an outage
 * rather than a quiet night.
 */
export function diurnalFactor(now) {
  const hourOfDay = now.getUTCHours() + now.getUTCMinutes() / 60;
  const phase = ((hourOfDay - DIURNAL_TROUGH_HOUR_UTC) / 24) * 2 * Math.PI;
  return DIURNAL_FLOOR + (1 - DIURNAL_FLOOR) * ((1 - Math.cos(phase)) / 2);
}

/**
 * How long the 100 weighted iterations should be spread over, given the VU
 * budget the operator asked for. Solving concurrency = rate x duration for
 * the time unit is what ties `LOADGEN_API_VUS` to real load: at 5x intensity
 * and the top of the diurnal curve, the generator uses about that many VUs.
 */
export function timeUnitSeconds(baseVus) {
  const weightedMean =
    Object.keys(WEIGHTS).reduce((total, name) => total + WEIGHTS[name] * MEAN_SECONDS[name], 0) / 100;
  return Math.max(1, Math.round((100 * weightedMean) / (baseVus * MAX_INTENSITY)));
}

/**
 * Journey duration is a distribution, not the single number above, so the
 * pools carry 40% headroom over the arithmetic. Pre-allocation covers 1x,
 * which is where the generator spends nearly all of its life; the rest is
 * allocated on demand when an operator turns the dial up for a demo.
 */
export function vuBudget(journey, unitSeconds) {
  const peak = (WEIGHTS[journey] / unitSeconds) * MEAN_SECONDS[journey] * 1.4;
  return {
    preAllocatedVUs: Math.max(2, Math.ceil(peak / MAX_INTENSITY)),
    maxVUs: Math.max(4, Math.ceil(peak)),
  };
}
