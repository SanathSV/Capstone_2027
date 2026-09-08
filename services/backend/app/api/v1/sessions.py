"""Meeting session endpoints."""

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import HeaderScopedDb
from app.schemas.common import ErrorResponse
from app.schemas.session import ActiveSessionsResponse, SessionDetail
from app.services import session_service

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get(
    "/active",
    response_model=ActiveSessionsResponse,
    summary="Retrieve live call session metadata",
    responses={400: {"model": ErrorResponse, "description": "Missing X-Team-Id header"}},
)
async def read_active_sessions(db: HeaderScopedDb) -> ActiveSessionsResponse:
    """Sessions the bot is currently attending or still processing.

    Includes each session's action items plus the aggregate counters behind the
    dashboard's stat tiles. `active_count` counts only `live` sessions.
    """
    return await session_service.list_active(db)


@router.get(
    "",
    response_model=list[SessionDetail],
    summary="List recent sessions",
    responses={400: {"model": ErrorResponse, "description": "Missing X-Team-Id header"}},
)
async def read_sessions(
    db: HeaderScopedDb,
    limit: Annotated[int, Query(ge=1, le=200, description="Maximum rows to return")] = 50,
) -> list[SessionDetail]:
    """Most recent sessions of any status, newest first.

    Backs the dashboard's session history table, which shows completed and
    failed calls alongside active ones.
    """
    return await session_service.list_sessions(db, limit=limit)
