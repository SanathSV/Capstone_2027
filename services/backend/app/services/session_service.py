"""Meeting session queries."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.enums import SessionStatus
from app.models.meeting_session import MeetingSession
from app.schemas.session import ActiveSessionsResponse, SessionDetail

# A call the bot is still involved with: in the room, or crunching the transcript.
ACTIVE_STATUSES = (SessionStatus.LIVE, SessionStatus.PROCESSING)


async def list_active(session: AsyncSession) -> ActiveSessionsResponse:
    """Live and processing sessions, with dashboard totals.

    `active_count` counts only `live` sessions — the number the UI shows as
    "active calls" — while the list also includes sessions still processing.
    """
    result = await session.execute(
        select(MeetingSession)
        .where(MeetingSession.status.in_(ACTIVE_STATUSES))
        .options(selectinload(MeetingSession.action_items))
        .order_by(MeetingSession.started_at.desc())
    )
    rows = list(result.scalars().unique())
    details = [to_detail(row) for row in rows]

    return ActiveSessionsResponse(
        active_count=sum(1 for row in rows if row.status is SessionStatus.LIVE),
        sessions=details,
        total_transcript_words=sum(row.transcript_words for row in rows),
        total_triggers=sum(row.trigger_count for row in rows),
        total_action_items=sum(len(row.action_items) for row in rows),
    )


async def list_sessions(session: AsyncSession, limit: int = 50) -> list[SessionDetail]:
    """Most recent sessions regardless of status, newest first."""
    result = await session.execute(
        select(MeetingSession)
        .options(selectinload(MeetingSession.action_items))
        .order_by(MeetingSession.started_at.desc())
        .limit(limit)
    )
    return [to_detail(row) for row in result.scalars().unique()]


def to_detail(row: MeetingSession) -> SessionDetail:
    """Project a session row, adding the two computed fields the schema expects."""
    return SessionDetail.model_validate(
        {
            **{
                field: getattr(row, field)
                for field in (
                    "id",
                    "team_id",
                    "title",
                    "meeting_code",
                    "status",
                    "started_at",
                    "ended_at",
                    "participant_count",
                    "transcript_words",
                    "trigger_count",
                    "transcript_url",
                )
            },
            "duration_minutes": row.duration_minutes,
            "action_item_count": len(row.action_items),
            "action_items": row.action_items,
        },
        from_attributes=True,
    )
