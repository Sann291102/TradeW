"""The sweep loop — polls active watches, evaluates rules, advances state.

Runs as an asyncio task inside the FastAPI process (Option A). That is a
deliberate stage-appropriate choice, not a permanent one: it dies with the
process and does no work-stealing, so the moment there is more than one
replica this must become a separate worker with a lease (the `JobLease`
table already in this schema is the existing pattern for that).

P3 replaces `_emit` with the real notification dispatch. Today it logs.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

from app.market.clock import is_market_open
from app.market.feed import MarketDataUnavailableError, fetch_index_candles, fetch_option_candles
from app.watch import store
from app.watch.evaluator import evaluate
from app.watch.state_machine import Transition, WatchState, advance

logger = logging.getLogger("sentinel.watch")

_task: asyncio.Task | None = None


def _interval_seconds() -> int:
    return int(os.environ.get("SENTINEL_PY_SWEEP_SECONDS", "15"))


def _timeframe_of(rules: dict) -> str:
    return rules.get("timeframe") or "15m"


async def _candles_for(watch: dict, timeframe: str):
    """A watch on a strike reads the OPTION's candles; a watch with no strike
    reads the index. Watching the index while claiming to watch a 24300 CE
    would misreport every level, so the two are never interchangeable."""
    if watch.get("strike") and watch.get("optionType") and watch.get("expiry"):
        return await fetch_option_candles(
            symbol=watch["symbol"],
            expiry=watch["expiry"],
            strike=float(watch["strike"]),
            option_type=watch["optionType"],
            interval=timeframe,
        )
    return await fetch_index_candles(symbol=watch["symbol"], interval=timeframe)


def _emit(watch: dict, transition: Transition) -> None:
    """P3 will dispatch this to services/api -> Notification -> WebSocket.
    The wording is already the plan's: never 'buy'/'sell'."""
    label = "Your strategy conditions are met — you may review"
    if transition.current == WatchState.FORMING:
        label = "Your strategy is forming — wait and watch"
    logger.info(
        "notify[%s] watch=%s symbol=%s state=%s->%s reason=%s :: %s",
        transition.tier.value if transition.tier else "none",
        watch["id"],
        watch["symbol"],
        transition.previous.value,
        transition.current.value,
        transition.reason,
        label,
    )


async def sweep_once() -> int:
    """One pass over every active watch. Returns how many were evaluated.
    Never raises: one bad watch must not stop the other watches."""
    watches = await store.list_active_watches()
    evaluated = 0

    for watch in watches:
        try:
            rules_json = watch.get("strategyRules") or {}
            timeframe = _timeframe_of(rules_json)
            candles = await _candles_for(watch, timeframe)
            evaluation = evaluate(rules_json.get("rules", []), candles)

            current = WatchState(watch["state"])
            transition = advance(
                current=current,
                evaluation=evaluation,
                last_notified_at=watch.get("lastNotifiedAt"),
                cooldown_until=watch.get("cooldownUntil"),
            )

            now = datetime.now(timezone.utc)
            await store.update_watch_state(
                watch_id=watch["id"],
                state=transition.current.value,
                last_notified_at=now if transition.should_notify else watch.get("lastNotifiedAt"),
                cooldown_until=transition.cooldown_until,
            )
            await store.record_observation(
                watch_session_id=watch["id"],
                agent="watch-engine",
                candle_time=candles[-1].timestamp if candles else None,
                rule_evaluations=[
                    {
                        "ruleId": r.rule_id,
                        "name": r.name,
                        "condition": r.condition,
                        "mandatory": r.mandatory,
                        "met": r.met,
                        "detail": r.detail,
                    }
                    for r in evaluation.rules
                ],
                state=transition.current.value,
                metadata={
                    "openingRangeHigh": evaluation.opening_range_high,
                    "openingRangeLow": evaluation.opening_range_low,
                    "mandatoryMet": evaluation.mandatory_met,
                    "mandatoryTotal": evaluation.mandatory_total,
                    "notified": transition.should_notify,
                    "reason": transition.reason,
                },
            )

            if transition.should_notify:
                _emit(watch, transition)
            evaluated += 1

        except MarketDataUnavailableError as exc:
            # Expected outside market hours and when the bridge is down. Not
            # an error worth a stack trace, but it IS worth recording: it is
            # the answer to "why didn't Sentinel alert me?".
            logger.warning("watch=%s skipped: %s", watch["id"], exc)
            try:
                await store.record_observation(
                    watch_session_id=watch["id"],
                    agent="watch-engine",
                    candle_time=None,
                    rule_evaluations=[],
                    state=watch["state"],
                    metadata={"skipped": "market_data_unavailable", "detail": str(exc)},
                )
            except Exception:
                logger.exception("watch=%s could not record skip observation", watch["id"])
        except Exception:
            logger.exception("watch=%s sweep failed", watch["id"])

    return evaluated


async def _loop() -> None:
    interval = _interval_seconds()
    logger.info("watch sweep loop started (every %ss)", interval)
    while True:
        try:
            if is_market_open(datetime.now(timezone.utc)):
                await sweep_once()
            else:
                logger.debug("market closed — skipping sweep")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("sweep loop iteration failed")
        await asyncio.sleep(interval)


def start() -> None:
    global _task
    if os.environ.get("SENTINEL_PY_SWEEP_ENABLED", "true").lower() in ("0", "false", "no"):
        logger.info("watch sweep loop disabled by SENTINEL_PY_SWEEP_ENABLED")
        return
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())


async def stop() -> None:
    global _task
    if _task is not None and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    _task = None
