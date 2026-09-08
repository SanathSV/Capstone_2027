"""Liveness endpoint."""

from fastapi import APIRouter

from app.core.openapi import API_VERSION
from app.schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, summary="Liveness probe")
async def health() -> HealthResponse:
    """Always 200 when the process is serving.

    Deliberately does not touch Postgres or Redis: the dashboard polls this
    every 15 seconds, and a dependency check belongs on a separate readiness
    route.
    """
    return HealthResponse(status="ok", version=API_VERSION)
