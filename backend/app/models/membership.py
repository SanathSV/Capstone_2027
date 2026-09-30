from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MembershipStatus = Literal["ACTIVE", "INACTIVE"]


class MembershipCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(min_length=1)
    team_id: str | None = None
    role: str = Field(min_length=1)
    allocation_percentage: int = Field(ge=0, le=100)


class MembershipUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: str | None = None
    role: str | None = Field(default=None, min_length=1)
    allocation_percentage: int | None = Field(default=None, ge=0, le=100)
    status: MembershipStatus | None = None


class MembershipResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    project_id: str
    employee_id: str
    team_id: str | None = None
    role: str
    allocation_percentage: int
    status: MembershipStatus
    joined_at: datetime
    updated_at: datetime
