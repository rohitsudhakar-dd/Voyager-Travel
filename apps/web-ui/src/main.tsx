import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initDatadog } from '@/datadog/rum';
import { startMocks } from '@/mocks/start';
import './styles/index.css';

/**
 * `@/mocks/start` resolves to a no-op module unless `VITE_USE_MOCKS=true`, so a
 * production build never contains the fixture graph. See `vite.config.ts`.
 */
async function main() {
  // Before the fixture worker and before React, so the SDK sees the document's
  // own load timing and instruments fetch before anything has used it. Started
  // after this point, RUM reports no initial page load at all.
  initDatadog();

  await startMocks();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
