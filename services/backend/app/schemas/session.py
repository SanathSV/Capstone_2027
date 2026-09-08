"""Response schemas for meeting sessions and their action items."""

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ActionItemStatus, SessionStatus


class ActionItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    assignee_member_id: uuid.UUID | None = Field(
        default=None, description="Null when the speaker was not on the roster."
    )
    summary: str = Field(examples=["Fix the flaky caption-capture retry in the bot"])
    detail: str | None = None
    status: ActionItemStatus
    jira_issue_key: str | None = Field(default=None, examples=["ASTRA-142"])
    source_quote: str | None = Field(
        default=None, examples=["Alex, can you take the caption retry bug before Friday?"]
    )
    confidence: Decimal | None = Field(default=None, ge=0, le=1, examples=[0.94])
    created_at: datetime


class SessionRead(BaseModel):
    """A meeting capture, with the counters the dashboard renders."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    team_id: uuid.UUID
    title: str = Field(examples=["Sprint 14 Standup"])
    meeting_code: str = Field(examples=["hqx-mnbv-trz"])
    status: SessionStatus
    started_at: datetime
    ended_at: datetime | None = None
    duration_minutes: int = Field(
        description="Elapsed time for a live call, total runtime once ended.", examples=[18]
    )
    participant_count: int = Field(examples=[7])
    transcript_words: int = Field(examples=[2140])
    trigger_count: int = Field(
        description="Transcript phrases that matched an automation rule.", examples=[4]
    )
    action_item_count: int = Field(examples=[2])
    transcript_url: str | None = None


class SessionDetail(SessionRead):
    action_items: list[ActionItemRead] = Field(default_factory=list)


class ActiveSessionsResponse(BaseModel):
    """Live call metadata, plus the totals behind the dashboard's stat tiles."""

    active_count: int = Field(examples=[1])
    sessions: list[SessionDetail] = Field(default_factory=list)
    total_transcript_words: int = Field(examples=[13620])
    total_triggers: int = Field(examples=[16])
    total_action_items: int = Field(examples=[6])

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "active_count": 1,
                "total_transcript_words": 13620,
                "total_triggers": 16,
                "total_action_items": 6,
                "sessions": [
                    {
                        "id": "c1000000-0000-4000-8000-000000000001",
                        "team_id": "a1b2c3d4-0001-4000-8000-000000000001",
                        "title": "Sprint 14 Standup",
                        "meeting_code": "hqx-mnbv-trz",
                        "status": "live",
                        "started_at": "2026-09-07T09:14:00Z",
                        "ended_at": None,
                        "duration_minutes": 18,
                        "participant_count": 7,
                        "transcript_words": 2140,
                        "trigger_count": 4,
                        "action_item_count": 2,
                        "transcript_url": None,
                        "action_items": [],
                    }
                ],
            }
        }
    )
