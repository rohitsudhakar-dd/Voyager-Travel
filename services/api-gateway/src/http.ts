/**
 * The only way this service talks to another one.
 *
 * Every downstream call goes through `callService`, which is what makes the
 * propagation story a single file: when Phase 8 adds trace headers, they are
 * added here and nowhere else. It also means request-id propagation, timeouts,
 * error translation, and the per-call log line are uniform by construction
 * rather than by everyone remembering.
 */

import { config } from './config';
import { UpstreamError, VoyagerError } from './errors';
import { log } from './logger';

export type Upstream = keyof typeof config.upstreams;

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  requestId: string;
  /** Milliseconds. Search fans out to four providers, so it gets longer. */
  timeoutMs?: number;
  /** Pass the caller's bearer token through to the upstream. */
  authorization?: string;
}

export interface CallResult<T> {
  status: number;
  body: T;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function callService<T = unknown>(
  upstream: Upstream,
  options: CallOptions,
): Promise<CallResult<T>> {
  const method = options.method ?? 'GET';
  const base = config.upstreams[upstream];
  const url = new URL(options.path, base);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    // The same id the caller saw. Without this, a log search for one request
    // stops at the gateway.
    'x-request-id': options.requestId,
    accept: 'application/json',
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.authorization) headers.authorization = options.authorization;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const startedAt = process.hrtime.bigint();

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    log.error(
      {
        http: { method, url_details: { path: url.pathname }, request_id: options.requestId },
        duration: Number(process.hrtime.bigint() - startedAt),
        upstream,
        error: {
          kind: aborted ? 'UpstreamTimeoutError' : 'UpstreamUnreachableError',
          message: (error as Error).message,
        },
      },
      'Downstream call failed',
    );
    throw new UpstreamError(upstream, aborted ? 504 : 502, {
      reason: aborted ? 'timeout' : 'unreachable',
    });
  } finally {
    clearTimeout(timeout);
  }

  const duration = Number(process.hrtime.bigint() - startedAt);
  const text = await response.text();
  const body = text ? safeParse(text) : undefined;

  log.info(
    {
      http: {
        method,
        url_details: { path: url.pathname },
        status_code: response.status,
        request_id: options.requestId,
      },
      duration,
      upstream,
    },
    'Downstream call completed',
  );

  if (response.status >= 400) {
    // An upstream that already speaks the § 13.2 envelope is passed through
    // verbatim. Re-wrapping it would replace a precise error like
    // InvalidBookingTransitionError with a vague gateway one, and the client
    // would lose the only information it could act on.
    if (isEnvelope(body)) {
      throw VoyagerError.fromEnvelope(response.status, body);
    }
    throw new UpstreamError(upstream, response.status, { body });
  }

  return { status: response.status, body: body as T };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isEnvelope(body: unknown): body is { error: Record<string, unknown> } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object'
  );
}

/**
 * Run several downstream calls at once and keep the ones that answered.
 *
 * A BFF page is a collection of panels. One slow loyalty lookup should cost
 * the traveller their points widget, not their whole account page -- so
 * failures are reported alongside the results rather than thrown.
 */
export async function gather<T extends Record<string, unknown>>(
  calls: { [K in keyof T]: Promise<T[K]> },
): Promise<{
  results: { [K in keyof T]: T[K] | null };
  failures: Record<string, string>;
}> {
  const names = Object.keys(calls) as (keyof T)[];
  const settled = await Promise.allSettled(names.map((name) => calls[name]));

  const results = {} as { [K in keyof T]: T[K] | null };
  const failures: Record<string, string> = {};

  names.forEach((name, index) => {
    const outcome = settled[index];
    if (outcome.status === 'fulfilled') {
      results[name] = outcome.value as T[typeof name];
    } else {
      results[name] = null;
      const reason = outcome.reason;
      failures[String(name)] =
        reason instanceof VoyagerError ? reason.type : String(reason?.message ?? reason);
    }
  });

  return { results, failures };
}
