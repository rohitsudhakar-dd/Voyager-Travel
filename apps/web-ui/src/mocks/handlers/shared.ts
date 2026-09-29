import { HttpResponse } from 'msw';
import { chaosNumber, nextId } from '../fixtures/state';
import { rngFrom } from '../fixtures/rng';

/** The envelope from 05-FUNCTIONALITY.md § 13.2, so error paths are real. */
export function errorResponse(
  status: number,
  type: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return HttpResponse.json(
    {
      error: {
        type,
        code,
        message,
        details: details ?? {},
        requestId: nextId('req'),
        traceId: String(rngFrom(type + Date.now()).int(1_000_000_000, 9_999_999_999)),
      },
    },
    { status },
  );
}

export function requestId(): string {
  return nextId('req');
}

/**
 * Fixture latency. Unlike the server-side chaos modules this *is* a sleep: there
 * is no downstream work to slow down in a browser fixture, and the point is only
 * to make the designed loading states reachable without a backend.
 */
export async function delay(baseMs: number, chaosFlag?: string): Promise<void> {
  const extra = chaosFlag ? chaosNumber(chaosFlag) : 0;
  const jitter = Math.random() * baseMs * 0.4;
  await new Promise((resolve) => setTimeout(resolve, baseMs + jitter + extra));
}

export function unauthorisedWithoutAdmin(request: Request) {
  if (!request.headers.get('X-Voyager-Admin')) {
    return errorResponse(401, 'AuthenticationError', 'unauthorized', 'Admin secret required.');
  }
  return null;
}
