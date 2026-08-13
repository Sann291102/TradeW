import os


class Settings:
    """Reads the repo-root .env at process start (loaded in app.main)."""

    @property
    def service_token(self) -> str:
        return os.environ.get("SENTINEL_PY_SERVICE_TOKEN", "")

    @property
    def port(self) -> int:
        return int(os.environ.get("SENTINEL_PY_PORT", "4011"))

    @property
    def host(self) -> str:
        return os.environ.get("HOST", "127.0.0.1")

    @property
    def cors_origins(self) -> list[str]:
        raw = os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
        return [origin.strip() for origin in raw.split(",") if origin.strip()]


settings = Settings()
