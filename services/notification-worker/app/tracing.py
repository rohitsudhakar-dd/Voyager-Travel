"""Custom spans and span tags (03-EXECUTION-ORDER.md phase 8, items 6 and 7).

`ddtrace-run` already produces the health-endpoint and HTTP-client spans, so
nothing here starts a tracer. Rendering an itinerary is the one piece of this
worker's work that is worth timing on its own, and auto-instrumentation cannot
see it, so phase 8's span is opened by hand around it.

ddtrace 2.14 has no aiokafka integration, so a consumed message arrives with no
ambient trace: `notification.render_itinerary` is itself the local root, which
is why the tags go on the root rather than on a parent that does not exist.
"""

from __future__ import annotations

from typing import Any

from ddtrace import tracer

from app.chaos import get_chaos


def tag_root(tags: dict[str, Any]) -> None:
    """Tag the current local root span, dropping values that are absent.

    Absent values are dropped rather than written empty: an event that carries
    no PNR yet and an event whose PNR failed to render are different problems,
    and a blank tag makes them the same search result.
    """
    root = tracer.current_root_span()
    if root is None:
        return
    for key, value in tags.items():
        if value not in (None, ""):
            root.set_tag_str(key, str(value))


def tag_chaos() -> None:
    """`chaos.active_flags`, read from the one chaos reader in the process.

    Tolerates a reader that was never initialised: the templates are unit
    tested without a lifespan, and a missing tag is a better outcome there than
    a failed render.
    """
    try:
        chaos = get_chaos()
    except RuntimeError:
        return
    tag_root({"chaos.active_flags": ",".join(chaos.active_flags())})
