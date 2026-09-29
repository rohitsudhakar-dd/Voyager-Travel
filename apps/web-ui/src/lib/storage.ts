/**
 * Browser storage behind a narrow, failure-tolerant surface. Private-mode
 * Safari throws on write, and a demo must not die because of it.
 */

export const STORAGE_KEYS = {
  theme: 'voyager.theme',
  accessToken: 'voyager.accessToken',
  refreshToken: 'voyager.refreshToken',
  /** Session-scoped on purpose: the admin secret never survives the tab. */
  adminSecret: 'voyager.adminSecret',
  recentSearches: 'voyager.recentSearches',
} as const;

type Store = 'local' | 'session';

function backing(store: Store): Storage | null {
  try {
    return store === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string, store: Store = 'local'): string | null {
  try {
    return backing(store)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string, store: Store = 'local'): void {
  try {
    backing(store)?.setItem(key, value);
  } catch {
    /* storage unavailable -- the feature degrades, the app does not */
  }
}

export function clearStored(key: string, store: Store = 'local'): void {
  try {
    backing(store)?.removeItem(key);
  } catch {
    /* as above */
  }
}

export function readJson<T>(key: string, fallback: T, store: Store = 'local'): T {
  const value = readStored(key, store);
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, store: Store = 'local'): void {
  writeStored(key, JSON.stringify(value), store);
}
