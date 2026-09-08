"""action_items — work extracted from a transcript."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Enum, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import ActionItemStatus

if TYPE_CHECKING:
    from app.models.meeting_session import MeetingSession
    from app.models.team import TeamMember


class ActionItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "action_items"

    team_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("meeting_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # NULL when the speaker could not be matched to a roster entry.
    assignee_member_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL")
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str | None] = mapped_column(Text)
    status: Mapped[ActionItemStatus] = mapped_column(
        Enum(
            ActionItemStatus,
            name="action_item_status",
            values_callable=lambda enum: [member.value for member in enum],
        ),
        nullable=False,
        default=ActionItemStatus.PENDING,
    )
    jira_issue_key: Mapped[str | None] = mapped_column(String(32))
    # Verbatim transcript line the item came from, kept for auditability.
    source_quote: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))

    session: Mapped[MeetingSession] = relationship(back_populates="action_items")
    assignee: Mapped[TeamMember | None] = relationship(lazy="joined")
