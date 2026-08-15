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


def build_timeline(watch: dict, observations: list[dict]) -> dict[str, Any]:
    """Newest first. `observations` is expected newest-first already (the
    store orders by createdAt DESC); ordering is asserted here rather than
    assumed so a change to the query cannot silently invert the feed."""
    events: list[dict] = []

    for observation in observations:
        meta = observation.get("metadata") or {}
        # A sweep that could not read the market is not an event the user
        # needs, but it IS why they saw nothing — kept out of the feed and
        # left in the audit trail.
        if meta.get("skipped"):
            continue

        derived = (
            _in_trade_events(observation)
            if observation.get("agent") == "intrade-monitor"
            else [e for e in [_pre_entry_event(observation)] if e]
        )
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
        "watch": {
            "id": watch["id"],
            "symbol": watch["symbol"],
            "strike": watch.get("strike"),
            "optionType": watch.get("optionType"),
            "expiry": watch.get("expiry"),
            "state": watch["state"],
            "direction": watch.get("direction"),
            "strategyId": watch["strategyId"],
        },
        "events": events,
    }
