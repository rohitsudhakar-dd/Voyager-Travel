"""Request-scoped context and the single request-completion log line.

§ 12 rule: exactly one completion log per request, emitted by middleware, so
no handler has to remember to log and none of them disagree about the shape.
"""

from __future__ import annotations

import secrets
import time
from contextvars import ContextVar

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app import tracing

_request_id: ContextVar[str] = ContextVar("request_id", default="")

# Liveness probes fire every ten seconds in every container. Logging them
# buries the traffic that matters under probe noise.
_QUIET_PATHS = frozenset({"/health", "/ready"})


def current_request_id() -> str:
    return _request_id.get()


def new_request_id() -> str:
    return "req_" + secrets.token_hex(12)


class RequestContextMiddleware(BaseHTTPMiddleware):
    def __init__(self, app) -> None:
        super().__init__(app)
        self._log = structlog.get_logger()

    async def dispatch(self, request: Request, call_next) -> Response:
        # Read through `runtime` rather than capturing the reader at
        # construction time: the middleware stack is built before the lifespan
        # handler has created it.
        from app.state import runtime

        request_id = request.headers.get("x-request-id") or new_request_id()
        token = _request_id.set(request_id)

        quiet = request.url.path in _QUIET_PATHS
        if not quiet and runtime.chaos is not None:
            await runtime.chaos.refresh()

        started = time.perf_counter_ns()
        try:
            response = await call_next(request)
        finally:
            _request_id.reset(token)

        response.headers["x-request-id"] = request_id
        if quiet:
            return response

        active_flags = (
            runtime.chaos.active_flags() if runtime.chaos is not None else ""
        )
        # The same string on the span and in the log. Six months later it is
        # the only way to tell a genuinely odd trace from a chaos artifact.
        tracing.tag_root({"chaos.active_flags": active_flags})

        self._log.info(
            "Request completed",
            http={
                "method": request.method,
                "url_details": {"path": request.url.path},
                "status_code": response.status_code,
                "request_id": request_id,
            },
            # Nanoseconds, because that is what Datadog's duration remapper
            # expects; anything else silently renders as the wrong magnitude.
            duration=time.perf_counter_ns() - started,
            chaos={"active_flags": active_flags},
        )
        return response
