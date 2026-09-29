import { STORAGE_KEYS, clearStored, readStored, writeStored } from '@/lib/storage';

/**
 * Token holder, shared by the HTTP client and the auth context.
 *
 * The access token is a 15-minute JWT and the refresh token is opaque
 * (05-FUNCTIONALITY.md § 2.1). Neither is ever logged.
 */

type Listener = () => void;

let accessToken = readStored(STORAGE_KEYS.accessToken);
let refreshToken = readStored(STORAGE_KEYS.refreshToken);
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((listener) => listener());
}

export const tokens = {
  get access() {
    return accessToken;
  },

  get refresh() {
    return refreshToken;
  },

  set(next: { accessToken: string; refreshToken?: string }) {
    accessToken = next.accessToken;
    writeStored(STORAGE_KEYS.accessToken, next.accessToken);
    if (next.refreshToken) {
      refreshToken = next.refreshToken;
      writeStored(STORAGE_KEYS.refreshToken, next.refreshToken);
    }
    notify();
  },

  clear() {
    accessToken = null;
    refreshToken = null;
    clearStored(STORAGE_KEYS.accessToken);
    clearStored(STORAGE_KEYS.refreshToken);
    notify();
  },

  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function adminSecret(): string | null {
  return readStored(STORAGE_KEYS.adminSecret, 'session');
}

export function setAdminSecret(secret: string): void {
  writeStored(STORAGE_KEYS.adminSecret, secret, 'session');
}

export function clearAdminSecret(): void {
  clearStored(STORAGE_KEYS.adminSecret, 'session');
}
