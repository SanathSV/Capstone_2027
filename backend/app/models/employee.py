from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

EmploymentStatus = Literal["ACTIVE", "INACTIVE", "ON_LEAVE"]
AgentStatus = Literal["ONLINE", "OFFLINE", "UNKNOWN"]


class AgentMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    device_id: str | None = None
    agent_version: str | None = None
    os: str | None = None
    status: AgentStatus = "UNKNOWN"
    last_heartbeat: datetime | None = None


class EmployeeCreate(BaseModel):
    employee_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    email: EmailStr
    role: str = Field(min_length=1)
    department: str = Field(min_length=1)
    manager_id: str | None = None


class EmployeePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1)
    email: EmailStr | None = None
    role: str | None = Field(default=None, min_length=1)
    department: str | None = Field(default=None, min_length=1)
    manager_id: str | None = None
    employment_status: EmploymentStatus | None = None


class Employee(BaseModel):
    model_config = ConfigDict(extra="ignore")

    employee_id: str
    name: str
    email: EmailStr
    role: str
    department: str
    manager_id: str | None = None
    employment_status: EmploymentStatus
    agent: AgentMetadata = Field(default_factory=AgentMetadata)
    created_at: datetime
    updated_at: datetime


class EmployeePage(BaseModel):
    items: list[Employee]
    next_token: str | None = None


class AgentRegisterRequest(BaseModel):
    employee_id: str = Field(min_length=1)
    device_id: str = Field(min_length=1)
    agent_version: str = Field(min_length=1)
    os: str = Field(min_length=1)


class AgentHeartbeatRequest(BaseModel):
    device_id: str = Field(min_length=1)
    timestamp: datetime
    agent_version: str = Field(min_length=1)
