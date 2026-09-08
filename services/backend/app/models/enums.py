"""Enum types shared by the ORM models and the Pydantic schemas.

The `values_callable` on each SQLAlchemy Enum column maps these to the lowercase
PostgreSQL enum labels declared in migrations/schema.sql.
"""

from enum import StrEnum


class IntegrationProvider(StrEnum):
    JIRA = "jira"
    GITHUB = "github"
    GOOGLE_WORKSPACE = "google_workspace"


class IntegrationStatus(StrEnum):
    NOT_LINKED = "not_linked"
    ACTIVE = "active"
    ERROR = "error"


class SessionStatus(StrEnum):
    LIVE = "live"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class ActionItemStatus(StrEnum):
    PENDING = "pending"
    SYNCED = "synced"
    DISMISSED = "dismissed"
    FAILED = "failed"
