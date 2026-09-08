"""Shared response envelopes."""

from pydantic import BaseModel, ConfigDict, Field


class ErrorResponse(BaseModel):
    """Body returned with every 4xx/5xx raised by this API."""

    detail: str = Field(examples=["Team not found"])

    model_config = ConfigDict(json_schema_extra={"example": {"detail": "Team not found"}})
