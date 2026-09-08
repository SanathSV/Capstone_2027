"""Application settings, loaded from the environment via Pydantic v2."""

from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    api_v1_prefix: str = "/api/v1"
    port: int = 8000

    # `NoDecode` is required: without it pydantic-settings JSON-decodes any
    # list-typed field straight from the env var, which fails on a plain
    # comma-separated value before `_split_csv` below ever runs.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3000"]
    )
    chrome_extension_ids: Annotated[list[str], NoDecode] = Field(default_factory=list)

    database_url: str = "postgresql+asyncpg://postgres:password@localhost:5432/astra"
    db_echo: bool = False
    db_pool_size: int = 10
    db_max_overflow: int = 5

    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "change-me"
    bot_api_key: str = "change-me"

    @field_validator("cors_origins", "chrome_extension_ids", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @property
    def allowed_origins(self) -> list[str]:
        """Web origins plus one chrome-extension:// origin per configured extension id."""
        return [
            *self.cors_origins,
            *(f"chrome-extension://{ext_id}" for ext_id in self.chrome_extension_ids),
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
