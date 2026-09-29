/**
 * The slice of the typed hierarchy in 05-FUNCTIONALITY.md § 13 that this
 * service can actually raise. Class names are the `error.type` Error Tracking
 * groups on, so they stay stable and low-cardinality; `message` is a constant
 * per class and all detail goes in `details`.
 */

export abstract class VoyagerError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends VoyagerError {
  readonly status = 400;
  readonly code = 'validation_error';
}

export class NotFoundError extends VoyagerError {
  readonly status = 404;
  readonly code = 'not_found';
}

export class DatabaseError extends VoyagerError {
  readonly status = 503;
  readonly code = 'database_error';
}

/** The § 13.2 envelope. `traceId` is populated by the tracer in Phase 8. */
export function toEnvelope(
  error: VoyagerError,
  requestId: string,
): Record<string, unknown> {
  return {
    error: {
      type: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
      requestId,
      traceId: null,
    },
  };
}
