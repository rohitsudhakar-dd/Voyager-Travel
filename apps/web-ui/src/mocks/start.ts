import { seedBookings } from './fixtures/state';

/**
 * The fixture layer. Reached only when `VITE_USE_MOCKS=true`; otherwise
 * `vite.config.ts` resolves this module to `start.noop.ts`, so none of the
 * fixture graph is in the bundle at all.
 */
export async function startMocks(): Promise<void> {
  const { worker } = await import('./browser');
  seedBookings();

  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
  });

  // eslint-disable-next-line no-console -- the one place a console line earns its keep.
  console.info(
    'Voyager is running against local fixtures. Set VITE_USE_MOCKS=false for a live gateway.',
  );
}
