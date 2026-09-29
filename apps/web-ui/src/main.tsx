import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startMocks } from '@/mocks/start';
import './styles/index.css';

/**
 * `@/mocks/start` resolves to a no-op module unless `VITE_USE_MOCKS=true`, so a
 * production build never contains the fixture graph. See `vite.config.ts`.
 */
async function main() {
  await startMocks();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
