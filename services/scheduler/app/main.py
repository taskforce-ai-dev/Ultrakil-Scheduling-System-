"""
UltraKIL scheduling service.

Phase 1 scope for this service is deliberately small: it exists, it is healthy,
and the API can reach it. The constraint model that assigns crews and vehicles to
visits lands with ULK-C06.

It is a separate process from the NestJS API because constraint solving is
CPU-bound and can take seconds. Running it here means a slow solve never blocks a
manager clicking around the dispatch board.
"""

from __future__ import annotations

import time

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.settings import settings

STARTED_AT = time.monotonic()

app = FastAPI(
    title="UltraKIL Scheduling Service",
    description=(
        "Constraint solving for UltraKIL visit assignment.\n\n"
        "This service never relaxes a hard rule to produce a fuller schedule. "
        "A visit that cannot satisfy every hard rule is returned as unassigned, "
        "with the reasons that made it impossible."
    ),
    version=settings.version,
)


class LivenessResponse(BaseModel):
    status: str = Field(examples=["ok"])
    service: str = Field(examples=["ultrakil-scheduler"])
    version: str = Field(examples=["0.1.0"])
    uptime_seconds: float = Field(examples=[142.5])


class ReadinessResponse(LivenessResponse):
    """Readiness for this service currently equals liveness.

    It has no downstream dependencies of its own — the API owns all persistence.
    The endpoint exists separately so that adding a dependency later (a solver
    licence, a cache) does not change the URL contract.
    """


def _uptime_seconds() -> float:
    return round(time.monotonic() - STARTED_AT, 1)


@app.get("/health/live", response_model=LivenessResponse, tags=["health"])
def live() -> LivenessResponse:
    """Liveness probe. Returns 200 while the process is running."""
    return LivenessResponse(
        status="ok",
        service=settings.service_name,
        version=settings.version,
        uptime_seconds=_uptime_seconds(),
    )


@app.get("/health/ready", response_model=ReadinessResponse, tags=["health"])
def ready() -> ReadinessResponse:
    """Readiness probe. Polled by the API's own /api/health/ready."""
    return ReadinessResponse(
        status="ok",
        service=settings.service_name,
        version=settings.version,
        uptime_seconds=_uptime_seconds(),
    )
