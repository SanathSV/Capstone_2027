"""Team configuration and roster endpoints."""

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import TeamScopedDb, UnscopedDb
from app.schemas.common import ErrorResponse
from app.schemas.team import TeamDetail, TeamUpsert
from app.services import team_service

router = APIRouter(prefix="/teams", tags=["teams"])


@router.get(
    "/{team_id}",
    response_model=TeamDetail,
    summary="Fetch complete team configuration",
    responses={404: {"model": ErrorResponse, "description": "No such team"}},
)
async def read_team(
    db: TeamScopedDb,
    team_id: Annotated[uuid.UUID, Path(description="Team UUID")],
) -> TeamDetail:
    """Team settings, integration status, and the full roster mapping.

    One request backs the entire team settings page. Integration rows carry a
    `credential_ref`, never a token.
    """
    try:
        team = await team_service.get_team(db, team_id)
    except team_service.TeamNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found") from exc

    return team_service.to_detail(team)


@router.post(
    "",
    response_model=TeamDetail,
    status_code=status.HTTP_200_OK,
    summary="Create or update a team and its roster",
    responses={
        404: {"model": ErrorResponse, "description": "No such team"},
        409: {"model": ErrorResponse, "description": "Slug already taken"},
    },
)
async def upsert_team(payload: TeamUpsert, db: UnscopedDb) -> TeamDetail:
    """Create a team (omit `id`) or update one (supply `id`).

    The roster is replaced wholesale: members missing from `members` are deleted,
    so send the complete list every time. Action items already assigned to a
    removed member survive with a null assignee.
    """
    try:
        team = await team_service.upsert_team(db, payload)
    except team_service.TeamNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found") from exc
    except team_service.SlugConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Slug '{payload.slug}' is already in use.",
        ) from exc
    except IntegrityError as exc:
        # Reached when the colliding row belongs to a team RLS hid from the
        # pre-check, or when two roster rows share a Meet display name.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Team slug or roster entry conflicts with an existing record.",
        ) from exc

    return team_service.to_detail(team)
