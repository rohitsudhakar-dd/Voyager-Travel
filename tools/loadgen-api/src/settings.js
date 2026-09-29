/**
 * The runtime control channel.
 *
 * `POST /api/v1/admin/loadgen` writes a settings blob to the Redis key
 * `voyager:loadgen` (services/api-gateway/src/routes/admin.ts). This module
 * reads it the way every service reads the chaos hash: a short local cache,
 * no restart, and it fails open.
 *
 * "Fails open" means the opposite of what it means for chaos. Chaos fails
 * open by turning itself off; a load generator that turned itself off because
 * Redis blinked would empty every dashboard, and an empty dashboard mid-demo
 * is indistinguishable from a production outage. So a failed read keeps the
 * last known settings, and a generator that has never managed a read runs at
 * 1x rather than not at all.
 */

import { client } from './redis.js';
import { MAX_INTENSITY, diurnalFactor } from './mix.js';

export const SETTINGS_KEY = 'voyager:loadgen';

/**
 * Five seconds, against a 30-second exit criterion. The gap absorbs the worst
 * case, which is an iteration that read the cache immediately before the
 * operator changed it.
 */
const CACHE_TTL_MS = 5000;

const DEFAULTS = Object.freeze({
  enabled: (__ENV.LOADGEN_API_ENABLED || 'true') !== 'false',
  intensity: 1,
});

let cached = DEFAULTS;
let loadedAt = 0;

export async function apiSettings() {
  if (Date.now() - loadedAt < CACHE_TTL_MS) return cached;
  loadedAt = Date.now();

  try {
    const blob = JSON.parse(await client.get(SETTINGS_KEY));
    const api = blob.api || {};
    cached = {
      enabled: api.enabled !== false,
      intensity: clamp(Number(api.intensity), 0, MAX_INTENSITY, DEFAULTS.intensity),
    };
  } catch (error) {
    /* Keep the previous snapshot; see the note on failing open above. */
  }
  return cached;
}

/**
 * Admission control: the one knob that turns intensity and the time of day
 * into load, applied identically to all six scenarios.
 *
 * Every executor is configured at the 5x peak rate and each iteration throws
 * this dice before doing any work. Scaling the dice rather than the executors
 * is what makes intensity changes land without a restart -- k6 fixes arrival
 * rates when the test starts and will not revise them -- and because the same
 * probability applies to every scenario, the 52:20:17:5:3:3 mix survives
 * untouched at every intensity and every hour of the day.
 */
export async function admit() {
  const { enabled, intensity } = await apiSettings();
  if (!enabled || intensity <= 0) return null;

  const diurnal = diurnalFactor(new Date());
  if (Math.random() >= (intensity * diurnal) / MAX_INTENSITY) return null;
  return { intensity, diurnal };
}

function clamp(value, low, high, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, value));
}
