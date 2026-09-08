"""Team configuration and roster logic."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.session import set_tenant_scope
from app.models.team import Team, TeamMember
from app.schemas.team import TeamDetail, TeamUpsert


class TeamNotFoundError(Exception):
    """Raised when no team matches the id under the current tenant scope."""


class SlugConflictError(Exception):
    """Raised when the requested slug already belongs to another team."""


async def get_team(session: AsyncSession, team_id: uuid.UUID) -> Team:
    """Load a team with its roster and integrations in one round trip."""
    result = await session.execute(
        select(Team)
        .where(Team.id == team_id)
        .options(selectinload(Team.members), selectinload(Team.integrations))
    )
    team = result.scalar_one_or_none()
    if team is None:
        raise TeamNotFoundError(str(team_id))
    return team


def to_detail(team: Team) -> TeamDetail:
    """Project a Team onto the response schema, counting incomplete roster rows."""
    unmapped = sum(
        1
        for member in team.members
        if member.is_active and (not member.jira_account_id or not member.github_handle)
    )
    return TeamDetail.model_validate(
        {
            **{
                field: getattr(team, field)
                for field in (
                    "id",
                    "name",
                    "slug",
                    "jira_project_key",
                    "github_repo",
                    "plan",
                    "created_at",
                    "updated_at",
                )
            },
            "members": team.members,
            "integrations": team.integrations,
            "unmapped_member_count": unmapped,
        },
        from_attributes=True,
    )


async def upsert_team(session: AsyncSession, payload: TeamUpsert) -> Team:
    """Create or update a team and replace its roster.

    Creation generates the UUID here, then sets the RLS scope to it before the
    INSERT — the `teams` policy checks `id = app_current_team_id()`, so the row
    could not be written otherwise (see migrations/schema.sql). Updates set the
    same scope to the supplied id, so this function expects an *unscoped*
    session and establishes the scope itself.
    """
    team_id = payload.id or uuid.uuid4()
    await set_tenant_scope(session, team_id)
    await _assert_slug_available(session, payload.slug, team_id)

    if payload.id is None:
        team = Team(
            id=team_id,
            name=payload.name,
            slug=payload.slug,
            jira_project_key=payload.jira_project_key,
            github_repo=payload.github_repo,
            plan=payload.plan,
        )
        session.add(team)
    else:
        team = await get_team(session, payload.id)

        team.name = payload.name
        team.slug = payload.slug
        team.jira_project_key = payload.jira_project_key
        team.github_repo = payload.github_repo
        team.plan = payload.plan

        # Roster is replaced wholesale; delete-orphan cascades the removals.
        team.members.clear()

    await session.flush()

    for member in payload.members:
        session.add(
            TeamMember(
                team_id=team.id,
                meet_display_name=member.meet_display_name,
                jira_account_id=member.jira_account_id,
                jira_display_name=member.jira_display_name,
                github_handle=member.github_handle,
                email=str(member.email) if member.email else None,
                is_active=member.is_active,
            )
        )

    await session.flush()
    return await get_team(session, team.id)


async def _assert_slug_available(session: AsyncSession, slug: str, team_id: uuid.UUID) -> None:
    """Best-effort duplicate check.

    Slugs are globally unique, but RLS hides other tenants' rows from this
    SELECT, so a collision with a team you cannot see slips through here and is
    caught by the unique constraint instead. The API turns either outcome into a
    409; this check only makes the common case a cleaner error.
    """
    result = await session.execute(
        select(Team.id).where(Team.slug == slug, Team.id != team_id).limit(1)
    )
    if result.scalar_one_or_none() is not None:
        raise SlugConflictError(slug)
