from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.auth import require_service_token
from app.strategy import store
from app.strategy.performance import compute_performance
from app.watch import store as watch_store
from app.strategy.parser import parse_strategy_text
from app.strategy.schemas import (
    CreateStrategyRequest,
    ParseRequest,
    ParseResponse,
    UpdateStrategyRequest,
    UserStrategyResponse,
)

router = APIRouter(prefix="/strategies", tags=["strategies"], dependencies=[Depends(require_service_token)])


@router.post("/parse", response_model=ParseResponse)
async def parse(body: ParseRequest) -> ParseResponse:
    """Preview step: parse free text into structured rules WITHOUT saving.
    services/api shows this to the user for confirmation before POST /strategies."""
    parsed, warnings = parse_strategy_text(body.text)
    return ParseResponse(parsed=parsed, warnings=warnings)


@router.post("", response_model=UserStrategyResponse, status_code=status.HTTP_201_CREATED)
async def create(body: CreateStrategyRequest, user_id: str = Query(..., alias="userId")) -> UserStrategyResponse:
    row = await store.create_strategy(user_id, body.name, body.rules, body.rawInput, body.inputType)
    return UserStrategyResponse(**row)


@router.get("", response_model=list[UserStrategyResponse])
async def list_for_user(user_id: str = Query(..., alias="userId")) -> list[UserStrategyResponse]:
    rows = await store.list_strategies(user_id)
    return [UserStrategyResponse(**row) for row in rows]


@router.get("/{strategy_id}", response_model=UserStrategyResponse)
async def get_one(strategy_id: str, user_id: str = Query(..., alias="userId")) -> UserStrategyResponse:
    row = await store.get_strategy(user_id, strategy_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return UserStrategyResponse(**row)


@router.patch("/{strategy_id}", response_model=UserStrategyResponse)
async def update(
    strategy_id: str, body: UpdateStrategyRequest, user_id: str = Query(..., alias="userId")
) -> UserStrategyResponse:
    row = await store.update_strategy(user_id, strategy_id, body.name, body.status, body.rules)
    if row is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return UserStrategyResponse(**row)


@router.delete("/{strategy_id}", response_model=UserStrategyResponse)
async def archive(strategy_id: str, user_id: str = Query(..., alias="userId")) -> UserStrategyResponse:
    """Soft delete — sets status='archived'. Sentinel never hard-deletes a
    user's strategy history."""
    row = await store.archive_strategy(user_id, strategy_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return UserStrategyResponse(**row)


@router.get("/{strategy_id}/performance")
async def performance(strategy_id: str, user_id: str = Query(..., alias="userId")) -> dict:
    """How the user's OWN strategy has behaved. Describes what happened; it
    never ranks strategies, nominates one, or proposes a trade."""
    strategy = await store.get_strategy(user_id, strategy_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")

    watches = await watch_store.list_watches_for_strategy(user_id, strategy_id)
    observations = {w["id"]: await watch_store.list_observations(w["id"], 500) for w in watches}
    return compute_performance(strategy_id, watches, observations).to_dict()
