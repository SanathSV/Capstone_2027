from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

TaskStatus = Literal[
    "NOT_STARTED",
    "IN_PROGRESS",
    "LIKELY_COMPLETE",
    "VERIFIED_COMPLETE",
    "BLOCKED",
    "UNKNOWN",
]
TaskPriority = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str | None = None
    jira_issue_key: str | None = None
    assignee_id: str | None = None
    team_id: str | None = None
    status: TaskStatus = "NOT_STARTED"
    progress: int = Field(default=0, ge=0, le=100)
    priority: TaskPriority = "MEDIUM"
    estimated_hours: float | None = Field(default=None, ge=0)
    actual_hours: float = Field(default=0, ge=0)
    acceptance_criteria: list[str] = Field(default_factory=list)


class UpdateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    jira_issue_key: str | None = None
    priority: TaskPriority | None = None
    estimated_hours: float | None = Field(default=None, ge=0)
    actual_hours: float | None = Field(default=None, ge=0)
    acceptance_criteria: list[str] | None = None
    assignee_id: str | None = None
    team_id: str | None = None

    # Accepted only to return the required 400 rather than Pydantic's 422.
    status: TaskStatus | None = None
    progress: int | None = Field(default=None, ge=0, le=100)
    completed_at: datetime | None = None
    started_at: datetime | None = None
    astra_confidence: float | None = None
    last_evidence: Any | None = None


class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="ignore")

    project_id: str
    task_id: str
    jira_issue_key: str | None = None
    title: str
    description: str | None = None
    assignee_id: str | None = None
    team_id: str | None = None
    status: TaskStatus
    progress: int
    priority: TaskPriority
    estimated_hours: float | None = None
    actual_hours: float = 0
    acceptance_criteria: list[str] = Field(default_factory=list)
    started_at: datetime | None = None
    last_activity_at: datetime | None = None
    completed_at: datetime | None = None
    astra_confidence: float | None = None
    last_evidence: Any | None = None
    created_at: datetime
    updated_at: datetime


class TaskListResponse(BaseModel):
    items: list[TaskResponse]
    next_token: str | None = None
