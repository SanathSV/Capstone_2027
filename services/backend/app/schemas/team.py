"""Request/response schemas for team configuration and the roster mapping."""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.schemas.integration import IntegrationRead

JiraProjectKey = Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9]{1,9}$", examples=["ASTRA"])]
GithubRepo = Annotated[str, Field(pattern=r"^[\w.-]+/[\w.-]+$", examples=["SanathSV/astra"])]
# Alphanumeric with single internal hyphens, max 39 chars. Written without the
# usual lookahead because pydantic-core's regex engine does not support one;
# `-?[a-zA-Z0-9]` enforces the same "no leading, trailing or doubled hyphen" rule.
GithubHandle = Annotated[
    str,
    Field(
        pattern=r"^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$",
        max_length=39,
        examples=["alex-dev"],
    ),
]


class TeamMemberBase(BaseModel):
    """One roster row: Google Meet name -> Jira account -> GitHub handle."""

    meet_display_name: str = Field(
        min_length=1,
        max_length=255,
        description="Exactly as Google Meet reports it — attribution matches on this string.",
        examples=["Alex Smith"],
    )
    jira_account_id: str | None = Field(
        default=None, max_length=128, examples=["5b10ac8d82e05b22cc7d4ef5"]
    )
    jira_display_name: str | None = Field(default=None, max_length=255, examples=["Alex Smith"])
    github_handle: GithubHandle | None = None
    email: EmailStr | None = Field(default=None, examples=["alex.smith@capstone.dev"])
    is_active: bool = True


class TeamMemberCreate(TeamMemberBase):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "meet_display_name": "Alex Smith",
                "jira_account_id": "5b10ac8d82e05b22cc7d4ef5",
                "jira_display_name": "Alex Smith",
                "github_handle": "alex-dev",
                "email": "alex.smith@capstone.dev",
                "is_active": True,
            }
        }
    )


class TeamMemberRead(TeamMemberBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    team_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class TeamBase(BaseModel):
    name: str = Field(min_length=3, max_length=120, examples=["Capstone Core"])
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,60}$", examples=["capstone-core"])
    jira_project_key: JiraProjectKey | None = None
    github_repo: GithubRepo | None = None
    plan: str = Field(default="trial", max_length=32, examples=["pro"])


class TeamUpsert(TeamBase):
    """Create or update a team together with its full roster.

    The roster is replaced wholesale: members absent from `members` are removed.
    Supplying an `id` updates that team; omitting it creates a new one.
    """

    id: uuid.UUID | None = Field(
        default=None,
        description="Omit to create. Provide to update an existing team.",
    )
    members: list[TeamMemberCreate] = Field(default_factory=list, max_length=500)

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "name": "Capstone Core",
                "slug": "capstone-core",
                "jira_project_key": "ASTRA",
                "github_repo": "SanathSV/astra",
                "plan": "pro",
                "members": [
                    {
                        "meet_display_name": "Alex Smith",
                        "jira_account_id": "5b10ac8d82e05b22cc7d4ef5",
                        "github_handle": "alex-dev",
                        "email": "alex.smith@capstone.dev",
                    },
                    {
                        "meet_display_name": "Priya Raghavan",
                        "jira_account_id": "5b10ac8d82e05b22cc7d4ef7",
                        "github_handle": "praghavan",
                    },
                ],
            }
        }
    )


class TeamRead(TeamBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class TeamDetail(TeamRead):
    """Everything the dashboard needs to render team settings in one request."""

    members: list[TeamMemberRead] = Field(default_factory=list)
    integrations: list[IntegrationRead] = Field(default_factory=list)
    unmapped_member_count: int = Field(
        default=0,
        description="Roster rows missing a Jira account or GitHub handle.",
        examples=[1],
    )
