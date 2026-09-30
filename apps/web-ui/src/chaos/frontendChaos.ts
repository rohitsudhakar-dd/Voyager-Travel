/**
 * The four `frontend_*` flags from 05-FUNCTIONALITY.md § 11, as the browser
 * sees them.
 *
 * They come from `GET /api/v1/chaos/frontend` (§ 2.9), which is unauthenticated
 * precisely so that a storefront tab can read them without holding
 * ADMIN_SECRET. Until that endpoint existed the storefront read a localStorage
 * mirror written by the Ops console, which meant the four flags only worked in a
 * tab an operator had already visited /admin in -- so `loadgen-browser` never
 * triggered them and scenario S8 had nothing to act on.
 *
 * Reading fails open, exactly as the server-side chaos modules do: an
 * unreachable gateway means chaos is off. A demo must never break because the
 * flag store hiccuped.
 */

export interface FrontendChaosState {
  heavyAssets: boolean;
  blockingJs: boolean;
  jsErrorRate: number;
  layoutShift: boolean;
}

export const CHAOS_OFF: FrontendChaosState = {
  heavyAssets: false,
  blockingJs: false,
  jsErrorRate: 0,
  layoutShift: false,
};

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function asRate(value: unknown): number {
  const rate = Number(value);
  return Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0;
}

export function stateFromValues(values: Record<string, unknown>): FrontendChaosState {
  return {
    heavyAssets: asBoolean(values.frontend_heavy_assets),
    blockingJs: asBoolean(values.frontend_blocking_js),
    jsErrorRate: asRate(values.frontend_js_error_rate),
    layoutShift: asBoolean(values.frontend_layout_shift),
  };
}

/**
 * A genuinely expensive synchronous task, not a busy-wait: repeated regex
 * compilation and string normalisation of the kind a naive client-side sort
 * would do. It blocks the main thread for real, which is what collapses INP.
 */
export function runBlockingTask(targetMs = 400): number {
  const started = performance.now();
  const words = Array.from({ length: 256 }, (_, i) => `fare-rule-${i}-${(i * 7919) % 9973}`);
  let sink = 0;

  while (performance.now() - started < targetMs) {
    for (let i = 0; i < words.length; i += 1) {
      // A fresh RegExp every iteration defeats the engine's compile cache.
      const pattern = new RegExp(`(${words[i]})|(^[a-z]+-[0-9]+-[0-9]+$)`, 'i');
      for (let j = 0; j < words.length; j += 1) {
        if (pattern.test(words[j])) sink += words[j].length;
      }
    }
  }

  // Returned so the value cannot be optimised away, and so callers can assert
  // the task actually ran in a test.
  return sink;
}

export const INJECTED_ERROR_MESSAGE = 'Injected frontend chaos exception';

/** Constant message, so Error Tracking sees one issue rather than thousands. */
export class InjectedChaosError extends Error {
  constructor() {
    super(INJECTED_ERROR_MESSAGE);
    this.name = 'InjectedChaosError';
  }
}
