"""Watch state machine: IDLE -> FORMING -> CONFIRMED.

IN_TRADE / EXITED are P4 (in-trade monitoring) and are declared here so the
states are in one place, but no transition into them exists yet.

Deviation from the architecture plan, deliberate: the plan's confirm rule
reads `mandatory_met == mandatory_total AND optional_met >= 1`. Taken
literally that never confirms a strategy with no optional rules — the
common case, since the parser only emits an optional rule when the user
mentioned volume. The optional requirement is therefore applied only when
the strategy actually HAS optional rules.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum

from app.watch.evaluator import EvaluationResult

DEFAULT_COOLDOWN = timedelta(minutes=15)


class WatchState(str, Enum):
    IDLE = "IDLE"
    FORMING = "FORMING"
    CONFIRMED = "CONFIRMED"
    IN_TRADE = "IN_TRADE"
    EXITED = "EXITED"


class Tier(str, Enum):
    WAIT_AND_WATCH = "wait_and_watch"
    SIDE_IN_FOCUS = "side_in_focus"


@dataclass(frozen=True)
class Transition:
    previous: WatchState
    current: WatchState
    changed: bool
    tier: Tier | None
    should_notify: bool
    reason: str
    cooldown_until: datetime | None


def next_state(evaluation: EvaluationResult) -> tuple[WatchState, Tier | None, str]:
    optional_satisfied = evaluation.optional_total == 0 or evaluation.optional_met >= 1

    if evaluation.all_mandatory_met and optional_satisfied:
        return (
            WatchState.CONFIRMED,
            Tier.SIDE_IN_FOCUS,
            f"all {evaluation.mandatory_total} mandatory conditions met",
        )
    if evaluation.any_mandatory_met:
        return (
            WatchState.FORMING,
            Tier.WAIT_AND_WATCH,
            f"{evaluation.mandatory_met}/{evaluation.mandatory_total} mandatory conditions met",
        )
    return WatchState.IDLE, None, "no conditions met yet"


def advance(
    current: WatchState,
    evaluation: EvaluationResult,
    last_notified_at: datetime | None,
    cooldown_until: datetime | None,
    now: datetime | None = None,
    cooldown: timedelta = DEFAULT_COOLDOWN,
) -> Transition:
    now = now or datetime.now(timezone.utc)
    target, tier, reason = next_state(evaluation)
    changed = target != current

    # A state that moves forward always notifies — reaching CONFIRMED is the
    # event the user asked to hear about, and swallowing it because a
    # "Wait & Watch" went out 3 minutes ago would defeat the whole watch.
    # Cooldown only suppresses REPEATS of a state the watch is already in.
    if changed and tier is not None:
        should_notify = True
    elif tier is None:
        should_notify = False
    elif cooldown_until is not None and now < cooldown_until:
        should_notify = False
    elif last_notified_at is None:
        should_notify = True
    else:
        should_notify = now - last_notified_at >= cooldown

    return Transition(
        previous=current,
        current=target,
        changed=changed,
        tier=tier,
        should_notify=should_notify,
        reason=reason,
        cooldown_until=(now + cooldown) if should_notify else cooldown_until,
    )
