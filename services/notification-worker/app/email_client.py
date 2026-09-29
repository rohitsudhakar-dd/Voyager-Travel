"""HTTP client for mock-email (05-FUNCTIONALITY.md § 5.3).

The distinction the rest of the worker depends on: a `422` is the provider
saying the message is wrong and will always be wrong, so retrying it is
pointless and it goes straight to the DLQ. Anything else -- a 5xx, a timeout, a
refused connection -- is the provider being unavailable, which is worth
retrying.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from app.config import Settings
from app.errors import DependencyError
from app.templates import Notification


@dataclass(frozen=True)
class DeliveryResult:
    accepted: bool
    status_code: int
    message_id: str | None = None
    reason: str | None = None


class EmailClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.email_base_url,
            timeout=settings.email_timeout_seconds,
        )

    async def send(self, notification: Notification) -> DeliveryResult:
        payload = {
            "to": notification.recipient,
            "from": self._settings.email_from_address,
            "subject": notification.subject,
            "template": notification.template,
            "body": notification.body,
            "metadata": {"variables": notification.variables},
        }

        try:
            response = await self._client.post("/v1/send", json=payload)
        except httpx.HTTPError as exc:
            raise DependencyError(
                "The email provider is unreachable.",
                provider="mock-email",
                cause=type(exc).__name__,
            ) from exc

        if response.status_code < 300:
            body = _safe_json(response)
            return DeliveryResult(
                accepted=True,
                status_code=response.status_code,
                message_id=body.get("id") if isinstance(body, dict) else None,
            )

        if 400 <= response.status_code < 500:
            body = _safe_json(response)
            return DeliveryResult(
                accepted=False,
                status_code=response.status_code,
                reason=_reason(body) or "rejected by the provider",
            )

        raise DependencyError(
            "The email provider returned an error.",
            provider="mock-email",
            status_code=response.status_code,
        )

    async def ping(self) -> None:
        response = await self._client.get("/health")
        response.raise_for_status()

    async def close(self) -> None:
        await self._client.aclose()


def _safe_json(response: httpx.Response) -> dict:
    try:
        parsed = response.json()
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _reason(body: dict) -> str | None:
    error = body.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str):
            return message
    return None
