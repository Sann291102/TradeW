from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import require_service_token
from app.watch import store
from app.watch.poller import sweep_once

router = APIRouter(prefix="/watch", tags=["watch"], dependencies=[Depends(require_service_token)])


class CreateWatchRequest(BaseModel):
    strategyId: str
    symbol: str
    strike: str | None = None
    optionType: Literal["CE", "PE"] | None = None
    expiry: str | None = None


@router.post("", status_code=status.HTTP_201_CREATED)
async def create(body: CreateWatchRequest, user_id: str = Query(..., alias="userId")) -> dict:
    strategy = await _require_strategy(user_id, body.strategyId)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return await store.create_watch(
        user_id, body.strategyId, body.symbol, body.strike, body.optionType, body.expiry
    )


async def _require_strategy(user_id: str, strategy_id: str):
    from app.strategy import store as strategy_store

    return await strategy_store.get_strategy(user_id, strategy_id)


@router.get("")
async def list_for_user(user_id: str = Query(..., alias="userId")) -> list[dict]:
    return await store.list_watches(user_id)


@router.get("/{watch_id}/observations")
async def observations(watch_id: str, limit: int = 50) -> list[dict]:
    """Admin audit trail — what the engine saw on each sweep."""
    return await store.list_observations(watch_id, limit)


@router.post("/sweep")
async def sweep_now() -> dict:
    """Runs one sweep immediately, ignoring the loop's schedule. Exists for
    tests and the admin portal's 'check now' control — the background loop is
    the normal path."""
    evaluated = await sweep_once()
    return {"evaluated": evaluated}
