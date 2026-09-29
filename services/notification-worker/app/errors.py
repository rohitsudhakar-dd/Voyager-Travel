"""The slice of the typed hierarchy in 05-FUNCTIONALITY.md § 13 that this
service can raise.

Class names are the `error.type` Error Tracking groups on, so they stay stable
and low-cardinality, and `message` is a constant per class with all the detail
in `details`.

§ 13.1 defines no email-specific `DependencyError` subclass, so a provider that
is unreachable raises the base class rather than a name this service invented.
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


class DependencyError(VoyagerError):
    status = 502
    code = "dependency_error"
