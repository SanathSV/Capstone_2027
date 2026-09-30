from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TeamStatus = Literal["ACTIVE", "INACTIVE"]


class TeamCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str | None = None
    team_lead_id: str | None = None


class TeamUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    team_lead_id: str | None = None
    status: TeamStatus | None = None


class TeamResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    project_id: str
    team_id: str
    name: str
    description: str | None = None
    team_lead_id: str | None = None
    status: TeamStatus
    created_at: datetime
    updated_at: datetime


class TeamEmployeeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(min_length=1)
