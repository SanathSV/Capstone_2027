"""Request/response schemas for integrations and connection testing."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.models.enums import IntegrationProvider, IntegrationStatus


class IntegrationRead(BaseModel):
    """Stored integration state. Never carries a credential value."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    team_id: uuid.UUID
    provider: IntegrationProvider
    status: IntegrationStatus
    domain: str | None = Field(default=None, examples=["capstone-core.atlassian.net"])
    config: dict[str, Any] = Field(default_factory=dict)
    # Pointer into the secret store — safe to expose, the token itself is not.
    credential_ref: str | None = Field(default=None, examples=["vault://astra/capstone-core/jira"])
    last_tested_at: datetime | None = None
    last_test_latency_ms: int | None = Field(default=None, examples=[214])
    last_test_message: str | None = Field(default=None, examples=["Authenticated as Astra Bot"])
    created_at: datetime
    updated_at: datetime


class IntegrationTestRequest(BaseModel):
    """Credentials to validate. Held in memory for the request and discarded."""

    provider: IntegrationProvider
    domain: str = Field(
        min_length=3,
        max_length=255,
        description="Host only, without a scheme.",
        examples=["capstone-core.atlassian.net"],
    )
    token: SecretStr = Field(
        description="API token, personal access token, or service account key.",
    )
    webhook_secret: SecretStr | None = Field(
        default=None, description="Optional; GitHub webhook signing secret."
    )

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "provider": "jira",
                "domain": "capstone-core.atlassian.net",
                "token": "ATATT3xFfGF0T4Jw8mQ2vK9pLxYzR1nS",
            }
        }
    )


class IntegrationTestResponse(BaseModel):
    """Outcome of a connection test. `ok` is the only field worth branching on."""

    provider: IntegrationProvider
    ok: bool
    status: IntegrationStatus
    latency_ms: int = Field(description="Round-trip time of the validation call.", examples=[214])
    message: str = Field(examples=["Authenticated as Astra Bot"])
    checked_at: datetime
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Provider-specific facts discovered during the check.",
        examples=[{"account": "astra-bot", "projects_visible": 3}],
    )

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "provider": "jira",
                "ok": True,
                "status": "active",
                "latency_ms": 214,
                "message": "Authenticated as Astra Bot",
                "checked_at": "2026-09-07T09:32:00Z",
                "details": {"account": "astra-bot", "projects_visible": 3},
            }
        }
    )
