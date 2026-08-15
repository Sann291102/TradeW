"""Performance funnel for a user's OWN adopted strategy.

Answers "how has *my* strategy behaved?" — never "which strategy is best".
Nothing here ranks strategies against each other, nominates one, or proposes
a trade; it describes what already happened to watches the user created.

## The funnel

    watches            the strategy was applied to an instrument
      ↓
    interactions       at least one condition was met at some point
      ↓
    confirmations      every mandatory condition was met at once
      ↓
    entries            the user declared a position
      ↓
    outcomes           the position reached an invalidation or projected level

Each stage is derived from the observation history, not from the watch's
CURRENT state: a watch sitting in EXITED still passed through confirmation
and entry, and a funnel that only read the last state would report zero of
everything the moment a trade closed.

## What is deliberately not computed

No win rate is reported without its sample size beside it, and `sufficient`
stays false until there are enough completed trades to mean anything — a
90% win rate off ten trades is a number that misleads more than silence
would. The threshold is a stated convention, not a discovered truth.
"""

from dataclasses import asdict, dataclass, field

# Below this many completed trades, rates are reported but flagged as not yet
# meaning anything. Chosen as a convention to be argued with, not a finding.
MEANINGFUL_SAMPLE = 30

_TERMINAL_EVENTS = {"invalidation_reached", "projected_level_reached"}


@dataclass
class Funnel:
    watches: int = 0
    interactions: int = 0
    confirmations: int = 0
    entries: int = 0
    outcomes: int = 0
    # Setups that met a condition and then gave it back, counted across every
    # watch. Not a funnel stage — a setup can step back and recover — but the
    # number that says where setups die.
    rejections: int = 0


@dataclass
class Outcomes:
    reachedProjected: int = 0
    reachedInvalidation: int = 0
    stillOpen: int = 0


@dataclass
class RStats:
    """All in multiples of the risk the USER defined. None when there is
    nothing to average rather than a misleading zero."""

    completed: int = 0
    expectancy: float | None = None
    best: float | None = None
    worst: float | None = None
    # Max favourable / adverse excursion, averaged across completed trades:
    # how far trades ran in favour and against before finishing.
    avgMfe: float | None = None
    avgMae: float | None = None


@dataclass
class StrategyPerformance:
    strategyId: str
    funnel: Funnel = field(default_factory=Funnel)
    outcomes: Outcomes = field(default_factory=Outcomes)
    r: RStats = field(default_factory=RStats)
    sufficient: bool = False
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self) | {"sufficient": self.sufficient, "note": self.note}


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def compute_performance(
    strategy_id: str,
    watches: list[dict],
    observations_by_watch: dict[str, list[dict]],
) -> StrategyPerformance:
    funnel = Funnel(watches=len(watches))
    outcomes = Outcomes()
    finals: list[float] = []
    mfes: list[float] = []
    maes: list[float] = []

    for watch in watches:
        observations = observations_by_watch.get(watch["id"], [])
        usable = [o for o in observations if not (o.get("metadata") or {}).get("skipped")]

        states = {o.get("state") for o in usable}
        # Entry is recorded by the user declaring a position, which is what
        # entryPrice means; a watch can be IN_TRADE in one observation and
        # closed by the time we read it.
        entered = watch.get("entryPrice") is not None or "IN_TRADE" in states

        if states & {"FORMING", "CONFIRMED", "IN_TRADE", "EXITED"}:
            funnel.interactions += 1
        if states & {"CONFIRMED", "IN_TRADE", "EXITED"} or entered:
            funnel.confirmations += 1
        if entered:
            funnel.entries += 1

        funnel.rejections += _count_rejections(usable)

        if not entered:
            continue

        # In-trade readings, oldest first, so "final" is the last one.
        in_trade = [o for o in reversed(usable) if o.get("agent") == "intrade-monitor"]
        r_values = [
            (o.get("metadata") or {}).get("rMultiple")
            for o in in_trade
            if (o.get("metadata") or {}).get("rMultiple") is not None
        ]

        terminal = _terminal_event(in_trade)
        if terminal is None:
            outcomes.stillOpen += 1
            continue

        funnel.outcomes += 1
        if terminal == "projected_level_reached":
            outcomes.reachedProjected += 1
        else:
            outcomes.reachedInvalidation += 1

        if r_values:
            finals.append(float(r_values[-1]))
            mfes.append(float(max(r_values)))
            maes.append(float(min(r_values)))

    r = RStats(
        completed=len(finals),
        expectancy=_mean(finals),
        best=round(max(finals), 3) if finals else None,
        worst=round(min(finals), 3) if finals else None,
        avgMfe=_mean(mfes),
        avgMae=_mean(maes),
    )

    sufficient = r.completed >= MEANINGFUL_SAMPLE
    note = (
        ""
        if sufficient
        else f"{r.completed} completed trade(s) — too few to read as a rate. "
        f"Treated as meaningful from {MEANINGFUL_SAMPLE}."
    )

    return StrategyPerformance(
        strategyId=strategy_id, funnel=funnel, outcomes=outcomes, r=r, sufficient=sufficient, note=note
    )


def _terminal_event(in_trade_oldest_first: list[dict]) -> str | None:
    for observation in reversed(in_trade_oldest_first):
        for finding in observation.get("ruleEvaluations") or []:
            if finding.get("event") in _TERMINAL_EVENTS:
                return finding["event"]
    return None


def _count_rejections(usable_newest_first: list[dict]) -> int:
    """Reuses the timeline's definition so the number in the funnel and the
    events in the feed can never disagree."""
    from app.watch.timeline import _rejection

    pre_entry = [o for o in usable_newest_first if o.get("agent") != "intrade-monitor"]
    return sum(
        1
        for index in range(len(pre_entry) - 1)
        if _rejection(pre_entry[index], pre_entry[index + 1]) is not None
    )
