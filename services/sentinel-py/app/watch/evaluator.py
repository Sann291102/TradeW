"""Rule evaluator — parsed strategy rules vs. real candles.

Each `condition` string the parser emits (app/strategy/parser.py) maps to one
function here. Unknown conditions evaluate to "not met" and are reported in
the result rather than raising, so a strategy whose text contained something
the parser recognised loosely can never silently count as confirmed.

Only CLOSED candles are evaluated. The candle currently forming is excluded
by the caller (see `closed_candles`) — this is the "confirmation before
notification" rule from the architecture plan: a wick that crosses a level
mid-candle and pulls back is not a breakout, and alerting on it would make
Sentinel exactly the noisy signal generator it is not supposed to be.
"""

from dataclasses import dataclass

from app.market.clock import session_key
from app.market.feed import Candle
from app.watch.indicators import (
    Slope,
    atr,
    classify_slope,
    ema_of,
    find_bullish_reclaim,
    find_bullish_reclaims,
)


@dataclass(frozen=True)
class RuleResult:
    rule_id: str
    name: str
    condition: str
    mandatory: bool
    met: bool
    detail: str


@dataclass(frozen=True)
class EvaluationResult:
    rules: list[RuleResult]
    mandatory_total: int
    mandatory_met: int
    optional_total: int
    optional_met: int
    opening_range_high: float | None
    opening_range_low: float | None

    @property
    def all_mandatory_met(self) -> bool:
        return self.mandatory_total > 0 and self.mandatory_met == self.mandatory_total

    @property
    def any_mandatory_met(self) -> bool:
        return self.mandatory_met > 0


def closed_candles(candles: list[Candle], now_ms: float | None = None) -> list[Candle]:
    """Drop the still-forming last candle. The bridge returns the in-progress
    bar as the final element during market hours."""
    return candles[:-1] if candles else []


def _todays_candles(candles: list[Candle]) -> list[Candle]:
    if not candles:
        return []
    today = session_key(candles[-1].timestamp)
    return [c for c in candles if session_key(c.timestamp) == today]


def opening_range(candles: list[Candle]) -> tuple[float | None, float | None]:
    """High/low of the session's FIRST candle at the strategy's timeframe.
    With 15m candles this is literally the first 15 minutes."""
    today = _todays_candles(candles)
    if not today:
        return None, None
    first = today[0]
    return first.high, first.low


def _breakout_above(candles: list[Candle], level: float) -> tuple[bool, str]:
    today = _todays_candles(candles)[1:]
    for candle in today:
        if candle.close > level:
            return True, f"close {candle.close} above {level}"
    return False, f"no close above {level}"


def _breakout_below(candles: list[Candle], level: float) -> tuple[bool, str]:
    today = _todays_candles(candles)[1:]
    for candle in today:
        if candle.close < level:
            return True, f"close {candle.close} below {level}"
    return False, f"no close below {level}"


def _retest(candles: list[Candle], high: float, low: float, tolerance_pct: float = 0.1) -> tuple[bool, str]:
    """A retest is three ordered events, not a coincidence: a candle closes
    through the level, a LATER candle trades back to it (within tolerance),
    and a LATER-still candle closes back in the breakout direction."""
    today = _todays_candles(candles)[1:]

    for level, direction in ((high, "above"), (low, "below")):
        tol = abs(level) * tolerance_pct / 100
        broke_at = None
        for i, candle in enumerate(today):
            if direction == "above" and candle.close > level:
                broke_at = i
                break
            if direction == "below" and candle.close < level:
                broke_at = i
                break
        if broke_at is None:
            continue

        touched_at = None
        for i in range(broke_at + 1, len(today)):
            candle = today[i]
            if direction == "above" and candle.low <= level + tol:
                touched_at = i
                break
            if direction == "below" and candle.high >= level - tol:
                touched_at = i
                break
        if touched_at is None:
            continue

        for i in range(touched_at + 1, len(today)):
            candle = today[i]
            if direction == "above" and candle.close > level:
                return True, f"retested {level} and closed back above at {candle.close}"
            if direction == "below" and candle.close < level:
                return True, f"retested {level} and closed back below at {candle.close}"

    return False, "no completed retest (break -> return to level -> close back through)"


def _volume_above_average(candles: list[Candle], period: int = 20) -> tuple[bool, str]:
    if len(candles) < period + 1:
        return False, f"not enough candles for a {period}-period volume average"
    window = candles[-(period + 1) : -1]
    average = sum(c.volume for c in window) / len(window)
    latest = candles[-1].volume
    if average <= 0:
        return False, "no volume reported for this instrument"
    return latest > average, f"volume {latest} vs {period}-period avg {average:.0f}"


# --- EMA-7 Bullish Reclaim ---------------------------------------------------
#
# Long only, by construction. There is no bearish mirror of these functions:
# the setup the user adopted is a bullish reclaim, and a condition set that
# could be read either way would let the same template justify a short.


def _ema_rising(candles: list[Candle], period: int) -> tuple[bool, str]:
    values = ema_of(candles, period)
    if not values:
        return False, f"not enough candles for an EMA-{period}"
    slope = classify_slope(values, atr=atr(candles))
    return slope is Slope.RISING, f"EMA-{period} is {slope.value} ({values[-1]:.2f})"


def _price_above_ema(candles: list[Candle], period: int) -> tuple[bool, str]:
    values = ema_of(candles, period)
    if not values:
        return False, f"not enough candles for an EMA-{period}"
    close = candles[-1].close
    return close > values[-1], f"close {close:.2f} vs EMA-{period} {values[-1]:.2f}"


def _ema_body_reclaim(candles: list[Candle], period: int) -> tuple[bool, str]:
    values = ema_of(candles, period)
    if not values:
        return False, f"not enough candles for an EMA-{period}"
    reclaim = find_bullish_reclaim(candles, values)
    if reclaim is None:
        return False, f"no candle body has reached EMA-{period} and closed back above it"
    return True, reclaim.detail


def _reclaim_followed_through(candles: list[Candle], period: int) -> tuple[bool, str]:
    """The patience requirement: the reclaim alone is not the setup.

    After the reclaim candle, price must either take out that candle's high
    (a continuation/consolidation break) or come back toward the EMA and hold
    before pushing through it. Until one of those happens the setup is still
    developing, which is exactly the state the user said they wait through.
    """
    values = ema_of(candles, period)
    if not values:
        return False, f"not enough candles for an EMA-{period}"
    reclaims = find_bullish_reclaims(candles, values)
    if not reclaims:
        return False, "no reclaim to follow through from"

    # ANY reclaim that a later candle closed above counts. Checking only the
    # newest would mean a candle that both confirmed an earlier reclaim and
    # touched the EMA itself reset the setup to "waiting" forever.
    for reclaim in reclaims:
        trigger = candles[reclaim.index].high
        for bar in candles[reclaim.index + 1 :]:
            if bar.close > trigger:
                return True, f"closed {bar.close:.2f} above the reclaim candle high {trigger:.2f}"

    latest = candles[reclaims[-1].index].high
    return False, f"waiting for a close above the reclaim candle high {latest:.2f}"


def evaluate(rules: list[dict], candles: list[Candle]) -> EvaluationResult:
    bars = closed_candles(candles)
    or_high, or_low = opening_range(bars)

    results: list[RuleResult] = []
    for rule in rules:
        condition = rule.get("condition", "")
        met, detail = False, "no candles"

        if not bars:
            pass
        elif condition.endswith("_high") and condition.startswith("price_closes_above"):
            met, detail = (False, "no opening range yet") if or_high is None else _breakout_above(bars, or_high)
        elif condition.endswith("_low") and condition.startswith("price_closes_below"):
            met, detail = (False, "no opening range yet") if or_low is None else _breakout_below(bars, or_low)
        elif condition == "price_retests_level_then_bounces":
            if or_high is None or or_low is None:
                met, detail = False, "no opening range yet"
            else:
                met, detail = _retest(bars, or_high, or_low)
        elif condition == "ema7_rising":
            met, detail = _ema_rising(bars, 7)
        elif condition == "price_above_ema7":
            met, detail = _price_above_ema(bars, 7)
        elif condition == "ema7_body_reclaim":
            met, detail = _ema_body_reclaim(bars, 7)
        elif condition == "reclaim_retest_or_consolidation":
            met, detail = _reclaim_followed_through(bars, 7)
        elif condition == "volume_above_20_period_avg":
            met, detail = _volume_above_average(bars)
        else:
            met, detail = False, f"unrecognized condition '{condition}' — never counts as met"

        results.append(
            RuleResult(
                rule_id=rule.get("id", ""),
                name=rule.get("name", ""),
                condition=condition,
                mandatory=bool(rule.get("mandatory")),
                met=met,
                detail=detail,
            )
        )

    mandatory = [r for r in results if r.mandatory]
    optional = [r for r in results if not r.mandatory]
    return EvaluationResult(
        rules=results,
        mandatory_total=len(mandatory),
        mandatory_met=sum(1 for r in mandatory if r.met),
        optional_total=len(optional),
        optional_met=sum(1 for r in optional if r.met),
        opening_range_high=or_high,
        opening_range_low=or_low,
    )
