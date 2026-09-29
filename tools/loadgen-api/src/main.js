/**
 * Voyager API load generator.
 *
 * Six weighted journeys against the public API, shaped by a 24-hour diurnal
 * curve and steerable at runtime from `POST /api/v1/admin/loadgen`. It exists
 * so that every dashboard, monitor baseline and SLO in Phase 12 has a week of
 * plausible history behind it without anyone clicking anything.
 *
 * The one structural decision worth knowing before reading further: k6 fixes
 * arrival rates when a test starts and never revises them, so intensity is
 * not applied to the executors. Every scenario is configured at its 5x peak
 * and each iteration asks admission control whether to proceed. See
 * settings.js for why that keeps the documented mix exact at every intensity.
 */

import { sleep } from 'k6';

import {
  DIURNAL_FLOOR,
  DIURNAL_TROUGH_HOUR_UTC,
  MAX_INTENSITY,
  WEIGHTS,
  diurnalFactor,
  timeUnitSeconds,
  vuBudget,
} from './mix.js';
import { apiSettings } from './settings.js';
import { depth, trim } from './pool.js';
import { publish } from './stats.js';

export {
  browse,
  cancel,
  checkout,
  deepBrowse,
  manage,
  support,
} from './journeys.js';

const BASE_VUS = Number(__ENV.LOADGEN_API_VUS || 15);
const UNIT_SECONDS = timeUnitSeconds(BASE_VUS);

/**
 * Long enough that the generator never ends on its own. Compose restarts the
 * container if it ever does, but a test that quietly finished after a day
 * would leave the dashboards flat and nobody would notice until a demo.
 */
const RUN_FOR = '720h';

const CONTROL_INTERVAL_SECONDS = 5;
const LOG_EVERY_TICKS = 12;
const TRIM_EVERY_TICKS = 12;

/** The k6 function each journey runs under; the keys are the documented mix. */
const ENTRY_POINTS = {
  browse: 'browse',
  deep_browse: 'deepBrowse',
  checkout: 'checkout',
  manage: 'manage',
  cancel: 'cancel',
  support: 'support',
};

function trafficScenario(journey) {
  return Object.assign(
    {
      executor: 'constant-arrival-rate',
      exec: ENTRY_POINTS[journey],
      // `rate` is the weight verbatim. Six scenarios sharing one time unit
      // therefore start journeys in exactly 52:20:17:5:3:3; see mix.js.
      rate: WEIGHTS[journey],
      timeUnit: `${UNIT_SECONDS}s`,
      duration: RUN_FOR,
      // Longer than the slowest journey, so an operator turning the
      // generator off does not sever a checkout between authorisation and
      // confirmation and leave a booking stranded in PENDING_PAYMENT.
      gracefulStop: '90s',
      tags: { journey },
    },
    vuBudget(journey, UNIT_SECONDS),
  );
}

export const options = {
  scenarios: Object.keys(WEIGHTS).reduce(
    (scenarios, journey) => {
      scenarios[journey] = trafficScenario(journey);
      return scenarios;
    },
    {
      // Sends no traffic and carries no weight. It publishes what the
      // generator currently believes so the admin console and
      // scripts/verify-loadgen.sh can see it without parsing k6's stdout,
      // which a 30-day run never prints.
      control: {
        executor: 'constant-vus',
        exec: 'control',
        vus: 1,
        duration: RUN_FOR,
        gracefulStop: '5s',
      },
    },
  ),
};

let tick = 0;

export async function control() {
  const { enabled, intensity } = await apiSettings();
  const diurnal = diurnalFactor(new Date());
  const pool = await depth();

  await publish({
    api_enabled: enabled ? 1 : 0,
    api_intensity: intensity,
    api_diurnal: diurnal.toFixed(4),
    api_pool_depth: pool,
    api_updated_at: Date.now(),
    api_mix: JSON.stringify(WEIGHTS),
    api_time_unit_seconds: UNIT_SECONDS,
    api_base_vus: BASE_VUS,
    api_max_intensity: MAX_INTENSITY,
    api_diurnal_floor: DIURNAL_FLOOR,
    api_diurnal_trough_hour_utc: DIURNAL_TROUGH_HOUR_UTC,
  });

  if (tick % TRIM_EVERY_TICKS === 0) await trim();
  if (tick % LOG_EVERY_TICKS === 0) {
    console.log(
      `loadgen-api enabled=${enabled} intensity=${intensity}x diurnal=${diurnal.toFixed(2)} ` +
        `admitted=${((intensity * diurnal) / MAX_INTENSITY).toFixed(2)} pool=${pool}`,
    );
  }
  tick += 1;

  sleep(CONTROL_INTERVAL_SECONDS);
}
