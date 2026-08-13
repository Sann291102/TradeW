"""asyncpg CRUD against the UserStrategy table.

The table is migrated by Prisma (packages/database/prisma/migrations/
20260813000000_user_strategy) but owned by this service — sentinel-py talks
to Postgres directly rather than through the TS Prisma client. Column names
here must stay in sync with that migration.
"""

import json
import os
import uuid
from datetime import datetime, timezone

import asyncpg

from app.strategy.schemas import ParsedStrategy

_pool: asyncpg.Pool | None = None


async def init_pool() -> None:
    global _pool
    if _pool is not None:
        return
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not set")
    _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _pool_or_raise() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Strategy store pool not initialized — call init_pool() at startup")
    return _pool


def _row_to_dict(row: asyncpg.Record) -> dict:
    return {
        "id": row["id"],
        "userId": row["userId"],
        "name": row["name"],
        "rules": json.loads(row["rules"]) if isinstance(row["rules"], str) else row["rules"],
        "rawInput": row["rawInput"],
        "inputType": row["inputType"],
        "status": row["status"],
        "createdAt": row["createdAt"].isoformat(),
        "updatedAt": row["updatedAt"].isoformat(),
    }


async def create_strategy(
    user_id: str, name: str, rules: ParsedStrategy, raw_input: str | None, input_type: str
) -> dict:
    pool = _pool_or_raise()
    new_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO "UserStrategy" ("id", "userId", "name", "rules", "rawInput", "inputType", "status", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
            RETURNING *
            """,
            new_id,
            user_id,
            name,
            rules.model_dump_json(),
            raw_input,
            input_type,
            now,
        )
    return _row_to_dict(row)


async def list_strategies(user_id: str) -> list[dict]:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT * FROM "UserStrategy" WHERE "userId" = $1 ORDER BY "createdAt" DESC',
            user_id,
        )
    return [_row_to_dict(row) for row in rows]


async def get_strategy(user_id: str, strategy_id: str) -> dict | None:
    pool = _pool_or_raise()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT * FROM "UserStrategy" WHERE "userId" = $1 AND "id" = $2',
            user_id,
            strategy_id,
        )
    return _row_to_dict(row) if row else None


async def update_strategy(
    user_id: str,
    strategy_id: str,
    name: str | None,
    status: str | None,
    rules: ParsedStrategy | None,
) -> dict | None:
    pool = _pool_or_raise()
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE "UserStrategy"
            SET "name" = COALESCE($3, "name"),
                "status" = COALESCE($4, "status"),
                "rules" = COALESCE($5, "rules"),
                "updatedAt" = $6
            WHERE "userId" = $1 AND "id" = $2
            RETURNING *
            """,
            user_id,
            strategy_id,
            name,
            status,
            rules.model_dump_json() if rules is not None else None,
            now,
        )
    return _row_to_dict(row) if row else None


async def archive_strategy(user_id: str, strategy_id: str) -> dict | None:
    return await update_strategy(user_id, strategy_id, name=None, status="archived", rules=None)
