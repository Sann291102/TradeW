"""In-trade monitoring — what Sentinel watches AFTER the user tells it they
have taken a position.

## What this is and is not

Every number here is the USER'S. They declare their entry, their invalidation
level and (optionally) their projected level when they mark the position
taken. Sentinel proposes none of them; it reports where price has moved
relative to numbers it was handed. That is the difference between this and a
trade alert, and it is why this phase can exist at all under ARCH-4.

The vocabulary rules still bind the OUTPUT even though the concepts are the
user's own: `app/notify/compliance.py` rejects "stop-loss"/"target" wording,
so the events below are named `invalidation_reached` and
`projected_level_reached` rather than "stop hit"/"target hit", and no event
carries an instruction like "move your stop to breakeven".

## Conservative in both directions, deliberately

Risk and reward are not read off the same price:

- **Adverse events** (invalidation, structure break) use the candle's adverse
  extreme — the low for a long, the high for a short. Price genuinely traded
  there, and a watcher that stayed quiet because the bar closed back above
  the level would be hiding the thing the user most needs to know.
- **Favourable events** (R-multiples, projected level) use the candle CLOSE.
  A wick that tags 2R and retraces has not achieved 2R, and announcing it
  would let the user act on a number that was never real.

So: quick to report risk, slow to claim progress. Both directions read only
CLOSED candles, matching the confirmation rule in app/watch/evaluator.py.
"""

from dataclasses import dataclass, field
from enum import Enum

from app.market.feed import Candle
from app.watch.evaluator import closed_candles, opening_range

# Announced in ascending order; only the highest newly-crossed one fires per
# sweep, so a gap straight through 1R to 3R reports 3R rather than three rows.
MILESTONES: tuple[tuple[str, float], ...] = (("1R", 1.0), ("2R", 2.0), ("3R", 3.0))


class Direction(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


class IntradeEvent(str, Enum):
    MILESTONE = "milestone"
    INVALIDATION_REACHED = "invalidation_reached"
    PROJECTED_LEVEL_REACHED = "projected_level_reached"
    STRUCTURE_BREAK = "structure_break"


@dataclass(frozen=True)
class IntradeFinding:
    event: IntradeEvent
    detail: str
    # Set only for MILESTONE, e.g. "2R".
    milestone: str | None = None
    # Whether this finding ends the position.
    closes_position: bool = False


@dataclass(frozen=True)
class IntradeResult:
    findings: list[IntradeFinding] = field(default_factory=list)
    r_multiple: float | None = None
    newly_reached: list[str] = field(default_factory=list)

    @property
    def closes_position(self) -> bool:
        return any(f.closes_position for f in self.findings)


def r_multiple(entry: float, current: float, stop: float, direction: Direction) -> float | None:
    """Progress in units of the user's own declared risk. Negative when price
    has moved against the position. None when risk is zero — an entry equal to
    the invalidation level has no scale to measure against, and dividing by it
    would produce an infinite R that reads as spectacular success."""
    risk = abs(entry - stop)
    if risk == 0:
        return None
    reward = (current - entry) if direction is Direction.LONG else (entry - current)
    return reward / risk


def _adverse_extreme(candle: Candle, direction: Direction) -> float:
    return candle.low if direction is Direction.LONG else candle.high


def _breached(price: float, level: float, direction: Direction) -> bool:
    """Has price reached or passed the invalidation level, in the direction
    that hurts this position?"""
    return price <= level if direction is Direction.LONG else price >= level


def _reached_projection(price: float, level: float, direction: Direction) -> bool:
    return price >= level if direction is Direction.LONG else price <= level


def evaluate_position(
    candles: list[Candle],
    entry: float,
    stop: float,
    direction: Direction,
    target: float | None = None,
    already_reached: list[str] | None = None,
) -> IntradeResult:
    bars = closed_candles(candles)
    if not bars:
        return IntradeResult()

    already = set(already_reached or [])
    latest = bars[-1]
    findings: list[IntradeFinding] = []

    # Adverse first: if the position is invalidated, that is the finding that
    # matters and a favourable milestone on the same bar is not worth saying.
    if _breached(_adverse_extreme(latest, direction), stop, direction):
        return IntradeResult(
            findings=[
                IntradeFinding(
                    event=IntradeEvent.INVALIDATION_REACHED,
                    detail=f"price reached the invalidation level you set ({stop})",
                    closes_position=True,
                )
            ],
            r_multiple=r_multiple(entry, latest.close, stop, direction),
        )

    ratio = r_multiple(entry, latest.close, stop, direction)

    if target is not None and _reached_projection(latest.close, target, direction):
        return IntradeResult(
            findings=[
                IntradeFinding(
                    event=IntradeEvent.PROJECTED_LEVEL_REACHED,
                    detail=f"price reached the projected level you set ({target})",
                    closes_position=True,
                )
            ],
            r_multiple=ratio,
        )

    newly_reached: list[str] = []
    if ratio is not None and ratio > 0:
        crossed = [name for name, threshold in MILESTONES if ratio >= threshold and name not in already]
        if crossed:
            highest = crossed[-1]
            newly_reached = crossed
            findings.append(
                IntradeFinding(
                    event=IntradeEvent.MILESTONE,
                    detail=f"your position has moved {highest.replace('R', ':1')} "
                    f"relative to the risk you defined",
                    milestone=highest,
                )
            )

    # Structure break: the opening range level that framed the setup has given
    # way against the position. Reported, never acted on — it does not close
    # the position, because the user's own invalidation level is the only
    # thing that decides that.
    or_high, or_low = opening_range(bars)
    if or_high is not None and or_low is not None:
        broke = (
            latest.close < or_low if direction is Direction.LONG else latest.close > or_high
        )
        if broke:
            findings.append(
                IntradeFinding(
                    event=IntradeEvent.STRUCTURE_BREAK,
                    detail="market structure is shifting against your position — stay safe and watch",
                )
            )

    return IntradeResult(findings=findings, r_multiple=ratio, newly_reached=newly_reached)
