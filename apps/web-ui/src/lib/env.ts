/**
 * The only place in the app that touches `import.meta.env`.
 *
 * `VITE_*` variables are baked in at build time, not read at runtime, so
 * changing one means rebuilding the image.
 */

const raw = import.meta.env;

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
  version: raw.VITE_DD_VERSION ?? 'dev',
  commitSha: (raw.VITE_DD_GIT_COMMIT_SHA ?? '').slice(0, 7),

  isDev: raw.DEV,
};
