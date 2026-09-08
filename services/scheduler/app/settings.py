from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration for the scheduling service."""

    model_config = SettingsConfigDict(env_prefix="SCHEDULER_", extra="ignore")

    port: int = 8000
    service_name: str = "ultrakil-scheduler"
    version: str = "0.1.0"
    # Required by default. Private/local runtimes may explicitly opt out below;
    # public deployments should supply this value to protect the /solve route.
    api_token: str | None = None
    # Safe by default. Only explicitly private/local runtimes may opt out of
    # authentication; public deployments must leave this false.
    allow_unauthenticated: bool = False


settings = Settings()
