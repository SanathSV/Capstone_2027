"""meeting_sessions — one row per call the bot joined."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import SessionStatus

if TYPE_CHECKING:
    from app.models.action_item import ActionItem
    from app.models.team import Team


class MeetingSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "meeting_sessions"

    team_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    # Google Meet code, e.g. hqx-mnbv-trz.
    meeting_code: Mapped[str] = mapped_column(String(12), nullable=False)
    status: Mapped[SessionStatus] = mapped_column(
        Enum(
            SessionStatus,
            name="session_status",
            values_callable=lambda enum: [member.value for member in enum],
        ),
        nullable=False,
        default=SessionStatus.LIVE,
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    participant_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    transcript_words: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    trigger_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    transcript_url: Mapped[str | None] = mapped_column(Text)

    team: Mapped[Team] = relationship(back_populates="sessions")
    action_items: Mapped[list[ActionItem]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    @property
    def duration_minutes(self) -> int:
        """Elapsed time for a live call, total runtime for a finished one."""
        end = self.ended_at or datetime.now(tz=self.started_at.tzinfo)
        return max(0, int((end - self.started_at).total_seconds() // 60))
