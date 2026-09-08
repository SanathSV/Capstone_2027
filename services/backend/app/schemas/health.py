from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    status: str = Field(examples=["ok"])
    service: str = "astra-backend"
    version: str = Field(examples=["0.1.0"])

    model_config = ConfigDict(
        json_schema_extra={
            "example": {"status": "ok", "service": "astra-backend", "version": "0.1.0"}
        }
    )
