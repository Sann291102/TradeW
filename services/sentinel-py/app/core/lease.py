"""Job lease — port of services/api/src/common/leader-election.ts.

Ported rather than skipped because the sweep loop is a SINGLETON: two
replicas both polling every watch would double-evaluate every strategy and
double-notify every user. That is a production incident that only appears
at the moment you scale, which is the worst time to discover it.

The safety property lives entirely in the WHERE clause: an existing row is
overwritten only when it has expired *according to Postgres's clock*, or
when this process is renewing its own. NOW() rather than a parameter — a
replica with a fast clock must not be able to steal a live lease.

An empty RETURNING set is an unambiguous "someone else holds it", with no
second read and no window between checking and taking.
"""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from app.strategy.store import _pool_or_raise

logger = logging.getLogger("sentinel.lease")

HOLDER_ID = f"{os.getpid()}-{uuid.uuid4()}"


def _ttl_ms() -> float:
    return float(os.environ.get("JOB_LEASE_TTL_MS", "30000"))


class JobLease:
    """Tracks whether this process currently holds `name`."""

    def __init__(self, name: str):
        self.name = name
        self._deadline: datetime | None = None

    def is_leader(self) -> bool:
        return self._deadline is not None and datetime.now(timezone.utc) < self._deadline

    async def acquire_or_renew(self) -> bool:
        held = self.is_leader()
        ttl_seconds = _ttl_ms() / 1000
        try:
            pool = _pool_or_raise()
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    INSERT INTO "JobLease" ("name", "holder", "expiresAt", "renewedAt", "acquiredAt")
                    VALUES ($1, $2, NOW() + ($3::double precision) * INTERVAL '1 second', NOW(), NOW())
                    ON CONFLICT ("name") DO UPDATE
                      SET "holder" = EXCLUDED."holder",
                          "expiresAt" = EXCLUDED."expiresAt",
                          "renewedAt" = NOW(),
                          "acquiredAt" = CASE
                            WHEN "JobLease"."holder" = EXCLUDED."holder" THEN "JobLease"."acquiredAt"
                            ELSE NOW()
                          END
                      WHERE "JobLease"."expiresAt" < NOW() OR "JobLease"."holder" = EXCLUDED."holder"
                    RETURNING "expiresAt"
                    """,
                    self.name,
                    HOLDER_ID,
                    ttl_seconds,
                )
        except Exception as exc:
            # A database blip must not promote this process, and must not demote
            # it either: leave the remembered deadline alone so a brief outage
            # doesn't stop the sweep and a long one stops it safely.
            logger.warning("lease '%s': renewal failed, will expire if this persists — %s", self.name, exc)
            return held

        if row is not None:
            # Trust the LOCAL clock for the deadline we enforce, not Postgres's
            # returned value — comparing a remote timestamp against local time
            # would import clock skew into the safety margin.
            self._deadline = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
            if not held:
                logger.info("acquired lease '%s' (holder %s)", self.name, HOLDER_ID)
            return True

        if held:
            logger.info("lost lease '%s' to another instance", self.name)
        self._deadline = None
        return False

    async def release(self) -> None:
        try:
            pool = _pool_or_raise()
            async with pool.acquire() as conn:
                await conn.execute(
                    'DELETE FROM "JobLease" WHERE "name" = $1 AND "holder" = $2',
                    self.name,
                    HOLDER_ID,
                )
        except Exception as exc:
            logger.warning("lease '%s': release failed — %s", self.name, exc)
        finally:
            self._deadline = None


async def renew_forever(lease: JobLease, interval_seconds: float | None = None) -> None:
    interval = interval_seconds or float(os.environ.get("JOB_LEASE_RENEW_MS", "10000")) / 1000
    while True:
        await lease.acquire_or_renew()
        await asyncio.sleep(interval)
