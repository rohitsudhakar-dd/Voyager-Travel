/**
 * The typed error hierarchy and the § 13.2 envelope.
 *
 * Type names are the low-cardinality facet Error Tracking groups on, so they
 * never interpolate an id, an email, or an amount. Variable detail goes in
 * `details`, which is not a facet.
 */

export class VoyagerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  /** Set when the error came from an upstream that already had a type name. */
  private readonly overrideType?: string;

  constructor(
    message: string,
    status = 500,
    code = 'internal_error',
    details?: Record<string, unknown>,
    overrideType?: string,
  ) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.overrideType = overrideType;
  }

  get type(): string {
    return this.overrideType ?? this.name;
  }

  envelope(requestId: string, traceId = ''): { error: Record<string, unknown> } {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        details: this.details ?? null,
        requestId,
        traceId,
      },
    };
  }

  /**
   * Rebuild an upstream's error rather than replacing it.
   *
   * booking-service telling the client "a booking in CONFIRMED cannot be put
   * on hold" is far more useful than the gateway saying "upstream error", and
   * it keeps Error Tracking grouping on the type that actually occurred.
   */
  static fromEnvelope(status: number, body: { error: Record<string, unknown> }): VoyagerError {
    const error = body.error ?? {};
    return new VoyagerError(
      String(error.message ?? 'The request could not be completed.'),
      status,
      String(error.code ?? 'upstream_error'),
      (error.details as Record<string, unknown>) ?? undefined,
      typeof error.type === 'string' ? error.type : undefined,
    );
  }
}

export class ValidationError extends VoyagerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'validation_failed', details);
  }
}

export class UnauthorizedError extends VoyagerError {
  constructor(message = 'Sign in to continue.') {
    super(message, 401, 'unauthorized');
  }
}

export class InvalidCredentialsError extends VoyagerError {
  /**
   * One message for an unknown email and for a wrong password alike.
   * Distinguishing them turns the login form into an account-enumeration
   * oracle.
   */
  constructor() {
    super('That email and password do not match.', 401, 'invalid_credentials');
  }
}

export class ForbiddenError extends VoyagerError {
  constructor(message = 'You do not have access to that.') {
    super(message, 403, 'forbidden');
  }
}

export class NotFoundError extends VoyagerError {
  constructor(message = 'Not found.', details?: Record<string, unknown>) {
    super(message, 404, 'not_found', details);
  }
}

export class EmailAlreadyRegisteredError extends VoyagerError {
  constructor() {
    super('That email is already registered.', 409, 'email_already_registered');
  }
}

export class UnknownChaosFlagError extends VoyagerError {
  constructor(names: string[]) {
    super(
      'Those chaos flags are not in the catalogue.',
      400,
      'unknown_chaos_flag',
      { flags: names },
    );
  }
}

export class UnknownScenarioError extends VoyagerError {
  constructor(id: string) {
    super('No scenario has that id.', 404, 'unknown_scenario', { scenarioId: id });
  }
}

export class UpstreamError extends VoyagerError {
  constructor(upstream: string, status: number, details?: Record<string, unknown>) {
    // 5xx from an upstream is a 502 or 504 here; a 4xx that did not carry an
    // envelope is passed through with its own status so a 404 stays a 404.
    const mapped = status >= 500 ? (status === 504 ? 504 : 502) : status;
    super(
      `The ${upstream} service could not complete the request.`,
      mapped,
      'upstream_error',
      { upstream, upstreamStatus: status, ...details },
    );
  }
}
