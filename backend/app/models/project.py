from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ProjectStatus = Literal[
    "PLANNED",
    "ACTIVE",
    "IN_PROGRESS",
    "ON_HOLD",
    "COMPLETED",
    "ARCHIVED",
]


class GitHubConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["github"] = "github"
    organization: str = Field(min_length=1)
    repository: str = Field(min_length=1)
    repository_id: str = Field(min_length=1)
    default_branch: str = Field(min_length=1)
    installation_id: str = Field(min_length=1)


class JiraConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["jira"] = "jira"
    cloud_id: str = Field(min_length=1)
    project_key: str = Field(min_length=1)


class ProjectCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str | None = None
    status: ProjectStatus = "PLANNED"
    owner_employee_id: str | None = None
    department: str | None = None
    github: GitHubConfig | None = None
    jira: JiraConfig | None = None


class ProjectUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    status: ProjectStatus | None = None
    owner_employee_id: str | None = None
    department: str | None = None
    github: GitHubConfig | None = None
    jira: JiraConfig | None = None


class ProjectResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    project_id: str
    name: str
    description: str | None = None
    status: ProjectStatus
    owner_employee_id: str | None = None
    department: str | None = None
    github: GitHubConfig | None = None
    jira: JiraConfig | None = None
    created_at: datetime
    updated_at: datetime


class ProjectPage(BaseModel):
    items: list[ProjectResponse]
    next_token: str | None = None
