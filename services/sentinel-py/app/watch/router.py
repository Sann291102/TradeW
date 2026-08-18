from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import require_service_token
from app.watch import store
from app.watch.poller import sweep_once
from app.watch.timeline import build_timeline

router = APIRouter(prefix="/watch", tags=["watch"], dependencies=[Depends(require_service_token)])


class WatchLegRequest(BaseModel):
    """One listed option contract, carried by IDENTITY rather than by strike.

    `securityId` is the field that makes this an instrument instead of a
    description: it is the Dhan token the live feed subscribes and the
    historical API is addressed by. Without it every consumer re-derives the
    contract from (symbol, expiry, strike, side) on its own, and a
    re-derivation that finds the wrong row produces a confident, wrong chart.
    """

    strike: float
    optionType: Literal["CE", "PE"]
    securityId: str
    exchangeSegment: str
    tradingSymbol: str
    dhanInstrument: str
    lotSize: int | None = None
    tickSize: float | None = None


class CreateWatchRequest(BaseModel):
    """The complete watch configuration.

    Replaces `{symbol, strike, optionType, expiry}` — one leg, and whichever
    one the UI's CE/PE toggle happened to be on. Sentinel observes the
    underlying, a CALL and a PUT together and decides which leg is expressing
    the underlying's move; it cannot do that from one of them.

    `focusedSide` says which leg the strategy's rules are evaluated against. It
    does NOT decide which legs exist — both do, always, for an option watch.
    """

    strategyId: str
    symbol: str
    expiry: str | None = None
    ce: WatchLegRequest | None = None
    pe: WatchLegRequest | None = None
    focusedSide: Literal["CE", "PE"] = "CE"
    watchMode: Literal["option", "underlying"] = "option"
    timeframe: str | None = None


def _validate_pair(body: CreateWatchRequest) -> None:
    """Refuse a request that cannot describe a real pair.

    Re-checked here rather than trusted from the browser. The web form runs the
    same rules (`validateWatchPair`), but the form is a convenience and this is
    the boundary: a watch persisted with a mismatched leg would have Sentinel
    observing a put while every screen said call, and nothing downstream could
    detect it.
    """
    if body.watchMode == "underlying":
        if body.ce is not None or body.pe is not None:
            raise HTTPException(
                status_code=400,
                detail="An underlying watch carries no option legs",
            )
        return

    if not body.expiry:
        raise HTTPException(status_code=400, detail="expiry is required for an option watch")
    if body.ce is None or body.pe is None:
        # Explicitly BOTH. A half-configured pair is the single-strike watch
        # this replaced, arriving under a new field name.
        missing = "ce" if body.ce is None else "pe"
        raise HTTPException(
            status_code=400,
            detail=f"an option watch requires both legs; {missing} is missing",
        )
    # The guard that a CE slot cannot hold a PE contract. Third and last check
    # of this property — the UI's ladders are separate, the bridge's resolver
    # re-checks the side it returns, and this refuses a payload that got past
    # both.
    if body.ce.optionType != "CE":
        raise HTTPException(status_code=400, detail="the ce leg must be a CE contract")
    if body.pe.optionType != "PE":
        raise HTTPException(status_code=400, detail="the pe leg must be a PE contract")
    if not body.ce.securityId or not body.pe.securityId:
        raise HTTPException(status_code=400, detail="both legs must carry a resolved securityId")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create(body: CreateWatchRequest, user_id: str = Query(..., alias="userId")) -> dict:
    strategy = await _require_strategy(user_id, body.strategyId)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    _validate_pair(body)
    return await store.create_watch(
        user_id=user_id,
        strategy_id=body.strategyId,
        symbol=body.symbol,
        expiry=body.expiry,
        ce=body.ce.model_dump() if body.ce else None,
        pe=body.pe.model_dump() if body.pe else None,
        focused_side=body.focusedSide,
        watch_mode=body.watchMode,
        timeframe=body.timeframe,
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
