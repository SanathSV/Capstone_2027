"""Async SQLAlchemy engine, session factory, and the RLS tenant scope."""

import uuid
from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=settings.db_echo,
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    future=True,
)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a request-scoped session with no tenant scope.

    Only for queries that touch no tenant data. Anything reading `teams`,
    `team_members`, `integrations`, `meeting_sessions` or `action_items` must go
    through `tenant_session` instead — without a scope, RLS returns zero rows.
    """
    async with SessionLocal() as session:
        yield session


async def set_tenant_scope(session: AsyncSession, team_id: uuid.UUID) -> None:
    """Bind the current transaction to one team for row-level security.

    `SET LOCAL` is transaction-scoped, so the setting is discarded on commit or
    rollback and cannot leak to the next request that reuses this pooled
    connection. The value is bound as a parameter rather than interpolated:
    `SET LOCAL` does not accept placeholders directly, hence `set_config`.
    """
    await session.execute(
        text("SELECT set_config('app.current_team_id', :team_id, true)"),
        {"team_id": str(team_id)},
    )


async def tenant_session(team_id: uuid.UUID) -> AsyncGenerator[AsyncSession, None]:
    """Yield a session already scoped to `team_id`."""
    async with SessionLocal() as session, session.begin():
        await set_tenant_scope(session, team_id)
        yield session
