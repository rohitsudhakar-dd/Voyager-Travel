import { errorEnvelopeSchema } from '@voyager/shared-schemas';

/**
 * The error envelope from 05-FUNCTIONALITY.md § 13.2, turned into something
 * the UI can branch on.
 *
 * `requestId` is rendered wherever an error surface has room for it: it is the
 * trace id, and reading it off the screen and pasting it into Datadog is a
 * documented demo move.
 */
export class VoyagerApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId?: string;
  readonly traceId?: string;

  constructor(init: {
    status: number;
    type: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
    traceId?: string;
  }) {
    super(init.message);
    this.name = 'VoyagerApiError';
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.details = init.details ?? {};
    this.requestId = init.requestId;
    this.traceId = init.traceId;
  }

  get declineCode(): string | undefined {
    const value = this.details.declineCode;
    return typeof value === 'string' ? value : undefined;
  }
}

/** A transport failure: DNS, TLS, offline, or an aborted request. */
export class NetworkError extends Error {
  constructor(message = 'We could not reach Voyager. Check your connection and try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export async function toApiError(response: Response): Promise<VoyagerApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const { error } = parsed.data;
    return new VoyagerApiError({
      status: response.status,
      type: error.type,
      code: error.code,
      message: error.message,
      details: error.details ?? {},
      requestId: error.requestId,
      traceId: error.traceId,
    });
  }

  // A response that is not enveloped means something upstream of the gateway
  // answered -- the edge proxy, or a crash before the error handler ran.
  return new VoyagerApiError({
    status: response.status,
    type: 'VoyagerError',
    code: 'unexpected_response',
    message:
      response.status >= 500
        ? 'Something went wrong on our side. Please try again.'
        : 'That request could not be completed.',
  });
}

export function isApiError(error: unknown): error is VoyagerApiError {
  return error instanceof VoyagerApiError;
}

export function hasErrorType(error: unknown, ...types: string[]): boolean {
  return isApiError(error) && types.includes(error.type);
}

/** The id worth showing the user, when there is one. */
export function errorRequestId(error: unknown): string | undefined {
  return isApiError(error) ? (error.requestId ?? error.traceId) : undefined;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof VoyagerApiError || error instanceof NetworkError) return error.message;
  return fallback;
}
