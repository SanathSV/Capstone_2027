"""Shared FastAPI dependencies."""

import uuid
from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Path, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import SessionLocal, set_tenant_scope


async def scoped_session(team_id: uuid.UUID) -> AsyncGenerator[AsyncSession, None]:
    """Open a transaction bound to one team for the duration of the request.

    The transaction commits on success and rolls back on any exception, which
    also discards the `SET LOCAL` scope before the connection returns to the pool.
    """
    async with SessionLocal() as session, session.begin():
        await set_tenant_scope(session, team_id)
        yield session


async def team_scoped_db(
    team_id: Annotated[uuid.UUID, Path(description="Team UUID")],
) -> AsyncGenerator[AsyncSession, None]:
    """Session scoped to the `team_id` in the path."""
    async for session in scoped_session(team_id):
        yield session


async def header_scoped_db(
    x_team_id: Annotated[
        uuid.UUID | None,
        Header(
            alias="X-Team-Id",
            description="Team UUID scoping the request. Required for tenant data.",
        ),
    ] = None,
) -> AsyncGenerator[AsyncSession, None]:
    """Session scoped to the `X-Team-Id` header, for routes with no team in the path."""
    if x_team_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Team-Id header is required.",
        )
    async for session in scoped_session(x_team_id):
        yield session


async def unscoped_db() -> AsyncGenerator[AsyncSession, None]:
    """Transaction with no tenant scope set yet.

    Only for `POST /teams`, which must establish the scope itself: creating a
    team means choosing its UUID before the INSERT, and updating one means
    scoping to an id that arrives in the body rather than the path.
    """
    async with SessionLocal() as session, session.begin():
        yield session


TeamScopedDb = Annotated[AsyncSession, Depends(team_scoped_db)]
HeaderScopedDb = Annotated[AsyncSession, Depends(header_scoped_db)]
UnscopedDb = Annotated[AsyncSession, Depends(unscoped_db)]
