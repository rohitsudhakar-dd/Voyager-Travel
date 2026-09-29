/**
 * The runtime control channel, read the way every service reads the chaos
 * hash (services/api-gateway/src/chaos.ts): a short local cache, no restart,
 * and it fails open.
 *
 * `POST /api/v1/admin/loadgen` writes `{api:{...}, browser:{enabled,
 * concurrency}}` to `voyager:loadgen`. Intensity for this generator is
 * expressed as a session count rather than a multiplier, because that is the
 * field the admin contract defines: 1x is the two sessions of
 * `LOADGEN_BROWSER_CONCURRENCY`, so 2x is four and 5x is ten.
 *
 * Failing open here means carrying on. A browser generator that stopped
 * because Redis blinked would take every RUM session with it, and a RUM
 * dashboard that has gone quiet looks exactly like the front end being down.
 */

import { log } from './logger';
import { redis } from './redis';

export const SETTINGS_KEY = 'voyager:loadgen';

/** Five seconds, against a 30-second exit criterion for intensity changes. */
const CACHE_TTL_MS = 5000;

/**
 * Each Chromium context costs roughly 250 MB once a page has loaded, and
 * 02-TECH-STACK.md § 9.1 budgets this container 1.5 GB. Six is the most that
 * fits, so a larger request is clamped and said out loud: a generator
 * OOM-killed mid-demo is worse than one running under the asked-for
 * intensity, and 5x browser load is a cost decision rather than a fidelity
 * one anyway.
 */
export const MAX_CONCURRENCY = 6;

export type BrowserSettings = {
  enabled: boolean;
  concurrency: number;
};

function clamp(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

const defaults: BrowserSettings = {
  enabled: (process.env.LOADGEN_BROWSER_ENABLED ?? 'true') !== 'false',
  concurrency: clamp(Number(process.env.LOADGEN_BROWSER_CONCURRENCY ?? 2), 2),
};

let snapshot: BrowserSettings = defaults;
let loadedAt = 0;
let clampWarned = false;

export async function browserSettings(): Promise<BrowserSettings> {
  if (Date.now() - loadedAt < CACHE_TTL_MS) return snapshot;
  loadedAt = Date.now();

  try {
    const blob = await redis.get(SETTINGS_KEY);
    if (blob) {
      const parsed = JSON.parse(blob) as { browser?: { enabled?: boolean; concurrency?: number } };
      const requested = Number(parsed.browser?.concurrency ?? defaults.concurrency);
      if (requested > MAX_CONCURRENCY && !clampWarned) {
        log.warn(
          { requested, cap: MAX_CONCURRENCY },
          'Requested browser concurrency exceeds the memory budget; clamping',
        );
        clampWarned = true;
      }
      snapshot = {
        enabled: parsed.browser?.enabled !== false,
        concurrency: clamp(requested, defaults.concurrency),
      };
    }
  } catch (error) {
    /* Keep the previous snapshot; see the note on failing open above. */
  }
  return snapshot;
}
