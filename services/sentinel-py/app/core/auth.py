from fastapi import Header, HTTPException, status

from app.core.config import settings


async def require_service_token(x_service_token: str = Header(default="")) -> None:
    """Guards every route except /health. Mirrors services/sentinel's
    ServiceTokenGuard — services/api is the only caller."""
    expected = settings.service_token
    if not expected or x_service_token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service token")
