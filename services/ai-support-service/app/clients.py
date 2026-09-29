"""HTTP clients for the services the tools call.

ai-support-service never mutates a booking itself -- `initiate_cancellation`
calls booking-service, which owns the state machine (05-FUNCTIONALITY.md § 1).
Keeping every downstream call in one file is also what keeps the Phase 8
propagation story to one file.

A 4xx comes back as a response for the tool to interpret ("no booking with that
reference" is an answer the model should relay). A 5xx or a transport failure is
a `DependencyError`, because it is a broken dependency rather than an answer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx

from app.config import Settings
from app.errors import DependencyError


@dataclass(frozen=True)
class Response:
    status_code: int
    body: Any

    @property
    def ok(self) -> bool:
        return self.status_code < 300


class ServiceClient:
    def __init__(self, name: str, base_url: str, timeout: float) -> None:
        self.name = name
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Response:
        try:
            response = await self._client.request(method, path, params=params, json=json)
        except httpx.HTTPError as exc:
            raise DependencyError(
                "A downstream service is unreachable.",
                service=self.name,
                cause=type(exc).__name__,
            ) from exc

        if response.status_code >= 500:
            raise DependencyError(
                "A downstream service returned an error.",
                service=self.name,
                status_code=response.status_code,
            )

        return Response(status_code=response.status_code, body=_safe_json(response))

    async def ping(self) -> None:
        response = await self._client.get("/health")
        response.raise_for_status()

    async def close(self) -> None:
        await self._client.aclose()


class BookingClient(ServiceClient):
    def __init__(self, settings: Settings) -> None:
        super().__init__(
            "voyager-booking",
            settings.booking_base_url,
            settings.downstream_timeout_seconds,
        )

    async def find_by_pnr(self, pnr: str, last_name: str) -> Response:
        # The guest-lookup form of GET /v1/bookings: no auth, PNR plus surname.
        return await self.request(
            "GET", "/v1/bookings", params={"pnr": pnr, "lastName": last_name}
        )

    async def get_booking(self, booking_id: str) -> Response:
        return await self.request("GET", f"/v1/bookings/{booking_id}")

    async def cancel(self, booking_id: str, reason: str) -> Response:
        return await self.request(
            "POST", f"/v1/bookings/{booking_id}/cancel", json={"reason": reason}
        )


class LoyaltyClient(ServiceClient):
    def __init__(self, settings: Settings) -> None:
        super().__init__(
            "voyager-loyalty",
            settings.loyalty_base_url,
            settings.downstream_timeout_seconds,
        )

    async def get_balance(self, user_id: UUID | str) -> Response:
        return await self.request("GET", f"/v1/loyalty/{user_id}")


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None
