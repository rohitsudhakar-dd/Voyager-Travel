/**
 * The only place in the app that touches `import.meta.env`.
 *
 * `VITE_*` variables are baked in at build time, not read at runtime, so
 * changing one means rebuilding the image.
 */

const raw = import.meta.env;

/** Percentages, clamped: RUM silently ignores a rate outside 0-100. */
function percent(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : fallback;
}

export const env = {
  /** Public origin of api-gateway, including its `/api` prefix. */
  apiBaseUrl: (raw.VITE_API_BASE_URL ?? '/api').replace(/\/$/, ''),

  /**
   * The single switch between the fixture layer and a real gateway. When
   * false, vite.config.ts resolves `@/mocks/start` to a no-op, so no fixture
   * code exists in the bundle at all.
   */
  useMocks: raw.VITE_USE_MOCKS === 'true',

  ddEnv: raw.VITE_DD_ENV ?? 'local',
  version: raw.VITE_DD_VERSION || 'dev',
  commitSha: (raw.VITE_DD_GIT_COMMIT_SHA ?? '').slice(0, 7),

  /**
   * RUM. Both credentials are publishable -- the client token is designed to
   * ship in a bundle -- but an absent pair is a valid configuration, and
   * `src/datadog/rum.ts` declines to initialise rather than throwing.
   */
  ddSite: raw.VITE_DD_SITE ?? 'datadoghq.com',
  rumApplicationId: raw.VITE_DD_RUM_APPLICATION_ID ?? '',
  rumClientToken: raw.VITE_DD_RUM_CLIENT_TOKEN ?? '',
  rumSessionSampleRate: percent(raw.VITE_RUM_SESSION_SAMPLE_RATE, 100),
  rumSessionReplaySampleRate: percent(raw.VITE_RUM_SESSION_REPLAY_SAMPLE_RATE, 100),

  isDev: raw.DEV,
};
