"""The generic strategy contract the UI consumes.

One shape, whatever the evaluator underneath. The web app must not need to
know whether a strategy is EMA, VWAP, S/R, flag, zone or liquidity based —
otherwise P7 becomes ten bespoke dashboards that drift apart, and the
eleventh strategy needs an eleventh screen before it can be shown at all.

So the contract exposes:

    template          what was adopted, and whether it is still available
    configuration     parameters DERIVED from the strategy's own rules
    watches           the operational surface: what is running right now
    currentState      the watch state machine's answer
    conditions        each rule the user defined, met or not
    latestObservation what the last readable sweep saw
    lifecycle         the collapsed feed events
    performance       the funnel and R stats
    availableAnalytics which breakdowns this user's history can support

`configuration` is generated from the rules rather than hardcoded per
strategy, which is what stops a new template from needing a new form.
`availableAnalytics` is derived from observations that exist rather than from
the template, which is what stops the UI rendering an empty chart.
"""

from typing import Any

from app.strategy.performance import compute_performance
from app.strategy.segments import available_dimensions, compute_segments
from app.strategy.templates import get_template
from app.watch.timeline import build_timeline


def _template_id_of(strategy: dict) -> str | None:
    """Templates are adopted with a recorded rawInput. A typed strategy has no
    template, and reporting one would misattribute the user's own work."""
    raw = strategy.get("rawInput") or ""
    prefix = "Adopted template: "
    return raw[len(prefix) :] if raw.startswith(prefix) else None


def _parameters(rules: dict[str, Any]) -> list[dict]:
    """The configuration form, derived from the strategy's actual rules.

    Every parameter carries a type so the UI can render a control without
    knowing what the parameter means. Rule toggles come from the rules
    themselves, so a strategy with six conditions gets six switches and one
    with three gets three — no per-strategy form.
    """
    parameters: list[dict] = [
        {
            "key": "timeframe",
            "label": "Timeframe",
            "type": "choice",
            "value": rules.get("timeframe") or "15m",
            "options": ["1m", "3m", "5m", "15m", "30m", "1h"],
        }
    ]

    levels = rules.get("levels") or []
    if levels:
        parameters.append(
            {
                "key": "levels",
                "label": "Levels watched",
                "type": "readonly",
                "value": ", ".join(str(level) for level in levels),
            }
        )

    for rule in rules.get("rules") or []:
        parameters.append(
            {
                "key": f"rule.{rule.get('id') or rule.get('name')}",
                "label": rule.get("description") or rule.get("name") or "",
                "type": "toggle",
                # Mandatory rules are shown but not switchable: turning one off
                # would leave the user with a strategy that shares its name
                # with the one they adopted and none of its meaning.
                "value": True,
                "locked": bool(rule.get("mandatory")),
                "group": "mandatory" if rule.get("mandatory") else "optional",
            }
        )

    entry = rules.get("entry") or {}
    parameters.append(
        {
            "key": "direction",
            "label": "Direction",
            "type": "readonly",
            # A long-only setup has no short side, and offering one would
            # misrepresent the strategy the user adopted.
            "value": "Long only" if entry.get("short") is None else "Both directions",
        }
    )
    return parameters


def _watch_summary(watch: dict, timeline: dict) -> dict:
    conditions = timeline.get("conditions") or []
    return {
        "id": watch["id"],
        "symbol": watch.get("symbol"),
        # LEGACY MIRROR of the focused leg — see schema.prisma. Kept so the
        # older cards keep rendering; `ce`/`pe` below are what a pair-aware
        # reader uses.
        "strike": watch.get("strike"),
        "optionType": watch.get("optionType"),
        "expiry": watch.get("expiry"),
        # The pair under observation. Both legs travel to the UI so a card can
        # name what is actually being watched rather than half of it.
        "ce": watch.get("ce"),
        "pe": watch.get("pe"),
        "focusedSide": watch.get("focusedSide"),
        "watchMode": watch.get("watchMode"),
        "state": watch.get("state"),
        "status": watch.get("status"),
        # The lifecycle checklist the Active Watches card renders. Deliberately
        # the SAME conditions the focus panel shows, from the same timeline
        # call, so the card and the panel can never disagree.
        "conditions": conditions,
        "met": sum(1 for c in conditions if c.get("met")),
        "total": len(conditions),
    }


def build_contract(
    strategy: dict,
    watches: list[dict],
    observations_by_watch: dict[str, list[dict]],
    focused_watch_id: str | None = None,
) -> dict:
    """Assemble the contract for one strategy.

    `focused_watch_id` selects which watch the focus panel and feed describe.
    Without one the newest watch is used — the UI still gets a complete,
    self-consistent payload rather than empty panels it has to fill with a
    second request.
    """
    rules = strategy.get("rules") or {}
    template_id = _template_id_of(strategy)
    template = get_template(template_id) if template_id else None

    timelines = {
        watch["id"]: build_timeline(watch, observations_by_watch.get(watch["id"], []))
        for watch in watches
    }

    focused = None
    if focused_watch_id:
        focused = next((w for w in watches if w["id"] == focused_watch_id), None)
    if focused is None:
        focused = watches[0] if watches else None

    focus_timeline = timelines.get(focused["id"]) if focused else {}
    focus_observations = observations_by_watch.get(focused["id"], []) if focused else []
    latest = next(
        (o for o in focus_observations if not (o.get("metadata") or {}).get("skipped")),
        None,
    )

    # Whether the engine could read the market on its most recent pass. Skipped
    # sweeps are filtered out of the feed and the observed context — they are
    # not what the market did — but they ARE the answer to "why am I seeing
    # nothing?", and a watch that has been silently unable to read candles all
    # session looks identical to a quiet market without this.
    newest = focus_observations[0] if focus_observations else None
    skipped = (newest.get("metadata") or {}).get("skipped") if newest else None
    data_status = {
        "ok": not skipped,
        "reason": (newest.get("metadata") or {}).get("detail", "") if skipped else "",
        "checkedAt": newest.get("createdAt") if newest else None,
    }

    all_observations = [o for obs in observations_by_watch.values() for o in obs]

    return {
        "id": strategy["id"],
        "name": strategy.get("name"),
        "status": strategy.get("status"),
        "template": (
            template.to_dict()
            if template
            else {
                "id": None,
                "name": "Your own strategy",
                # Typed strategies are not lesser. They are simply not from the
                # catalogue, and the UI should say that rather than showing a
                # blank template card.
                "summary": "Written by you rather than adopted from the catalogue.",
                "available": True,
            }
        ),
        "configuration": {"parameters": _parameters(rules)},
        "watches": [_watch_summary(w, timelines[w["id"]]) for w in watches],
        "focusedWatchId": focused["id"] if focused else None,
        "currentState": focused.get("state") if focused else None,
        "conditions": focus_timeline.get("conditions") or [],
        "latestObservation": (
            {
                "at": latest.get("createdAt"),
                "candleTime": latest.get("candleTime"),
                "state": latest.get("state"),
                # The evaluator's own measurements — pullback depth, VWAP
                # deviation, level age, zone freshness and so on. Passed
                # through untouched so the panel can show observed context
                # without the backend deciding what is interesting.
                "context": latest.get("metadata") or {},
            }
            if latest
            else None
        ),
        "lifecycle": focus_timeline.get("events") or [],
        "dataStatus": data_status,
        "performance": compute_performance(
            strategy["id"], watches, observations_by_watch
        ).to_dict(),
        # Only breakdowns with real samples. A dimension with nothing behind it
        # is absent rather than empty.
        "availableAnalytics": available_dimensions(all_observations),
        "segments": compute_segments(all_observations),
    }
