"""Notification dispatch — sentinel-py -> services/api -> Notification row.

Delivery to the browser is the EXISTING channel: apps/web polls
`/notifications` every 30s (NotificationSync.tsx, which notes there is
deliberately no second copy of that polling). Writing the row is therefore
the whole delivery path; no new socket layer is introduced here.

Dispatch never raises into the sweep loop. A watch that was evaluated
correctly must not be rolled back because the API was briefly unreachable —
the observation is already recorded either way.
"""

import logging
import os

import httpx

from app.notify.compliance import ComplianceError, assert_compliant
from app.watch.state_machine import Tier, Transition, WatchState

logger = logging.getLogger("sentinel.notify")

# Titles are fixed strings, not composed prose — see compliance.py.
TIER_TITLES = {
    Tier.WAIT_AND_WATCH: "Wait & Watch",
    Tier.SIDE_IN_FOCUS: "Side in Focus",
}


def _api_url() -> str:
    return (os.environ.get("SENTINEL_PY_API_URL") or "http://localhost:4000").rstrip("/")


def _service_token() -> str:
    return os.environ.get("SENTINEL_PY_SERVICE_TOKEN", "")


def instrument_label(watch: dict) -> str:
    """Names the user's OWN declared watch so they can tell which of several
    fired. This is identification, not a direction Sentinel derived: the user
    chose this strike and option type when they registered the watch. The
    invariant the TS event contract protects (Gotchas/2026-08-11 — a CE
    direction fabricated onto signals that carried none) is about Sentinel
    RECOVERING a side from data that had none, which is not what this is."""
    parts = [watch["symbol"]]
    if watch.get("strike"):
        parts.append(str(watch["strike"]))
    if watch.get("optionType"):
        parts.append(watch["optionType"])
    return " ".join(parts)


def build_payload(watch: dict, transition: Transition, strategy_name: str, trading_day: str) -> dict:
    label = instrument_label(watch)
    title = TIER_TITLES[transition.tier]

    if transition.current == WatchState.CONFIRMED:
        body = (
            f"Your strategy \"{strategy_name}\" on {label} has met all the conditions "
            f"you defined ({transition.reason}). The workspace now holds a read worth reviewing."
        )
    else:
        body = (
            f"Your strategy \"{strategy_name}\" on {label} is forming — {transition.reason}. "
            "Nothing is confirmed yet."
        )

    metadata = {
        "source": "sentinel-py",
        "watchSessionId": watch["id"],
        "strategyId": watch["strategyId"],
        "symbol": watch["symbol"],
        "strike": watch.get("strike"),
        "optionType": watch.get("optionType"),
        "state": transition.current.value,
        "previousState": transition.previous.value,
        "tier": transition.tier.value,
        "reason": transition.reason,
        # Durable dedupe, mirroring SentinelEventDispatcher: one row per
        # watch per state per IST trading day, so a restart or a replica
        # cannot re-notify someone about a state they already read.
        "dedupeKey": f"sentinel-py:{watch['id']}:{transition.current.value}",
        "tradingDate": trading_day,
    }

    assert_compliant(title, body, metadata)
    return {"userId": watch["userId"], "category": "sentinel", "title": title, "body": body, "metadata": metadata}


async def dispatch(payload: dict) -> bool:
    """POST to services/api. Returns whether it was accepted."""
    url = f"{_api_url()}/internal/sentinel-py/notify"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={"content-type": "application/json", "x-service-token": _service_token()},
            )
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("notification dispatch failed for user=%s: %s", payload.get("userId"), exc)
        return False
    return True


async def notify(watch: dict, transition: Transition, strategy_name: str, trading_day: str) -> bool:
    try:
        payload = build_payload(watch, transition, strategy_name, trading_day)
    except ComplianceError:
        # A template that violates the vocabulary rules is a bug in this
        # service, not something to soften and send anyway.
        logger.exception("refusing to send a non-compliant notification for watch=%s", watch["id"])
        return False
    return await dispatch(payload)
