"""structlog wired to the shared log schema (05-FUNCTIONALITY.md § 12).

Every service in every language emits these same keys, which is what lets one
Datadog log pipeline serve the whole application.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from typing import Any

import structlog

# Python's level names are not Datadog's canonical status values, and a
# mismatch here shows up as a broken status remapper in the log pipeline.
_LEVEL_TO_STATUS = {
    "debug": "debug",
    "info": "info",
    "warning": "warn",
    "warn": "warn",
    "error": "error",
    "critical": "critical",
    "exception": "error",
}


def _rename_level(_logger: Any, _name: str, event: dict) -> dict:
    level = event.pop("level", "info")
    event["status"] = _LEVEL_TO_STATUS.get(level, level)
    return event


def _timestamp(_logger: Any, _name: str, event: dict) -> dict:
    event["timestamp"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return event


def configure(service: str, env: str, version: str) -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=logging.INFO)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            _rename_level,
            _timestamp,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            # `event` is structlog's name for the message; the schema calls it
            # `message`, and the Datadog message remapper expects that key.
            structlog.processors.EventRenamer("message"),
            structlog.processors.JSONRenderer(sort_keys=False),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    structlog.contextvars.bind_contextvars(service=service, env=env, version=version)

    # uvicorn's own access log duplicates the request-completion line the
    # middleware emits, in a different format. One line per request, not two.
    logging.getLogger("uvicorn.access").disabled = True


def get_logger(*args: Any, **kwargs: Any) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(*args, **kwargs)
