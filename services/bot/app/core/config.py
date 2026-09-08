"""Bot settings, loaded from the environment."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class BotSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    headless: bool = True
    browser_channel: str = "chromium"
    user_data_dir: str = "./.profile"

    meet_url: str = ""
    bot_display_name: str = "Astra Notetaker"
    join_timeout_seconds: int = 120

    backend_url: str = "http://localhost:8000"
    bot_api_key: str = "change-me"


@lru_cache
def get_settings() -> BotSettings:
    return BotSettings()


settings = get_settings()
