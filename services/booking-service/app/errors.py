"""The typed error hierarchy and HTTP envelope (05-FUNCTIONALITY.md § 13).

Error *type* names are the low-cardinality facet Error Tracking groups on, so
they are stable strings that never interpolate an id, an amount, or a name.
The variable part goes in `details`.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class VoyagerError(Exception):
    """Base class. `type` is the class name; `code` is the snake_case form."""

    status_code = 500
    code = "internal_error"
    message = "Something went wrong on our side."

    def __init__(
        self,
        message: str | None = None,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message or self.message)
        self.message = message or self.message
        self.details = details

    @property
    def type(self) -> str:
        return type(self).__name__

    def envelope(self, request_id: str, trace_id: str = "") -> dict[str, Any]:
        return {
            "error": {
                "type": self.type,
                "code": self.code,
                "message": self.message,
                "details": self.details,
                "requestId": request_id,
                "traceId": trace_id,
            }
        }


# ------------------------------------------------------------- client side --


class ValidationError(VoyagerError):
    status_code = 400
    code = "validation_failed"
    message = "The request did not pass validation."


class BookingNotFoundError(VoyagerError):
    status_code = 404
    code = "booking_not_found"
    message = "No booking matches that reference."


class InvalidBookingTransitionError(VoyagerError):
    """409, not 400. The request was well-formed; the booking simply is not in
    a state where it can honour it, and the client may legitimately retry
    after re-reading the booking."""

    status_code = 409
    code = "invalid_booking_transition"
    message = "The booking is not in a state that allows this."


class HoldExpiredError(VoyagerError):
    status_code = 409
    code = "hold_expired"
    message = "This reservation has expired. Please start again."


class InventoryUnavailableError(VoyagerError):
    status_code = 409
    code = "inventory_unavailable"
    message = "That seat or room is no longer available."


class DuplicateIdempotencyKeyError(VoyagerError):
    status_code = 409
    code = "duplicate_idempotency_key"
    message = "That idempotency key was already used with a different request."


class PaymentNotFoundError(VoyagerError):
    status_code = 404
    code = "payment_not_found"
    message = "No payment matches that reference."


class PaymentDeclinedError(VoyagerError):
    """A business outcome, not a fault. Deliberately distinct from
    PaymentProviderError so Error Tracking does not blend a customer's expired
    card with our provider being down."""

    status_code = 402
    code = "payment_declined"
    message = "The payment was declined."


class InvalidPaymentTransitionError(VoyagerError):
    status_code = 409
    code = "invalid_payment_transition"
    message = "The payment is not in a state that allows this."


class RefundExceedsCaptureError(VoyagerError):
    status_code = 409
    code = "refund_exceeds_capture"
    message = "A refund cannot exceed the amount captured."


# ------------------------------------------------------------- server side --


class BookingTotalMismatchError(VoyagerError):
    """§ 15: a total that disagrees with its line items is a money bug, and a
    loud failure is strictly better than a quiet wrong number."""

    status_code = 500
    code = "booking_total_mismatch"
    message = "The booking total does not match its items."


class PaymentProviderError(VoyagerError):
    status_code = 502
    code = "payment_provider_error"
    message = "The payment provider could not be reached."


class PricingUnavailableError(VoyagerError):
    status_code = 503
    code = "pricing_unavailable"
    message = "Prices are temporarily unavailable."


class SearchUnavailableError(VoyagerError):
    status_code = 503
    code = "search_unavailable"
    message = "Search is temporarily unavailable."


class DatabaseError(VoyagerError):
    status_code = 503
    code = "database_error"
    message = "The database is temporarily unavailable."


# ----------------------------------------------------------------- wiring --


def install(app, logger) -> None:
    """Register the handlers that turn exceptions into the § 13.2 envelope."""

    from app.middleware import current_request_id

    @app.exception_handler(VoyagerError)
    async def _voyager_error(request: Request, exc: VoyagerError) -> JSONResponse:
        request_id = current_request_id()
        # 5xx is ours to fix and belongs at error level; 4xx is the client
        # telling us something we already model, and would otherwise drown the
        # error rate in expired holds.
        event = logger.error if exc.status_code >= 500 else logger.warning
        event(
            "Request failed",
            error={"kind": exc.type, "message": exc.message},
            request_id=request_id,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.envelope(request_id),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        request_id = current_request_id()
        logger.exception(
            "Request failed",
            error={"kind": type(exc).__name__, "message": str(exc)},
            request_id=request_id,
        )
        return JSONResponse(
            status_code=500,
            content=VoyagerError().envelope(request_id),
        )
