"""Custom spans and span tags (03-EXECUTION-ORDER.md phase 8, items 6 to 8).

`ddtrace-run` already produces the request, Postgres and HTTP spans, so nothing
here starts a tracer. What auto-instrumentation cannot know is which part of an
authorization is the idempotency check and which is the provider call, so the
spans phase 8 names are opened by hand at the point that work happens.

Every tag name in the service is spelled once, here. A tag spelled two ways is
two facets in Datadog and neither of them is complete.
"""

from __future__ import annotations

import traceback
from typing import Any

from ddtrace import Span, tracer
from ddtrace.constants import ERROR_MSG, ERROR_STACK, ERROR_TYPE


def tag_root(tags: dict[str, Any]) -> None:
    """Tag the request's local root span, dropping values that are absent.

    The root rather than the current span: a tag on a leaf can only be found by
    someone who already knows which leaf to open, while on the root it is a
    facet the trace list can be filtered by. Absent values are dropped rather
    than written empty, because a blank `payment.decline_code` and a payment
    that was never declined are then the same search result.
    """
    root = tracer.current_root_span()
    if root is None:
        return
    for key, value in tags.items():
        if value not in (None, ""):
            root.set_tag_str(key, str(value))


def tag_booking(booking: dict) -> None:
    """The booking facets, read off booking-service's response.

    `usr.tier` is not among them: this service never sees a traveller, only a
    booking, and the tier is not on the booking. It belongs to whoever holds
    the token.
    """
    tag_root(
        {
            "booking.id": booking.get("id"),
            "booking.pnr": booking.get("pnr"),
            "booking.state": booking.get("state"),
            "product.type": booking.get("productType"),
            "usr.id": booking.get("userId"),
        }
    )


def tag_payment(payment: dict) -> None:
    """The payment facets, read off a payments row.

    `payment.decline_code` is the reason a decline needs no error span: § 13.3
    wants the outcome searchable without it counting as a fault, and this tag
    is what makes "show me every insufficient_funds" answerable.
    """
    tag_root(
        {
            "booking.id": payment.get("booking_id"),
            "payment.provider": payment.get("provider"),
            "payment.decline_code": payment.get("decline_code"),
        }
    )


def record_error(
    kind: str, message: str, exc: BaseException, *, span: Span | None = None
) -> None:
    """Carry a typed error onto a span, by default the request's local root.

    Set by hand rather than left to the tracer for two reasons. On the root the
    exception never reaches the tracer at all -- it is turned into the § 13.2
    envelope first, so all the tracer sees is a response with a 5xx status and
    no error type. On a client span the tracer would stamp its own,
    module-qualified spelling of the class, and one fault spelled two ways is
    two Error Tracking issues.

    `kind` is the bare class name -- the same string the envelope returns --
    and `message` is that class's constant. Interpolate a payment id or an
    amount into either and Error Tracking groups one issue per request instead
    of one per fault, which is the failure this whole hierarchy exists to
    avoid.
    """
    target = span or tracer.current_root_span()
    if target is None:
        return
    target.error = 1
    target.set_tag_str(ERROR_TYPE, kind)
    target.set_tag_str(ERROR_MSG, message)
    target.set_tag_str(
        ERROR_STACK,
        "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    )
