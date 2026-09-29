"""The slice of the typed hierarchy in 05-FUNCTIONALITY.md § 13 that this service
can raise, plus the § 13.2 HTTP envelope.

Class names are the `error.type` Error Tracking groups on, so they stay stable
and low-cardinality, and `message` is a constant per class with all the detail in
`details`. `message` is also user-safe: internal detail belongs in the span and
the log, never in the response.
"""

from __future__ import annotations

from typing import Any


class VoyagerError(Exception):
    status = 500
    code = "internal_error"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class ValidationError(VoyagerError):
    status = 400
    code = "validation_error"


class NotFoundError(VoyagerError):
    status = 404
    code = "not_found"


class ConversationNotFoundError(NotFoundError):
    pass


class BusinessRuleError(VoyagerError):
    status = 422
    code = "business_rule_error"


class DependencyError(VoyagerError):
    status = 502
    code = "dependency_error"


class LlmProviderError(DependencyError):
    code = "llm_provider_error"


def envelope(error: VoyagerError, request_id: str, trace_id: str | None = None) -> dict:
    return {
        "error": {
            "type": type(error).__name__,
            "code": error.code,
            "message": error.message,
            "details": error.details,
            "requestId": request_id,
            # Populated by the tracer in Phase 8. It is returned deliberately:
            # it is what lets someone read an ID off a screen and paste it into
            # Datadog.
            "traceId": trace_id,
        }
    }
