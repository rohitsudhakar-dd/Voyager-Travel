import { useQuery } from '@tanstack/react-query';
import type { ChaosCatalog } from '@voyager/shared-schemas';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { request } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { queryKeys } from '@/api/queryClient';
import {
  CHAOS_OFF,
  type FrontendChaosState,
  InjectedChaosError,
  MIRROR_KEY,
  hasAdminSecret,
  readMirroredChaos,
  runBlockingTask,
  stateFromCatalog,
} from './frontendChaos';

const ChaosContext = createContext<FrontendChaosState>(CHAOS_OFF);

const POLL_MS = 5_000;

export function ChaosProvider({ children }: { children: React.ReactNode }) {
  const canReadDirectly = hasAdminSecret();

  const { data } = useQuery({
    queryKey: queryKeys.frontendChaos,
    queryFn: ({ signal }) => request<ChaosCatalog>(endpoints.admin.chaos, { admin: true, signal }),
    enabled: canReadDirectly,
    refetchInterval: POLL_MS,
    // Fail open. A 401 or an unreachable gateway means chaos is off, and must
    // not retry-storm the admin endpoint from every storefront tab.
    retry: false,
  });

  const [mirrored, setMirrored] = useState<FrontendChaosState>(() => readMirroredChaos());

  useEffect(() => {
    if (canReadDirectly) return;
    const reread = () => setMirrored(readMirroredChaos());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === MIRROR_KEY) reread();
    };
    window.addEventListener('storage', onStorage);
    const timer = window.setInterval(reread, POLL_MS);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.clearInterval(timer);
    };
  }, [canReadDirectly]);

  const state = useMemo(() => (data ? stateFromCatalog(data) : mirrored), [data, mirrored]);

  return <ChaosContext.Provider value={state}>{children}</ChaosContext.Provider>;
}

export function useFrontendChaos(): FrontendChaosState {
  return useContext(ChaosContext);
}

/**
 * `frontend_heavy_assets` serves the 960x720 variant everywhere and stops
 * lazy-loading, which reliably wrecks LCP on the image-forward hotel results.
 */
export function useImagePolicy(intrinsic: 'sm' | 'md') {
  const { heavyAssets } = useFrontendChaos();
  return {
    size: heavyAssets ? ('lg' as const) : intrinsic,
    // Lowercase `fetchpriority`: react-dom 18 does not know the camelCase
    // spelling its own types accept, and warns instead of rendering it.
    attrs: {
      loading: heavyAssets ? 'eager' : 'lazy',
      fetchpriority: heavyAssets ? 'high' : 'auto',
      decoding: 'async',
    } as React.ImgHTMLAttributes<HTMLImageElement>,
  };
}

/** `frontend_blocking_js` -- one long task per results render. */
export function useBlockingJs(dependency: unknown): void {
  const { blockingJs } = useFrontendChaos();
  useEffect(() => {
    if (!blockingJs) return;
    runBlockingTask(400);
  }, [blockingJs, dependency]);
}

/**
 * `frontend_js_error_rate` -- probabilistic client-side exceptions. Thrown from
 * an effect so the route error boundary catches it and the friendly fallback
 * from 04-STYLING.md § 4.10 is what the audience sees.
 */
export function useInjectedJsError(dependency: unknown): void {
  const { jsErrorRate } = useFrontendChaos();
  const [thrown, setThrown] = useState<Error | null>(null);

  useEffect(() => {
    if (jsErrorRate <= 0) return;
    if (Math.random() < jsErrorRate) setThrown(new InjectedChaosError());
  }, [jsErrorRate, dependency]);

  if (thrown) throw thrown;
}

/**
 * `frontend_layout_shift` -- a banner inserted after first paint with no space
 * reserved for it, which is the textbook CLS regression.
 */
export function useDelayedBanner(delayMs = 1_200): boolean {
  const { layoutShift } = useFrontendChaos();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!layoutShift) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [layoutShift, delayMs]);

  return visible;
}
