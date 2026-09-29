"""The client for mock-payments.

Everything here separates the two failure modes carefully: a non-2xx from the
provider is a `PaymentProviderError` (our problem, an ERROR state), while a
200 carrying a decline code is a business outcome the caller handles.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.config import get_settings
from app.errors import PaymentProviderError

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            # Generous, because `payment_latency_ms` exists precisely to push
            # this call into the seconds. A timeout that fires at two seconds
            # would turn scenario S2's brown-out into a flat outage.
            timeout=httpx.Timeout(15.0, connect=2.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


async def charge(
    *,
    amount_cents: int,
    currency: str,
    card: dict[str, Any],
    idempotency_key: str,
    booking_id: str,
) -> dict[str, Any]:
    settings = get_settings()
    return await _post(
        f"{settings.payments_base_url}/v1/charges",
        {
            "amount": amount_cents,
            "currency": currency,
            "card": card,
            "idempotency_key": idempotency_key,
            "metadata": {"bookingId": booking_id},
        },
    )


async def capture(reference: str, amount_cents: int | None = None) -> dict[str, Any]:
    settings = get_settings()
    body = {} if amount_cents is None else {"amount": amount_cents}
    return await _post(
        f"{settings.payments_base_url}/v1/charges/{reference}/capture", body
    )


async def refund(reference: str, amount_cents: int) -> dict[str, Any]:
    settings = get_settings()
    return await _post(
        f"{settings.payments_base_url}/v1/charges/{reference}/refund",
        {"amount": amount_cents},
    )


async def complete_3ds(reference: str, *, success: bool) -> dict[str, Any]:
    settings = get_settings()
    return await _post(
        f"{settings.payments_base_url}/v1/charges/{reference}/3ds/complete",
        {"success": success},
    )


async def _post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        response = await client().post(url, json=body)
    except httpx.HTTPError as exc:
        raise PaymentProviderError(
            "The payment provider could not be reached.",
            details={"reason": type(exc).__name__},
        ) from exc

    if response.status_code >= 500:
        raise PaymentProviderError(
            "The payment provider returned an error.",
            details={"status": response.status_code},
        )
    if response.status_code >= 400:
        raise PaymentProviderError(
            "The payment provider rejected the request.",
            details={"status": response.status_code},
        )
    return response.json()
