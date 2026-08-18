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


_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _expiry_tag(iso: str | None) -> str:
    """`2026-08-18` becomes `18 AUG`, matching `expiryTag()` in apps/web.

    Formatted by hand rather than with strftime: `%b` is locale-dependent, and
    a service running under a non-English locale would emit a month name the
    web app never produces, silently breaking the "same thing in the same
    words" guarantee this module and `watchModel.instrumentLabel` share.
    """
    if not iso or len(iso) != 10 or iso[4] != "-" or iso[7] != "-":
        return ""
    try:
        month = int(iso[5:7])
        day = iso[8:10]
    except ValueError:
        return ""
    if not 1 <= month <= 12:
        return ""
    return f"{day} {_MONTHS[month - 1]}"


def _legs_of(watch: dict):
    # Imported lazily: app.watch.store imports the strategy store's pool, and a
    # module-level import here would make the notify module depend on it at
    # import time for one helper.
    from app.watch.store import _legs_of as legs_of

    return legs_of(watch)


def instrument_label(watch: dict) -> str:
    """Names the user's OWN declared watch so they can tell which of several
    fired. This is identification, not a direction Sentinel derived: the user
    chose this strike and option type when they registered the watch. The
    invariant the TS event contract protects (Gotchas/2026-08-11 — a CE
    direction fabricated onto signals that carried none) is about Sentinel
    RECOVERING a side from data that had none, which is not what this is."""
    ce, pe, _ = _legs_of(watch)
    if ce is None and pe is None:
        return watch["symbol"]
    # The expiry is part of the name. "NIFTY 24200 CE" is two different
    # contracts with two different premiums across two series, and an alert that
    # cannot be told apart from last week's is not an identification. The web
    # side added this to its feed labels first; both were widened to the pair
    # together, so they still produce the same string.
    tag = _expiry_tag(watch.get("expiry"))
    # BOTH legs, since 2026-08-18. A watch names an option PAIR, and an alert
    # that printed only the focused leg would tell the user their strategy fired
    # on "NIFTY 24200 CE" while the watch they created — and the workspace they
    # are about to open — is a pair. `watchPairLabel` in apps/web renders the
    # same string, so the notification and the panel keep agreeing.
    legs = " / ".join(
        f"{int(leg['strike']) if float(leg['strike']).is_integer() else leg['strike']} {leg['optionType']}"
        for leg in (ce, pe)
        if leg is not None
    )
    return " ".join(part for part in (watch["symbol"], tag, legs) if part)


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
        # LEGACY MIRROR of the focused leg, kept so existing notification rows
        # and their readers stay coherent.
        "strike": watch.get("strike"),
        "optionType": watch.get("optionType"),
        "ce": watch.get("ce"),
        "pe": watch.get("pe"),
        "focusedSide": watch.get("focusedSide"),
        # The pair the alert is actually about.
        "ce": watch.get("ce"),
        "pe": watch.get("pe"),
        "focusedSide": watch.get("focusedSide"),
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


# ---------------------------------------------------------------------------
# In-trade notifications (P4)
#
# Every string below is fixed, not composed from user input, and every one is
# run through assert_compliant before it leaves. The wording deliberately
# avoids "stop"/"target"/"book profits" even though the underlying numbers
# are the user's own: ARCH-4 binds the surface, not just the intent, and the
# TS vocabulary layer rewrites exactly these words for exactly this reason.
#
# None of these carry an instruction. "Consider moving your stop to
# breakeven", which the original plan proposed, is advice about what to do
# with a position — Sentinel reports what happened and stops there.
# ---------------------------------------------------------------------------

INTRADE_TITLES = {
    "milestone": "Position Progress",
    "invalidation_reached": "Invalidation Level Reached",
    "projected_level_reached": "Projected Level Reached",
    "structure_break": "Structure Shifting",
}


def build_intrade_payload(
    watch: dict,
    event: str,
    detail: str,
    strategy_name: str,
    trading_day: str,
    r_multiple: float | None,
    dedupe_suffix: str,
    milestone: str | None = None,
) -> dict:
    label = instrument_label(watch)
    title = INTRADE_TITLES[event]
    body = f'Your position from strategy "{strategy_name}" on {label}: {detail}.'

    metadata = {
        "source": "sentinel-py",
        "watchSessionId": watch["id"],
        "strategyId": watch["strategyId"],
        "symbol": watch["symbol"],
        "strike": watch.get("strike"),
        "optionType": watch.get("optionType"),
        "state": watch["state"],
        "tier": "in_trade",
        "event": event,
        # Which milestone this announces ("1R"/"2R"/"3R"), for MILESTONE events
        # only. The body already says it in words; carrying it as a field lets
        # the notification bell label the alert without parsing prose. Like
        # rMultiple, it describes something that already happened rather than a
        # level to act on.
        "milestone": milestone,
        # Progress as a ratio of the user's own risk. This is a measurement of
        # something that already happened, not a level to act on, which is why
        # it is allowed where entry/stop/target prices are not.
        "rMultiple": round(r_multiple, 2) if r_multiple is not None else None,
        "reason": detail,
        "dedupeKey": f"sentinel-py:{watch['id']}:{dedupe_suffix}",
        "tradingDate": trading_day,
    }

    assert_compliant(title, body, metadata)
    return {"userId": watch["userId"], "category": "sentinel", "title": title, "body": body, "metadata": metadata}


async def notify_intrade(
    watch: dict,
    event: str,
    detail: str,
    strategy_name: str,
    trading_day: str,
    r_multiple: float | None,
    dedupe_suffix: str,
    milestone: str | None = None,
) -> bool:
    try:
        payload = build_intrade_payload(
            watch, event, detail, strategy_name, trading_day, r_multiple, dedupe_suffix, milestone
        )
    except ComplianceError:
        logger.exception("refusing to send a non-compliant in-trade notification for watch=%s", watch["id"])
        return False
    return await dispatch(payload)
