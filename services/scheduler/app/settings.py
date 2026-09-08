from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration for the scheduling service."""

    model_config = SettingsConfigDict(env_prefix="SCHEDULER_", extra="ignore")

    port: int = 8000
    service_name: str = "ultrakil-scheduler"
    version: str = "0.1.0"
    # Optional locally so the Docker development path stays frictionless. The
    # Vercel deployment supplies this value to protect the public /solve route.
    api_token: str | None = None


settings = Settings()
