"""asyncpg CRUD for WatchSession + WatchObservation.

Shares the pool created in app/strategy/store.py — one service, one pool.
"""

import json
import uuid
from datetime import datetime, timezone

from app.strategy.store import _aware, _naive, _now, _pool_or_raise
from app.core.timefmt import iso_utc


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
        "entryPrice": float(row["entryPrice"]) if row["entryPrice"] is not None else None,
        "stopPrice": float(row["stopPrice"]) if row["stopPrice"] is not None else None,
        "targetPrice": float(row["targetPrice"]) if row["targetPrice"] is not None else None,
        "direction": row["direction"],
        "reachedMilestones": json.loads(row["reachedMilestones"])
        if isinstance(row["reachedMilestones"], str)
        else (row["reachedMilestones"] or []),
        "lastNotifiedAt": _aware(row["lastNotifiedAt"]),
        "cooldownUntil": _aware(row["cooldownUntil"]),
        # iso_utc, not .isoformat(): these columns are naive UTC and a bare
        # isoformat emits no offset, which a browser then parses as LOCAL.
        "createdAt": iso_utc(row["createdAt"]),
        "updatedAt": iso_utc(row["updatedAt"]),
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
    now = _now()
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
            _naive(last_notified_at),
            _naive(cooldown_until),
            _now(),
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
            _naive(candle_time),
            json.dumps(rule_evaluations),
            state,
            json.dumps(metadata) if metadata is not None else None,
            _now(),
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
            "candleTime": iso_utc(r["candleTime"]),
            "ruleEvaluations": json.loads(r["ruleEvaluations"])
            if isinstance(r["ruleEvaluations"], str)
            else r["ruleEvaluations"],
            "state": r["state"],
            # The timeline builder reads mandatoryMet/mandatoryTotal, rMultiple
            # and the skip marker out of here — omitting it silently produced
            # a feed with every event at strength 0.
            "metadata": json.loads(r["metadata"])
            if isinstance(r["metadata"], str)
            else r["metadata"],
            "createdAt": iso_utc(r["createdAt"]),
        }
        for r in rows
    ]


async def open_position(
    user_id: str,
    watch_id: str,
    entry_price: float,
    stop_price: float,
    target_price: float | None,
    direction: str,
) -> dict | None:
    """The user marks a position taken. Scoped by userId so one user cannot
    open a position on another's watch. Milestones reset to [] so a second
    position on the same watch starts its own history."""
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE "WatchSession"
            SET "state" = 'IN_TRADE',
                "entryPrice" = $3, "stopPrice" = $4, "targetPrice" = $5,
                "direction" = $6, "reachedMilestones" = '[]', "updatedAt" = $7
            WHERE "id" = $2 AND "userId" = $1
            RETURNING *
            """,
            user_id,
            watch_id,
            entry_price,
            stop_price,
            target_price,
            direction,
            _now(),
        )
    return _watch_to_dict(row) if row else None


async def close_position(user_id: str, watch_id: str) -> dict | None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE "WatchSession"
            SET "state" = 'EXITED', "updatedAt" = $3
            WHERE "id" = $2 AND "userId" = $1
            RETURNING *
            """,
            user_id,
            watch_id,
            _now(),
        )
    return _watch_to_dict(row) if row else None


async def record_milestones(watch_id: str, milestones: list[str]) -> None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        await conn.execute(
            'UPDATE "WatchSession" SET "reachedMilestones" = $2, "updatedAt" = $3 WHERE "id" = $1',
            watch_id,
            json.dumps(milestones),
            _now(),
        )


async def mark_exited(watch_id: str) -> None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        await conn.execute(
            'UPDATE "WatchSession" SET "state" = \'EXITED\', "updatedAt" = $2 WHERE "id" = $1',
            watch_id,
            _now(),
        )


async def get_watch(user_id: str, watch_id: str) -> dict | None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT * FROM "WatchSession" WHERE "userId" = $1 AND "id" = $2',
            user_id,
            watch_id,
        )
    return _watch_to_dict(row) if row else None


async def list_watches_for_strategy(user_id: str, strategy_id: str) -> list[dict]:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT * FROM "WatchSession" WHERE "userId" = $1 AND "strategyId" = $2 ORDER BY "createdAt" DESC',
            user_id,
            strategy_id,
        )
    return [_watch_to_dict(r) for r in rows]
