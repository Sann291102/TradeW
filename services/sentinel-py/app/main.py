from pathlib import Path

from dotenv import load_dotenv

# Root .env is the single source of truth for the monorepo — mirrors
# services/sentinel/src/main.ts. override=True so a pre-set empty env var
# from the dev host doesn't shadow the real value.
load_dotenv(Path(__file__).resolve().parents[3] / ".env", override=True)

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.health import router as health_router  # noqa: E402

app = FastAPI(
    title="Sentinel (Python)",
    description=(
        "Personal strategy watcher — internal service, called exclusively by "
        "services/api. Watches the user's own declared strategy and alerts; "
        "never suggests trades, never places orders."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_headers=["content-type", "x-service-token"],
    allow_methods=["*"],
)

app.include_router(health_router)


def run() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()
