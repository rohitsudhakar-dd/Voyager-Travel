import { env } from '@/lib/env';
import { NetworkError, toApiError } from './errors';
import { endpoints } from './endpoints';
import { adminSecret, tokens } from './tokens';

/**
 * The single HTTP client. Everything the browser sends to api-gateway goes
 * through `request`, which keeps the auth, admin-gate and error-envelope
 * handling in one readable place.
 */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Extra headers; `Idempotency-Key` on payment authorize is the real user. */
  headers?: Record<string, string>;
  /** Send `X-Voyager-Admin`. Admin calls 401 without it, with no hint. */
  admin?: boolean;
  signal?: AbortSignal;
  /** Skip the refresh-and-retry dance -- used by the refresh call itself. */
  skipRefresh?: boolean;
}

function url(path: string, query?: RequestOptions['query']): string {
  const base = `${env.apiBaseUrl}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised ? `${base}?${serialised}` : base;
}

function buildHeaders(options: RequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (tokens.access) headers.set('Authorization', `Bearer ${tokens.access}`);
  if (options.admin) {
    const secret = adminSecret();
    if (secret) headers.set('X-Voyager-Admin', secret);
  }
  return headers;
}

/** A single in-flight refresh, so a burst of 401s does not stampede. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!tokens.refresh) return false;
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(url(endpoints.auth.refresh), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refresh }),
      });
      if (!response.ok) {
        tokens.clear();
        return false;
      }
      const payload = (await response.json()) as { accessToken: string };
      tokens.set({ accessToken: payload.accessToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  try {
    return await fetch(url(path, options.query), {
      method: options.method ?? 'GET',
      headers: buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'omit',
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError();
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  if (response.status === 401 && !options.skipRefresh && tokens.refresh) {
    if (await refreshAccessToken()) response = await send(path, options);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Open an SSE stream. Used only by the support chat, which answers
 * `POST /support/conversations/{id}/messages` with `text/event-stream`, so
 * `EventSource` (GET-only) is not an option.
 */
export async function stream(
  path: string,
  options: RequestOptions & { onEvent: (data: string) => void },
): Promise<void> {
  const headers = buildHeaders(options);
  headers.set('Accept', 'text/event-stream');

  let response: Response;
  try {
    response = await fetch(url(path, options.query), {
      method: options.method ?? 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError();
  }

  if (!response.ok) throw await toApiError(response);
  if (!response.body) throw new NetworkError('The support stream closed unexpectedly.');

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // Events are separated by a blank line; a `data:` field may be repeated.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) options.onEvent(data);
      boundary = buffer.indexOf('\n\n');
    }
  }
}
