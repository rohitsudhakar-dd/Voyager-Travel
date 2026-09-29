import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const useMocks = env.VITE_USE_MOCKS === 'true';

  return {
    plugins: [react()],

    resolve: {
      alias: [
        {
          find: '@voyager/shared-schemas',
          replacement: here('../../packages/shared-schemas/src/index.ts'),
        },
        // The mock layer is swapped for a no-op at resolve time rather than
        // branched at runtime, so no fixture or MSW code can reach a
        // production bundle even by accident. Ordered before the '@' prefix
        // alias, which would otherwise match first.
        ...(useMocks
          ? []
          : [{ find: /^@\/mocks\/start$/, replacement: here('./src/mocks/start.noop.ts') }]),

        { find: '@', replacement: here('./src') },
      ],
    },

    server: {
      port: 5173,
      host: true,
      // packages/shared-schemas lives outside the Vite root.
      fs: { allow: [here('.'), here('../../packages')] },
      // There is no host Node toolchain, so `npm run dev` runs in a container
      // over a bind mount, where inotify never fires and HMR silently dies.
      watch: existsSync('/.dockerenv') ? { usePolling: true, interval: 300 } : undefined,
    },

    build: {
      // Uploaded to Datadog at deploy time and not served publicly (Phase 9).
      sourcemap: true,
      target: 'es2022',
      rollupOptions: {
        output: {
          // Recharts is only reachable from the Ops console; keeping it out of
          // the shared vendor chunk protects the storefront's JS budget
          // (04-STYLING.md § 11). clsx and tailwind-merge are pinned to the
          // framework chunk for the same reason: left unassigned, Rollup folds
          // them into the recharts chunk and the entry then has to preload it.
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom', 'clsx', 'tailwind-merge'],
            query: ['@tanstack/react-query'],
            charts: ['recharts'],
          },
        },
      },
    },

    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
