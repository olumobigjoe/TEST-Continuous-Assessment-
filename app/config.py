from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_name: str = "TEST Management"
    environment: str = "development"
    secret_key: str = "development-only-change-this-secret-key"
    database_url: str = "sqlite:///./test_management.db"
    access_token_expire_minutes: int = 720
    cookie_secure: bool = False
    default_timezone: str = "Africa/Lagos"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

settings = Settings()
