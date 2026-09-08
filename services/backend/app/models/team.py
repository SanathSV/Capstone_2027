"""teams and team_members."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.integration import Integration
    from app.models.meeting_session import MeetingSession


class Team(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "teams"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    jira_project_key: Mapped[str | None] = mapped_column(String(10))
    github_repo: Mapped[str | None] = mapped_column(String(255))
    plan: Mapped[str] = mapped_column(String(32), nullable=False, default="trial")

    members: Mapped[list[TeamMember]] = relationship(
        back_populates="team",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="TeamMember.meet_display_name",
    )
    integrations: Mapped[list[Integration]] = relationship(
        back_populates="team",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    sessions: Mapped[list[MeetingSession]] = relationship(
        back_populates="team",
        cascade="all, delete-orphan",
        lazy="noload",
    )


class TeamMember(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One person, mapped across Google Meet, Jira and GitHub."""

    __tablename__ = "team_members"
    __table_args__ = (
        UniqueConstraint("team_id", "meet_display_name", name="team_members_unique_meet_name"),
    )

    team_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Must match the display name Google Meet reports, or attribution fails.
    meet_display_name: Mapped[str] = mapped_column(Text, nullable=False)
    jira_account_id: Mapped[str | None] = mapped_column(String(128))
    jira_display_name: Mapped[str | None] = mapped_column(String(255))
    github_handle: Mapped[str | None] = mapped_column(String(39))
    email: Mapped[str | None] = mapped_column(String(320))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    team: Mapped[Team] = relationship(back_populates="members")
