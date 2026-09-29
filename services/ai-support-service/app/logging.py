"""Structured JSON logging against the shared schema (05-FUNCTIONALITY.md § 12).

One schema in four languages is what makes the log-correlation demo work, so the
field names here are not negotiable. `dd.trace_id` injection arrives in Phase 8
with the tracer.

Everything goes through one formatter, including log lines from uvicorn and
aiokafka: "no exceptions" in the schema means the pipeline cannot be allowed to
receive half JSON and half prose.

Rule 2 matters most: `message` is a constant string per log site. All variability
goes into structured fields. Interpolated messages destroy log aggregation and
Error Tracking grouping.
"""

from __future__ import annotations

import logging
import sys
import threading
from datetime import datetime, timezone
from typing import Any

import structlog

# Datadog's canonical levels, not Python's.
_LEVEL_TO_STATUS = {
    "debug": "debug",
    "info": "info",
    "warning": "warn",
    "warn": "warn",
    "error": "error",
    "critical": "critical",
    "exception": "error",
}

# uvicorn installs its own handlers and stops propagation. Left alone, its
# startup and access lines would be the only prose in the pipeline.
_LIBRARY_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

EventDict = dict[str, Any]


def _status(_logger: Any, _method: str, event_dict: EventDict) -> EventDict:
    level = event_dict.pop("level", "info")
    event_dict["status"] = _LEVEL_TO_STATUS.get(level, level)
    return event_dict


def _timestamp(_logger: Any, _method: str, event_dict: EventDict) -> EventDict:
    now = datetime.now(timezone.utc)
    event_dict["timestamp"] = (
        f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"
    )
    return event_dict


def _logger_metadata(_logger: Any, _method: str, event_dict: EventDict) -> EventDict:
    name = event_dict.pop("logger", None) or event_dict.pop("logger_name", None)
    event_dict["logger"] = {
        "name": name or "app",
        "thread_name": threading.current_thread().name,
    }
    return event_dict


def _error_fields(_logger: Any, _method: str, event_dict: EventDict) -> EventDict:
    stack = event_dict.pop("exception", None)
    if stack is None:
        return event_dict
    error = event_dict.get("error")
    if not isinstance(error, dict):
        error = {}
        event_dict["error"] = error
    error.setdefault("stack", stack)
    return event_dict


_SHARED_PROCESSORS = [
    structlog.contextvars.merge_contextvars,
    structlog.stdlib.add_log_level,
    structlog.stdlib.add_logger_name,
    _status,
    _timestamp,
    _logger_metadata,
    structlog.processors.StackInfoRenderer(),
]


def configure_logging(service: str, env: str, version: str, level: str = "INFO") -> None:
    structlog.configure(
        processors=[
            *_SHARED_PROCESSORS,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        # `foreign_pre_chain` is what pulls third-party stdlib records into the
        # same shape as our own.
        foreign_pre_chain=_SHARED_PROCESSORS,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            _error_fields,
            structlog.processors.EventRenamer("message"),
            structlog.processors.JSONRenderer(),
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())

    for name in _LIBRARY_LOGGERS:
        library = logging.getLogger(name)
        library.handlers.clear()
        library.propagate = True

    # service / env / version are on every line, bound once here rather than at
    # every call site.
    structlog.contextvars.bind_contextvars(service=service, env=env, version=version)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
