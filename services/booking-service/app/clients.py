"""HTTP clients for the services booking depends on.

One shared connection pool per process; creating a client per request is the
classic way to run a service out of ephemeral ports under load.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.config import get_settings
from app.errors import PricingUnavailableError, SearchUnavailableError

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=2.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


async def fetch_search_result(search_id: str, result_id: str) -> dict[str, Any]:
    """Re-read the offer the traveller picked.

    Search results live for 120 seconds. Reading the offer again rather than
    trusting the client's copy is what stops a stale or edited price becoming
    a booking.
    """
    settings = get_settings()
    url = f"{settings.search_base_url}/v1/search/{search_id}/results/{result_id}"
    try:
        response = await client().get(url)
    except httpx.HTTPError as exc:
        raise SearchUnavailableError(details={"searchId": search_id}) from exc

    if response.status_code == 410:
        from app.errors import ValidationError

        raise ValidationError(
            "Those search results have expired. Please search again.",
            details={"searchId": search_id},
        )
    if response.status_code == 404:
        from app.errors import ValidationError

        raise ValidationError(
            "That offer is no longer in the search results.",
            details={"searchId": search_id, "resultId": result_id},
        )
    if response.status_code >= 400:
        raise SearchUnavailableError(
            details={"searchId": search_id, "status": response.status_code}
        )
    return response.json()["result"]


async def price_ancillaries(offers: list[dict[str, Any]]) -> dict[str, dict]:
    """Price added seats, bags, and upgrades through pricing-service."""
    if not offers:
        return {}

    settings = get_settings()
    try:
        response = await client().post(
            f"{settings.pricing_base_url}/v1/price/batch", json={"offers": offers}
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise PricingUnavailableError() from exc

    return {quote["id"]: quote for quote in response.json()["quotes"]}
