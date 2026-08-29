"""The sweep loop — polls active watches, evaluates rules, advances state.

Runs as an asyncio task inside the FastAPI process (Option A) and is gated
on a `JobLease` (app/core/lease.py), so only one instance sweeps even when
several are running. It still dies with its process — the lease means the
next instance picks the work up rather than two instances duplicating it.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

from app.core.lease import JobLease
from app.market.clock import is_market_open, non_trading_reason, session_key
from app.market.feed import MarketDataUnavailableError, fetch_index_candles, fetch_option_candles
from app.intrade.monitor import Direction, evaluate_position
from app.notify.dispatcher import notify, notify_intrade
from app.watch import store
from app.watch.direction import market_context
from app.watch.evaluator import evaluate, measure_flag, measure_zone, measure_liquidity, measure_flip, measure_pullback, measure_vwap
from app.watch.state_machine import Transition, WatchState, advance

logger = logging.getLogger("sentinel.watch")

SWEEP_JOB_NAME = "sentinel-py-watch-sweep"

_task: asyncio.Task | None = None
_lease: JobLease | None = None


def _interval_seconds() -> int:
    return int(os.environ.get("SENTINEL_PY_SWEEP_SECONDS", "15"))


def _timeframe_of(rules: dict) -> str:
    return rules.get("timeframe") or "15m"


async def _leg_candles(watch: dict, leg: dict, timeframe: str):
    """One leg's real OHLC, addressed by the securityId stored on the watch.

    The token is passed to the bridge, which VERIFIES it against its own
    scrip-master resolution and fails the request on a mismatch rather than
    serving a different contract's bars. A legacy row has no token; it is
    omitted and the bridge resolves by (symbol, expiry, strike, type) exactly
    as before.
    """
    return await fetch_option_candles(
        symbol=watch["symbol"],
        expiry=watch["expiry"],
        strike=float(leg["strike"]),
        option_type=leg["optionType"],
        interval=timeframe,
        security_id=leg.get("securityId") or None,
    )


async def _candles_for(watch: dict, timeframe: str):
    """The series the strategy's RULES are evaluated against.

    An option watch evaluates on its FOCUSED leg; a watch with no legs reads
    the index. Watching the index while claiming to watch a 24300 CE would
    misreport every level, so the two are never interchangeable.

    ⚠️ This is one of THREE reads. `_read_index` reads the underlying — the
    market instrument, and the only series the directional context is taken
    from — and `_read_pair` reads both legs, because Sentinel's job is to
    compare the two candidate expressions of the underlying's move. This
    function chooses only which series the user's rule set is evaluated on; it
    does not decide, and has never decided, which way the market is going.
    """
    ce, pe, focused_side = store._legs_of(watch)
    focused = ce if focused_side == "CE" else pe if focused_side == "PE" else (ce or pe)
    if focused is not None and watch.get("expiry"):
        return await _leg_candles(watch, focused, timeframe)
    return await fetch_index_candles(symbol=watch["symbol"], interval=timeframe)


async def _read_index(watch: dict, timeframe: str, evaluation_candles):
    """The INDEX series — the market instrument of every watch, option or not.

    ── WHAT THIS CLOSED ───────────────────────────────────────────────────────

    Before 2026-08-29 `fetch_index_candles` was reached ONLY by a watch with no
    legs. An option watch read its focused leg and its pair and never once
    looked at the underlying, so "watching NIFTY 24200 CE" watched two option
    contracts and an index that existed on screen and nowhere else. Every
    directional sense the engine had came out of a premium series, which is the
    one series that cannot answer which way the market is going (see
    `app/watch/direction.py`).

    An UNDERLYING watch already evaluates on the index, so its candles are
    handed in and reused: this must not double the bridge call for the watches
    that were reading the index correctly all along.

    Failures are swallowed and NAMED. The index is context, and a bridge that
    cannot serve the index must not stop a sweep whose option legs read fine —
    the same rule `_read_pair` follows for a dead leg.
    """
    ce, pe, focused_side = store._legs_of(watch)
    focused = ce if focused_side == "CE" else pe if focused_side == "PE" else (ce or pe)
    # Mirrors `_candles_for`'s own index branch, condition for condition. When
    # that function fell back to the index — no legs, or legs with no expiry to
    # address them by — the evaluation series ALREADY is the index, and fetching
    # it a second time would double the bridge call for exactly the watches that
    # were reading it correctly all along.
    if focused is None or not watch.get("expiry"):
        return evaluation_candles, None
    try:
        return await fetch_index_candles(symbol=watch["symbol"], interval=timeframe), None
    except MarketDataUnavailableError as exc:
        return None, str(exc)
    except Exception as exc:  # noqa: BLE001 - context must never fail a sweep
        logger.warning("watch=%s index read failed: %s", watch["id"], exc)
        return None, str(exc)


def _leg_summary(leg: dict | None, candles, error: str | None) -> dict | None:
    """What one leg looked like on this sweep, for the observation record.

    A leg that could not be read carries its reason and a null series — never
    a zero and never the previous sweep's numbers. "Unreadable" and "did not
    move" are different facts, and collapsing them renders a dead bridge as a
    calm market (the same distinction `contract-alignment.ts` enforces on the
    TypeScript side).
    """
    if leg is None:
        return None
    summary = {
        "strike": leg["strike"],
        "optionType": leg["optionType"],
        # Recorded so an observation can be audited against the exact contract
        # it was made on, after the fact and without re-resolving anything.
        "securityId": leg.get("securityId") or None,
        "tradingSymbol": leg.get("tradingSymbol") or None,
    }
    if error is not None or not candles:
        summary["unreadable"] = error or "no candles"
        summary["close"] = None
        return summary
    summary["close"] = candles[-1].close
    summary["candleTime"] = candles[-1].timestamp.isoformat()
    summary["bars"] = len(candles)
    return summary


async def _read_pair(watch: dict, timeframe: str) -> dict | None:
    """Both legs of the pair, read for context rather than for evaluation.

    Returns None for a watch with no legs. A failure on EITHER leg is recorded
    and swallowed: this is the context Sentinel compares, not the series the
    rules run on, and an illiquid put with no bars must not stop a sweep whose
    call leg read fine.

    Cost: one extra bridge call per option watch per sweep. The bridge caches
    candles per (securityId, interval, days) for 60s, so at the 15s sweep
    cadence this is one additional UPSTREAM call per minute per watch — the
    price of being able to compare the legs at all, paid once per contract
    rather than once per sweep.
    """
    ce, pe, _ = store._legs_of(watch)
    if ce is None and pe is None:
        return None
    if not watch.get("expiry"):
        return None

    async def read(leg: dict | None):
        if leg is None:
            return None, None
        try:
            return await _leg_candles(watch, leg, timeframe), None
        except MarketDataUnavailableError as exc:
            return None, str(exc)
        except Exception as exc:  # noqa: BLE001 - context must never fail a sweep
            logger.warning("watch=%s pair leg read failed: %s", watch["id"], exc)
            return None, str(exc)

    ce_candles, ce_error = await read(ce)
    pe_candles, pe_error = await read(pe)
    return {
        "ce": _leg_summary(ce, ce_candles, ce_error),
        "pe": _leg_summary(pe, pe_candles, pe_error),
        # Stated, not implied: which leg the rules were evaluated on. Without
        # it a reader cannot tell whether a met condition came from the call or
        # the put.
        "focusedSide": watch.get("focusedSide"),
        "timeframe": timeframe,
    }


async def _emit(watch: dict, transition: Transition) -> None:
    """Dispatch to services/api, which writes the Notification row the web
    app's existing 30s poll already picks up."""
    strategy_name = watch.get("strategyName") or "your strategy"
    delivered = await notify(
        watch=watch,
        transition=transition,
        strategy_name=strategy_name,
        trading_day=session_key(datetime.now(timezone.utc)),
    )
    logger.info(
        "notify[%s] watch=%s symbol=%s state=%s->%s delivered=%s reason=%s",
        transition.tier.value if transition.tier else "none",
        watch["id"],
        watch["symbol"],
        transition.previous.value,
        transition.current.value,
        delivered,
        transition.reason,
    )


async def _monitor_position(watch: dict, candles) -> None:
    """One in-trade check. Requires the user's declared entry, invalidation
    level and direction — without them there is no scale to measure against,
    so the watch is left alone rather than guessed at."""
    entry, stop, direction = watch.get("entryPrice"), watch.get("stopPrice"), watch.get("direction")
    if entry is None or stop is None or direction is None:
        logger.warning("watch=%s is IN_TRADE without entry/invalidation/direction — skipping", watch["id"])
        return

    result = evaluate_position(
        candles=candles,
        entry=entry,
        stop=stop,
        direction=Direction(direction),
        target=watch.get("targetPrice"),
        already_reached=watch.get("reachedMilestones") or [],
    )

    strategy_name = watch.get("strategyName") or "your strategy"
    trading_day = session_key(datetime.now(timezone.utc))

    for finding in result.findings:
        # Milestones dedupe on the milestone itself so 2R is announced once
        # ever; the level-reached events dedupe per trading day like the
        # pre-entry tiers do.
        suffix = f"milestone:{finding.milestone}" if finding.milestone else finding.event.value
        await notify_intrade(
            watch=watch,
            event=finding.event.value,
            detail=finding.detail,
            strategy_name=strategy_name,
            trading_day=trading_day,
            r_multiple=result.r_multiple,
            dedupe_suffix=suffix,
            milestone=finding.milestone,
        )

    if result.newly_reached:
        merged = sorted(set((watch.get("reachedMilestones") or []) + result.newly_reached))
        await store.record_milestones(watch["id"], merged)

    if result.closes_position:
        await store.mark_exited(watch["id"])

    await store.record_observation(
        watch_session_id=watch["id"],
        agent="intrade-monitor",
        candle_time=candles[-1].timestamp if candles else None,
        rule_evaluations=[
            {"event": f.event.value, "detail": f.detail, "milestone": f.milestone} for f in result.findings
        ],
        state=WatchState.EXITED.value if result.closes_position else WatchState.IN_TRADE.value,
        metadata={"rMultiple": result.r_multiple, "newlyReached": result.newly_reached},
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
            # THE INDEX — the market instrument. Read on every watch, not only
            # on the legless ones, because the directional context comes from
            # here and from nowhere else (app/watch/direction.py). Read AFTER
            # the evaluation series so a dead index cannot pre-empt the skip the
            # focused leg would otherwise raise — the skip is the more precise
            # statement.
            index_candles, index_error = await _read_index(watch, timeframe, candles)
            market = market_context(
                symbol=watch["symbol"],
                candles=index_candles,
                unreadable=index_error,
                timeframe=timeframe,
                focused_side=watch.get("focusedSide"),
            )
            # Both legs, for the record.
            pair = await _read_pair(watch, timeframe)

            # A position that is open is no longer a setup being watched for:
            # the rules that got the user in are spent, and what matters now
            # is movement relative to the numbers they declared.
            if watch["state"] == WatchState.IN_TRADE.value:
                await _monitor_position(watch, candles)
                evaluated += 1
                continue

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
                    # Normalised so the performance engine can eventually
                    # compare shallow/normal/deep across symbols. None for
                    # strategies where a pullback is not a concept.
                    "pullback": measure_pullback(candles),
                    # Test ordinal and ATR-normalised deviation, so the funnel
                    # can later split 1st/2nd/repeated tests and deviation
                    # buckets out of THIS user's history. None when the
                    # instrument reports no volume — there is no VWAP then.
                    "vwap": measure_vwap(candles),
                    # Level age and touch count, so the funnel can later ask whether
                    # THIS user's flips work better on older, more-tested levels.
                    "flip": measure_flip(candles),
                    "flag": measure_flag(candles),
                    # Carries the STABLE zone id, so touches accumulate across
                    # sweeps instead of resetting every fifteen seconds.
                    "zone": measure_zone(candles),
                    # Records the STAGE the sequence reached, so the funnel can
                    # see where this user's sweeps stopped progressing rather
                    # than only that they did.
                    "liquidity": measure_liquidity(candles),
                    # THE PAIR under observation: both legs, each with the
                    # contract it was read on. This is what lets a later
                    # analysis ask which side was actually expressing the
                    # underlying's move — the question a single-leg watch
                    # could not be asked at all.
                    #
                    # ⚠️ Recorded, not ranked. Nothing here scores the legs
                    # against each other or names a preferred side; that
                    # judgement belongs to the agents evaluating live structure,
                    # momentum, volatility, premium behaviour and liquidity, and
                    # a stored ranking would be a recommendation by another name
                    # (Rule 2).
                    #
                    # `marketContext.alignedSide` below is not that. Preferred
                    # and ALIGNED are different claims: one says a leg is the
                    # better trade, the other says its direction agrees with the
                    # index's. Only the second is arithmetic, and only the
                    # second is made.
                    "optionPair": pair,
                    # THE DIRECTIONAL CONTEXT, and the instrument it came from.
                    #
                    # `basis: "index"` is the load-bearing field. It states that
                    # the direction was read from the UNDERLYING rather than
                    # from whichever premium series `_candles_for` happened to
                    # evaluate — the ambiguity that made every pre-2026-08-29
                    # observation unable to say which way the market was going.
                    #
                    # `alignedSide` is which leg the index's move points at
                    # (rising → CE, falling → PE, flat → neither). It is a
                    # description of the tape, not a ranking of the two
                    # contracts and not a preference between strikes: nothing
                    # here reads premium, liquidity or volatility, and none of
                    # it reaches a notification, where `compliance.py` rejects a
                    # `side`/`bias` key outright (Rule 2).
                    "marketContext": market,
                },
            )

            if transition.should_notify:
                await _emit(watch, transition)
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


async def _loop(lease: JobLease) -> None:
    interval = _interval_seconds()
    logger.info("watch sweep loop started (every %ss)", interval)
    while True:
        try:
            # Singleton: only the lease holder sweeps. Without this, two
            # replicas would evaluate every watch twice and notify twice.
            if not await lease.acquire_or_renew():
                logger.debug("not the sweep leader — standing by")
            elif is_market_open(now := datetime.now(timezone.utc)):
                await sweep_once()
            else:
                # Naming the reason costs one call and answers the question an
                # operator actually asks ("why is nothing being observed?").
                # `is_market_open` is calendar-aware since 2026-08-16, so this
                # branch is now also the weekend/holiday branch.
                reason = non_trading_reason(now) or "outside session hours"
                logger.debug("market closed (%s) — skipping sweep", reason)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("sweep loop iteration failed")
        await asyncio.sleep(interval)


def start() -> None:
    global _task, _lease
    if os.environ.get("SENTINEL_PY_SWEEP_ENABLED", "true").lower() in ("0", "false", "no"):
        logger.info("watch sweep loop disabled by SENTINEL_PY_SWEEP_ENABLED")
        return
    if _task is None or _task.done():
        _lease = JobLease(SWEEP_JOB_NAME)
        _task = asyncio.create_task(_loop(_lease))


async def stop() -> None:
    global _task, _lease
    if _task is not None and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    _task = None
    if _lease is not None:
        # Hand the lease over immediately on a clean shutdown rather than
        # making the next instance wait out the full TTL.
        await _lease.release()
        _lease = None
