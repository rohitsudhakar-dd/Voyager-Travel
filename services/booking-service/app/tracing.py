"""Custom spans and span tags (03-EXECUTION-ORDER.md phase 8, items 6 to 8).

`ddtrace-run` already produces the request, Postgres, Redis and HTTP spans, so
nothing here starts a tracer. What auto-instrumentation cannot know is which
part of a handler is the availability check and which is the lock wait, so the
spans phase 8 names are opened by hand at the point that work happens.

Every tag name in the service is spelled once, here. A tag spelled two ways is
two facets in Datadog and neither of them is complete.
"""

from __future__ import annotations

import traceback
from typing import Any

from ddtrace import tracer
from ddtrace.constants import ERROR_MSG, ERROR_STACK, ERROR_TYPE


def tag_root(tags: dict[str, Any]) -> None:
    """Tag the request's local root span, dropping values that are absent.

    The root rather than the current span: a tag on a leaf can only be found by
    someone who already knows which leaf to open, while on the root it is a
    facet the trace list can be filtered by. Absent values are dropped rather
    than written empty, because a blank `usr.id` and a guest booking that
    genuinely has no user are then the same search result.
    """
    root = tracer.current_root_span()
    if root is None:
        return
    for key, value in tags.items():
        if value not in (None, ""):
            root.set_tag_str(key, str(value))


def tag_booking(booking: dict) -> None:
    """The booking facets, read off a booking row.

    `usr.tier` is not among them: the tier lives on `users`, a table this
    service does not own, and nothing upstream forwards the claim. Reading it
    here would buy one span tag at the cost of the rule that keeps the service
    map honest.
    """
    tag_root(
        {
            "booking.id": booking.get("id"),
            "booking.pnr": booking.get("pnr"),
            "booking.state": booking.get("state"),
            "product.type": booking.get("product_type"),
            "usr.id": booking.get("user_id"),
        }
    )


def tag_transition(booking: dict) -> None:
    """Record what a state transition produced, on the transition span as well
    as on the root.

    Both, because they answer different questions and in the payment-events
    consumer only one of them exists: there is no request span there, so
    `booking.state_transition` is itself the local root.
    """
    span = tracer.current_span()
    if span is not None:
        span.set_tag_str("booking.state", booking["state"])
    tag_booking(booking)


def record_error(kind: str, message: str, exc: BaseException) -> None:
    """Carry a typed error onto the request's root span.

    Set from the handler rather than left to the tracer: the exception is
    turned into the § 13.2 envelope before it can escape, so all the tracer
    ever sees is a response with a 5xx status and no error type at all.

    `kind` is the bare class name -- the same string the envelope returns --
    and `message` is that class's constant. Interpolate a booking id into
    either and Error Tracking groups one issue per request instead of one per
    fault, which is the failure this whole hierarchy exists to avoid.
    """
    root = tracer.current_root_span()
    if root is None:
        return
    root.error = 1
    root.set_tag_str(ERROR_TYPE, kind)
    root.set_tag_str(ERROR_MSG, message)
    root.set_tag_str(
        ERROR_STACK,
        "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    )
