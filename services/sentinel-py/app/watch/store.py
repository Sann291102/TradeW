"""asyncpg CRUD for WatchSession + WatchObservation.

Shares the pool created in app/strategy/store.py — one service, one pool.
"""

import json
import uuid
from datetime import datetime, timezone

from app.strategy.store import _pool_or_raise


def _watch_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "userId": row["userId"],
        "strategyId": row["strategyId"],
        "symbol": row["symbol"],
        "strike": row["strike"],
        "optionType": row["optionType"],
        "expiry": row["expiry"],
        "state": row["state"],
        "lastNotifiedAt": row["lastNotifiedAt"],
        "cooldownUntil": row["cooldownUntil"],
        "createdAt": row["createdAt"].isoformat(),
        "updatedAt": row["updatedAt"].isoformat(),
    }


async def create_watch(
    user_id: str,
    strategy_id: str,
    symbol: str,
    strike: str | None,
    option_type: str | None,
    expiry: str | None,
) -> dict:
    pool = _pool_or_raise()
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO "WatchSession"
                ("id", "userId", "strategyId", "symbol", "strike", "optionType", "expiry", "state", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'IDLE', $8, $8)
            RETURNING *
            """,
            str(uuid.uuid4()),
            user_id,
            strategy_id,
            symbol,
            strike,
            option_type,
            expiry,
            now,
        )
    return _watch_to_dict(row)


async def list_watches(user_id: str) -> list[dict]:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT * FROM "WatchSession" WHERE "userId" = $1 ORDER BY "createdAt" DESC',
            user_id,
        )
    return [_watch_to_dict(r) for r in rows]


async def list_active_watches() -> list[dict]:
    """What the sweep loop polls. EXITED watches are done; a paused strategy
    is filtered by the join so pausing a strategy stops its watches too."""
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT w.*, s."rules" AS "strategyRules", s."name" AS "strategyName"
            FROM "WatchSession" w
            JOIN "UserStrategy" s ON s."id" = w."strategyId"
            WHERE w."state" <> 'EXITED' AND s."status" = 'active'
            """
        )
    result = []
    for row in rows:
        watch = _watch_to_dict(row)
        rules = row["strategyRules"]
        watch["strategyRules"] = json.loads(rules) if isinstance(rules, str) else rules
        watch["strategyName"] = row["strategyName"]
        result.append(watch)
    return result


async def update_watch_state(
    watch_id: str,
    state: str,
    last_notified_at: datetime | None,
    cooldown_until: datetime | None,
) -> None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE "WatchSession"
            SET "state" = $2, "lastNotifiedAt" = $3, "cooldownUntil" = $4, "updatedAt" = $5
            WHERE "id" = $1
            """,
            watch_id,
            state,
            last_notified_at,
            cooldown_until,
            datetime.now(timezone.utc),
        )


async def record_observation(
    watch_session_id: str,
    agent: str,
    candle_time: datetime | None,
    rule_evaluations: list[dict],
    state: str,
    metadata: dict | None = None,
) -> None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO "WatchObservation"
                ("id", "watchSessionId", "agent", "candleTime", "ruleEvaluations", "state", "metadata", "createdAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            str(uuid.uuid4()),
            watch_session_id,
            agent,
            candle_time,
            json.dumps(rule_evaluations),
            state,
            json.dumps(metadata) if metadata is not None else None,
            datetime.now(timezone.utc),
        )


async def list_observations(watch_session_id: str, limit: int = 50) -> list[dict]:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM "WatchObservation"
            WHERE "watchSessionId" = $1 ORDER BY "createdAt" DESC LIMIT $2
            """,
            watch_session_id,
            limit,
        )
    return [
        {
            "id": r["id"],
            "watchSessionId": r["watchSessionId"],
            "agent": r["agent"],
            "candleTime": r["candleTime"].isoformat() if r["candleTime"] else None,
            "ruleEvaluations": json.loads(r["ruleEvaluations"])
            if isinstance(r["ruleEvaluations"], str)
            else r["ruleEvaluations"],
            "state": r["state"],
            "createdAt": r["createdAt"].isoformat(),
        }
        for r in rows
    ]
