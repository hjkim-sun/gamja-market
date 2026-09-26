from __future__ import annotations

from functools import lru_cache
from urllib.parse import urlparse

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration; secrets are supplied only through environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    database_url: str = Field(min_length=1)
    # Alembic may use a dedicated DDL connection; otherwise it uses the runtime DB.
    migration_database_url: str | None = Field(default=None, min_length=1)
    auth_allowed_origins: list[str] = Field(min_length=1)
    session_cookie_secure: bool
    session_ttl_seconds: int = Field(default=604800, gt=0)
    session_cookie_name: str = "gamja_session"
    application_lock_timeout_ms: int = Field(default=5000, ge=100, le=30000)
    photo_storage_driver: str = "disabled"
    supabase_url: str | None = None
    supabase_secret_key: SecretStr | None = None
    supabase_storage_bucket: str | None = None
    photo_local_storage_dir: str | None = None

    @field_validator("database_url", "migration_database_url")
    @classmethod
    def use_installed_postgres_driver(cls, url: str | None) -> str | None:
        if url is None:
            return None
        if url.startswith("postgresql://"):
            return "postgresql+psycopg://" + url[len("postgresql://") :]
        if url.startswith("postgres://"):
            return "postgresql+psycopg://" + url[len("postgres://") :]
        return url

    @field_validator("auth_allowed_origins")
    @classmethod
    def validate_origins(cls, origins: list[str]) -> list[str]:
        if not origins:
            raise ValueError("AUTH_ALLOWED_ORIGINS must not be empty")
        normalized: list[str] = []
        for origin in origins:
            parsed = urlparse(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.path not in {"", "/"}
                or parsed.params
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("AUTH_ALLOWED_ORIGINS entries must be exact origins")
            canonical = f"{parsed.scheme}://{parsed.netloc}"
            if origin != canonical:
                raise ValueError("AUTH_ALLOWED_ORIGINS entries must not have a trailing slash")
            normalized.append(canonical)
        return normalized

    @model_validator(mode="after")
    def require_https_cookie_in_production(self) -> "Settings":
        if self.migration_database_url is None:
            self.migration_database_url = self.database_url
        if any(origin.startswith("https://") for origin in self.auth_allowed_origins) and not self.session_cookie_secure:
            raise ValueError("SESSION_COOKIE_SECURE must be true for HTTPS origins")
        if self.photo_storage_driver not in {"disabled", "local", "supabase"}:
            raise ValueError("PHOTO_STORAGE_DRIVER must be disabled, local, or supabase")
        if self.photo_storage_driver == "local":
            if not self.photo_local_storage_dir:
                raise ValueError("PHOTO_LOCAL_STORAGE_DIR is required for local storage")
            if any(origin.startswith("https://") for origin in self.auth_allowed_origins):
                raise ValueError("local photo storage cannot be used with HTTPS origins")
        if self.photo_storage_driver == "supabase":
            if not self.supabase_url or not self.supabase_secret_key or not self.supabase_storage_bucket:
                raise ValueError("Supabase photo storage settings are required")
            parsed = urlparse(self.supabase_url)
            if (
                parsed.scheme != "https"
                or not parsed.netloc
                or parsed.username
                or parsed.password
                or parsed.path
                or parsed.params
                or parsed.query
                or parsed.fragment
                or self.supabase_url.endswith("/")
            ):
                raise ValueError("SUPABASE_URL must be an https URL without trailing slash")
            if not self.supabase_storage_bucket.replace("-", "").replace("_", "").isalnum():
                raise ValueError("SUPABASE_STORAGE_BUCKET must be a safe bucket name")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
