"""asyncpg CRUD for WatchSession + WatchObservation.

Shares the pool created in app/strategy/store.py — one service, one pool.
"""

import json
import uuid
from datetime import datetime, timezone

from app.strategy.store import _aware, _naive, _now, _pool_or_raise
from app.core.timefmt import iso_utc


def _leg_of(row, prefix: str, option_type: str) -> dict | None:
    """One leg of the pair, or None when the watch does not carry it.

    Keyed off `securityId` rather than off the strike: a row with a strike and
    no token is not an addressable leg, and returning it as one would put the
    caller back to re-deriving the contract from the number — the exact thing
    the token columns exist to stop.
    """
    security_id = row[f"{prefix}SecurityId"]
    strike = row[f"{prefix}Strike"]
    if not security_id or strike is None:
        return None
    return {
        "strike": float(strike),
        "optionType": option_type,
        "securityId": security_id,
        "exchangeSegment": row[f"{prefix}ExchangeSegment"] or "",
        "tradingSymbol": row[f"{prefix}TradingSymbol"] or "",
        "dhanInstrument": row[f"{prefix}DhanInstrument"] or "",
        "lotSize": int(row[f"{prefix}LotSize"]) if row[f"{prefix}LotSize"] is not None else None,
        "tickSize": float(row[f"{prefix}TickSize"]) if row[f"{prefix}TickSize"] is not None else None,
    }


def _legs_of(watch: dict) -> tuple[dict | None, dict | None, str | None]:
    """The pair a watch names, however it was recorded.

    THE ONE PLACE on this side that knows a pre-2026-08-18 row carries a single
    leg in `strike`/`optionType` instead of `ce`/`pe`. The poller and the
    contract builder read legs through here, so the legacy shape stays a
    migration shim rather than a second live single-strike path.

    A reconstructed legacy leg has an EMPTY securityId — the row never held one,
    and inventing a token would make it indistinguishable from a resolved leg.
    """
    if watch.get("ce") or watch.get("pe"):
        return watch.get("ce"), watch.get("pe"), watch.get("focusedSide")

    strike, option_type = watch.get("strike"), watch.get("optionType")
    if strike is None or option_type is None:
        return None, None, None
    try:
        leg = {
            "strike": float(strike),
            "optionType": option_type,
            "securityId": "",
            "exchangeSegment": "",
            "tradingSymbol": "",
            "dhanInstrument": "",
            "lotSize": None,
            "tickSize": None,
        }
    except (TypeError, ValueError):
        return None, None, None
    return (leg if option_type == "CE" else None, leg if option_type == "PE" else None, option_type)


def _watch_to_dict(row) -> dict:
    ce = _leg_of(row, "ce", "CE")
    pe = _leg_of(row, "pe", "PE")
    return {
        "id": row["id"],
        "userId": row["userId"],
        "strategyId": row["strategyId"],
        "symbol": row["symbol"],
        # LEGACY MIRROR — see the WatchSession comment in schema.prisma. Kept
        # populated from the focused leg so pre-2026-08-18 rows and new ones
        # read the same way. Consumers go through `_legs_of`, never these.
        "strike": row["strike"],
        "optionType": row["optionType"],
        "expiry": row["expiry"],
        # THE PAIR. Both legs, each with its own instrument identity.
        "ce": ce,
        "pe": pe,
        "focusedSide": row["focusedSide"],
        "watchMode": row["watchMode"],
        "timeframe": row["timeframe"],
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
    expiry: str | None,
    ce: dict | None,
    pe: dict | None,
    focused_side: str,
    watch_mode: str,
    timeframe: str | None,
) -> dict:
    """Persist a watch on an option PAIR (or on the underlying).

    Both legs are written with their full instrument identity. The legacy
    `strike`/`optionType` columns are written too, mirrored from the FOCUSED
    leg — not as a second source of truth, but so a row created today is still
    legible to the pre-pair readers and to the history beside it. `_legs_of`
    prefers `ce`/`pe` whenever they exist, so the mirror is never read back on
    a row that has the real thing.
    """
    pool = _pool_or_raise()
    now = _now()
    focused = ce if focused_side == "CE" else pe

    def field(leg: dict | None, key: str):
        return leg.get(key) if leg else None

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO "WatchSession"
                ("id", "userId", "strategyId", "symbol", "strike", "optionType", "expiry",
                 "ceStrike", "ceSecurityId", "ceExchangeSegment", "ceDhanInstrument",
                 "ceTradingSymbol", "ceLotSize", "ceTickSize",
                 "peStrike", "peSecurityId", "peExchangeSegment", "peDhanInstrument",
                 "peTradingSymbol", "peLotSize", "peTickSize",
                 "focusedSide", "watchMode", "timeframe",
                 "state", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $18, $19, $20, $21,
                    $22, $23, $24,
                    'IDLE', $25, $25)
            RETURNING *
            """,
            str(uuid.uuid4()),
            user_id,
            strategy_id,
            symbol,
            None if focused is None else str(focused["strike"]),
            None if focused is None else focused["optionType"],
            expiry,
            field(ce, "strike"),
            field(ce, "securityId"),
            field(ce, "exchangeSegment"),
            field(ce, "dhanInstrument"),
            field(ce, "tradingSymbol"),
            field(ce, "lotSize"),
            field(ce, "tickSize"),
            field(pe, "strike"),
            field(pe, "securityId"),
            field(pe, "exchangeSegment"),
            field(pe, "dhanInstrument"),
            field(pe, "tradingSymbol"),
            field(pe, "lotSize"),
            field(pe, "tickSize"),
            focused_side if watch_mode == "option" else None,
            watch_mode,
            timeframe,
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
