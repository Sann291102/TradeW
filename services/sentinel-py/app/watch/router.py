from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import require_service_token
from app.watch import store
from app.watch.poller import sweep_once
from app.watch.timeline import build_timeline

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


class OpenPositionRequest(BaseModel):
    """The user's own numbers for a position they have ALREADY taken.
    Sentinel proposes none of these — see app/intrade/monitor.py."""

    entryPrice: float
    # The price at which the user considers the idea wrong. Named for what it
    # means rather than as an order type, matching the vocabulary rules.
    invalidationPrice: float
    projectedPrice: float | None = None
    direction: Literal["LONG", "SHORT"]


@router.post("/{watch_id}/position")
async def open_position(
    watch_id: str, body: OpenPositionRequest, user_id: str = Query(..., alias="userId")
) -> dict:
    """'I have taken this position' — moves the watch to IN_TRADE."""
    if body.entryPrice == body.invalidationPrice:
        # Risk of zero has no scale to measure progress against, and every
        # R-multiple would divide by it.
        raise HTTPException(status_code=400, detail="entryPrice and invalidationPrice must differ")
    row = await store.open_position(
        user_id, watch_id, body.entryPrice, body.invalidationPrice, body.projectedPrice, body.direction
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Watch not found")
    return row


@router.delete("/{watch_id}/position")
async def close_position(watch_id: str, user_id: str = Query(..., alias="userId")) -> dict:
    """'I have closed this position' — moves the watch to EXITED."""
    row = await store.close_position(user_id, watch_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Watch not found")
    return row


@router.get("/{watch_id}/timeline")
async def timeline(watch_id: str, user_id: str = Query(..., alias="userId"), limit: int = 100) -> dict:
    """The event stream the workspace feed renders. Scoped by userId so one
    user cannot read another's watch history."""
    watch = await store.get_watch(user_id, watch_id)
    if watch is None:
        raise HTTPException(status_code=404, detail="Watch not found")
    observations = await store.list_observations(watch_id, limit)
    # The strategy is loaded for its timeframe alone. A missing strategy is not
    # fatal here — the watch and its history are still the truth about what was
    # observed — so the timeline degrades to "timeframe unspecified" rather
    # than 404ing on a soft-deleted strategy.
    strategy = await _require_strategy(user_id, watch["strategyId"])
    return build_timeline(watch, observations, (strategy or {}).get("rules"))
