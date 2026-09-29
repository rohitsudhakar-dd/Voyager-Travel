import { FRONTEND_CHAOS_FLAGS, type ChaosCatalog } from '@voyager/shared-schemas';
import { readJson, readStored, writeJson } from '@/lib/storage';

/**
 * The four `frontend_*` flags from 05-FUNCTIONALITY.md § 11, as the browser
 * sees them.
 *
 * Reading them is the awkward part. The only documented way to read chaos
 * state is `GET /api/v1/admin/chaos`, which is gated on the `X-Voyager-Admin`
 * header, and the storefront has no business holding that secret. So there are
 * two sources, tried in order:
 *
 *   1. the admin endpoint, when this tab happens to hold the secret (i.e. the
 *      operator is on /admin);
 *   2. a same-origin mirror that the Ops console writes whenever it refreshes
 *      the catalogue, which is what makes the flags reach a storefront tab.
 *
 * Both fail open, exactly as the server-side chaos modules do: unreachable or
 * unreadable state means chaos is off. A demo must never break because the
 * flag store hiccuped.
 *
 * Phase 6 could collapse this to one source by exposing an unauthenticated
 * read-only projection of the `frontend_*` flags; see the Phase 7 report.
 */

export const MIRROR_KEY = 'voyager.frontendChaos';

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

export function stateFromCatalog(catalog: ChaosCatalog): FrontendChaosState {
  const values: Record<string, unknown> = {};
  for (const flag of catalog.flags) {
    if ((FRONTEND_CHAOS_FLAGS as readonly string[]).includes(flag.name)) {
      values[flag.name] = flag.value;
    }
  }
  return stateFromValues(values);
}

/** Written by the Ops console so storefront tabs can see the same flags. */
export function mirrorFrontendChaos(catalog: ChaosCatalog): void {
  const values: Record<string, unknown> = {};
  for (const flag of catalog.flags) {
    if ((FRONTEND_CHAOS_FLAGS as readonly string[]).includes(flag.name)) {
      values[flag.name] = flag.value;
    }
  }
  writeJson(MIRROR_KEY, values);
}

export function readMirroredChaos(): FrontendChaosState {
  return stateFromValues(readJson<Record<string, unknown>>(MIRROR_KEY, {}));
}

export function hasAdminSecret(): boolean {
  return Boolean(readStored('voyager.adminSecret', 'session'));
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
