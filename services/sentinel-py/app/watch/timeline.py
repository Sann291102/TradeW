"""Timeline: the per-watch event stream the workspace feed renders.

Built from `WatchObservation` rows, which the sweep loop already writes on
every pass (including passes that decided NOT to notify). That makes the feed
and the audit trail the same source of truth — "why did I see this?" and "why
did I not see that?" are answerable from one place.

## On "confidence"

There is deliberately no confidence score in this service, and none is
invented here. What the feed thresholds on is `strength`: the real ratio of
mandatory conditions met to mandatory conditions defined, which the evaluator
already computes and the observation already stores. A setup with 1 of 2
conditions met has strength 0.5 — that is a fact about the user's own rules,
not a model's opinion.

In-trade events (a milestone crossed, an invalidation level reached) carry
strength 1.0 because they are not predictions: they either happened or they
are not in the list.
"""

from typing import Any

# Pre-entry states that are never worth surfacing: nothing has been met yet.
_SILENT_STATES = {"IDLE"}


def _pre_entry_event(observation: dict) -> dict | None:
    meta = observation.get("metadata") or {}
    state = observation.get("state") or ""
    if state in _SILENT_STATES:
        return None

    met = meta.get("mandatoryMet")
    total = meta.get("mandatoryTotal")
    strength = (met / total) if isinstance(met, int) and isinstance(total, int) and total else 0.0

    kind = "confirmed" if state == "CONFIRMED" else "wait_and_watch"
    return {
        "kind": kind,
        "state": state,
        "strength": strength,
        "conditionsMet": met,
        "conditionsTotal": total,
        "rMultiple": None,
        "reason": meta.get("reason") or "",
        "notified": bool(meta.get("notified")),
    }


def _met_mandatory(observation: dict) -> dict[str, str]:
    """Mandatory rules currently satisfied, as {ruleId: name}."""
    return {
        rule.get("ruleId") or rule.get("name") or "": rule.get("name") or ""
        for rule in (observation.get("ruleEvaluations") or [])
        if rule.get("mandatory") and rule.get("met")
    }


def _rule_detail(observation: dict, rule_id: str) -> str:
    for rule in observation.get("ruleEvaluations") or []:
        if (rule.get("ruleId") or rule.get("name")) == rule_id:
            return rule.get("detail") or ""
    return ""


def _rejection(newer: dict, older: dict) -> dict | None:
    """A condition the setup had already satisfied is no longer satisfied.

    This is the event that was missing: the feed could say a setup was
    forming and later that it was forming less, but never that it had
    actively given something back. "Reclaim confirmed, then volume fell below
    the threshold and the setup returned to watching" is the sentence a user
    learns from, and it is the sample a performance funnel needs in order to
    measure where setups die.

    Derived by comparing adjacent observations rather than recorded at sweep
    time: the audit trail already stores every rule's met/unmet on every
    pass, so the fact is already there and deriving it here keeps one
    implementation for every consumer.
    """
    lost = {rid: name for rid, name in _met_mandatory(older).items() if rid not in _met_mandatory(newer)}
    if not lost:
        return None

    names = ", ".join(sorted(name for name in lost.values() if name)) or "a condition"
    detail = next((d for d in (_rule_detail(newer, rid) for rid in lost) if d), "")
    meta = newer.get("metadata") or {}
    met, total = meta.get("mandatoryMet"), meta.get("mandatoryTotal")

    return {
        "kind": "rejected",
        "state": newer.get("state") or "",
        # A rejection is something that happened, not a partial setup, so it
        # is never filtered out by the feed's strength threshold.
        "strength": 1.0,
        "conditionsMet": met,
        "conditionsTotal": total,
        "rMultiple": None,
        "reason": f"{names} no longer met{f' — {detail}' if detail else ''}",
        "notified": False,
        "lostConditions": sorted(lost.values()),
    }


# The sweep records in-trade findings under `ruleEvaluations` as
# {event, detail, milestone}; one observation can carry several.
_MILESTONE_KIND = {"1R": "milestone_1R", "2R": "milestone_2R", "3R": "milestone_3R"}


def _in_trade_events(observation: dict) -> list[dict]:
    meta = observation.get("metadata") or {}
    findings = observation.get("ruleEvaluations") or []
    events: list[dict] = []

    for finding in findings:
        event = finding.get("event")
        if not event:
            continue
        kind = event
        if event == "milestone":
            kind = _MILESTONE_KIND.get(finding.get("milestone") or "", "milestone_1R")
        events.append(
            {
                "kind": kind,
                "state": observation.get("state") or "IN_TRADE",
                # Not a prediction — it happened.
                "strength": 1.0,
                "conditionsMet": None,
                "conditionsTotal": None,
                "rMultiple": meta.get("rMultiple"),
                "reason": finding.get("detail") or "",
                "notified": True,
            }
        )
    return events


def _current_conditions(usable_newest_first: list[dict]) -> list[dict]:
    """Each rule the user defined, and whether it is met right now.

    Read from the newest PRE-ENTRY observation. Once a position is open the
    entry rules are spent — they got the user in — so an in-trade sweep
    records findings rather than rule results, and the last pre-entry pass is
    the honest answer to "what did my conditions look like when this
    qualified?".
    """
    for observation in usable_newest_first:
        if observation.get("agent") == "intrade-monitor":
            continue
        rules = observation.get("ruleEvaluations") or []
        if not rules:
            continue
        return [
            {
                "id": rule.get("ruleId") or rule.get("name") or "",
                "name": rule.get("name") or "",
                "mandatory": bool(rule.get("mandatory")),
                "met": bool(rule.get("met")),
                "detail": rule.get("detail") or "",
            }
            for rule in rules
        ]
    return []


def _collapse(events: list[dict]) -> list[dict]:
    """Collapse a run of the same event kind into one entry.

    The sweep re-evaluates every 15 seconds, so a watch sitting in FORMING for
    ten minutes produced ~40 identical "1 of 2 conditions met" cards. That is
    a state the user is in, not forty things that happened, and rendering it
    forty times buries the events that ARE new.

    Each surviving entry keeps the latest reading (`at`, `reason`, `strength`,
    `rMultiple`) and records how long the run has been going: `firstAt` and
    `occurrences`. A UI can render "since 09:41 · 40 checks" instead of a
    wall, and can expand the run if someone wants the detail.

    Only CONSECUTIVE runs collapse. If a watch goes FORMING -> CONFIRMED ->
    back to FORMING, that is two distinct spells and both stay visible.
    """
    collapsed: list[dict] = []
    for event in events:
        previous = collapsed[-1] if collapsed else None
        if previous is not None and previous["kind"] == event["kind"]:
            # `events` is newest-first, so each later item is OLDER: it moves
            # the start of the run backwards and adds to the count.
            previous["firstAt"] = event["at"]
            previous["occurrences"] += 1
            continue
        collapsed.append({**event, "firstAt": event["at"], "occurrences": 1})
    return collapsed


"""Measurements the sweep writes into observation metadata on every pass.

These are the engine's READING of the candles it fetched — pullback depth,
VWAP test ordinal, flip age, flag geometry, zone touches, sweep stage. The
poller has always recorded them (app/watch/poller.py) and nothing has ever
read them back out, so the browser could show which of the user's conditions
were met but never what the engine actually measured to decide that.
"""
_READING_KEYS = ("pullback", "vwap", "flip", "flag", "zone", "liquidity")


def _reading(observations: list[dict], usable: list[dict]) -> dict[str, Any] | None:
    """What the engine last measured, and whether it could read the market at
    all on its most recent pass.

    The two questions are answered from DIFFERENT observations on purpose. The
    measurements come from the newest readable sweep; the "could it read"
    answer comes from the newest sweep of any kind. A bridge that went down
    five minutes ago must not silently keep presenting five-minute-old levels
    as current — the numbers stay (they are still the last thing that was
    true) and `unreadable` says the latest attempt failed.

    Only `watch-engine` passes carry measurements; `intrade-monitor` passes
    measure a position against the user's own levels and record none of this.
    """
    if not observations:
        return None

    newest = observations[0]
    skipped = (newest.get("metadata") or {}).get("skipped")
    unreadable = str((newest.get("metadata") or {}).get("detail") or "") if skipped else None

    measured = next((o for o in usable if o.get("agent") != "intrade-monitor"), None)
    if measured is None:
        # Nothing readable has ever been swept. Still worth returning, because
        # "the engine has not been able to read this chart" is the answer to
        # the only question a user asks in that state.
        return {
            "at": newest.get("createdAt"),
            "candleTime": None,
            "openingRangeHigh": None,
            "openingRangeLow": None,
            "measurements": {},
            "unreadable": unreadable,
        }

    meta = measured.get("metadata") or {}
    return {
        "at": measured.get("createdAt"),
        "candleTime": measured.get("candleTime"),
        "openingRangeHigh": meta.get("openingRangeHigh"),
        "openingRangeLow": meta.get("openingRangeLow"),
        # Only keys the sweep actually produced a value for. A measurement is
        # None when the concept does not apply to this instrument (no volume
        # means no VWAP), and an absent key reads more honestly than a null.
        "measurements": {key: meta[key] for key in _READING_KEYS if meta.get(key) is not None},
        "unreadable": unreadable,
    }


def build_timeline(
    watch: dict, observations: list[dict], strategy_rules: dict | None = None
) -> dict[str, Any]:
    """Newest first. `observations` is expected newest-first already (the
    store orders by createdAt DESC); ordering is asserted here rather than
    assumed so a change to the query cannot silently invert the feed.

    `strategy_rules` is the saved strategy's parsed rules. Only `timeframe` is
    read from it, and it is threaded through so the browser can draw the chart
    on THE SAME series the sweep evaluates — a chart on 1m beside an engine
    reading 15m is two different instruments as far as the user's eyes are
    concerned."""
    events: list[dict] = []

    # A sweep that could not read the market is not an event the user needs,
    # but it IS why they saw nothing — kept out of the feed and left in the
    # audit trail. Filtered first so a skipped pass cannot look like a
    # rejection when compared against its neighbours.
    usable = [o for o in observations if not (o.get("metadata") or {}).get("skipped")]

    for index, observation in enumerate(usable):
        pre_entry = observation.get("agent") != "intrade-monitor"
        derived = (
            _in_trade_events(observation)
            if not pre_entry
            else [e for e in [_pre_entry_event(observation)] if e]
        )

        # `usable` is newest-first, so the NEXT item is the previous sweep.
        if pre_entry and index + 1 < len(usable):
            older = usable[index + 1]
            if older.get("agent") != "intrade-monitor":
                rejection = _rejection(observation, older)
                if rejection:
                    derived.append(rejection)
        for event in derived:
            events.append(
                {
                    "id": observation["id"],
                    "at": observation["createdAt"],
                    "candleTime": observation.get("candleTime"),
                    **event,
                }
            )

    events.sort(key=lambda e: e["at"], reverse=True)
    events = _collapse(events)

    return {
        # The per-condition state as of the most recent readable sweep. This
        # is what the focus panel answers "why is this happening?" with, and
        # it is deliberately NOT repeated into the feed: the feed says what
        # changed, the panel says what the current state is.
        "conditions": _current_conditions(usable),
        "watch": {
            "id": watch["id"],
            "symbol": watch["symbol"],
            "strike": watch.get("strike"),
            "optionType": watch.get("optionType"),
            "expiry": watch.get("expiry"),
            "state": watch["state"],
            "direction": watch.get("direction"),
            "strategyId": watch["strategyId"],
            # The levels the USER declared when they recorded the position.
            # Sentinel proposes none of these (app/intrade/monitor.py) — they
            # are carried so the workspace can show the contract back to the
            # person who wrote it, and they are named for what they mean rather
            # than as order types, exactly as `OpenPositionRequest` does. The
            # column names (`stopPrice`/`targetPrice`) predate the vocabulary
            # rules; the boundary is where they are corrected, so nothing
            # downstream has to know the old names.
            "entryPrice": watch.get("entryPrice"),
            "invalidationPrice": watch.get("stopPrice"),
            "projectedPrice": watch.get("targetPrice"),
            # The timeframe the SWEEP reads. None when the user's strategy
            # named none, in which case the poller's own default (15m) applies
            # — that default lives in app/watch/poller.py and is not duplicated
            # here, so the browser is told "unspecified" rather than a second
            # copy of a number that could drift.
            "timeframe": (strategy_rules or {}).get("timeframe"),
        },
        # What the engine measured off those candles, so "Sentinel is reading
        # this chart" is a claim the user can check rather than take on trust.
        "reading": _reading(observations, usable),
        "events": events,
    }
