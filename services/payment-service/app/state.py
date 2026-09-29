"""Process-wide singletons.

A small module rather than globals scattered through the routers, so the
lifespan handler has one obvious place to build and tear them down.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.chaos import ChaosReader
from app.kafka.producer import Producer


@dataclass
class Runtime:
    chaos: ChaosReader = None  # type: ignore[assignment]
    producer: Producer = None  # type: ignore[assignment]
    hold_ttl_minutes: int = 15

    # `booking_memory_leak` parks itineraries here and never evicts them. The
    # leak is real: this dict is reachable from a module-level object for the
    # life of the process, so the heap genuinely grows.
    leaked_itineraries: dict[str, Any] = field(default_factory=dict)


runtime = Runtime()
