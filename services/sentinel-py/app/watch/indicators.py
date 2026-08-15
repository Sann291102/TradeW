"""Indicator primitives the evaluator builds conditions from.

Pure functions over candle lists — no I/O, no state — so each one can be
tested against a hand-built series rather than a market.

Everything here answers a factual question about price ("is this EMA
rising?", "did this candle's BODY reach the level?"). Nothing here decides
whether a setup is good, ranks anything, or suggests an action; that
separation is what keeps the evaluator describable to a user as "your rules,
checked".
"""

from dataclasses import dataclass
from enum import Enum

from app.market.feed import Candle


def ema_series(values: list[float], period: int) -> list[float]:
    """Exponential moving average, seeded with the simple average of the
    first `period` values.

    Returns one value per input from index `period - 1` onward, so the caller
    can align it against the tail of the candle list. Shorter input returns
    empty rather than a value computed from too little data — an "EMA-7" off
    three candles is not an EMA-7.
    """
    if period <= 0 or len(values) < period:
        return []

    multiplier = 2 / (period + 1)
    seed = sum(values[:period]) / period
    out = [seed]
    for value in values[period:]:
        out.append((value - out[-1]) * multiplier + out[-1])
    return out


def ema_of(candles: list[Candle], period: int) -> list[float]:
    return ema_series([c.close for c in candles], period)


class Slope(str, Enum):
    RISING = "rising"
    FLAT = "flat"
    FALLING = "falling"


def classify_slope(ema_values: list[float], lookback: int = 3, atr: float | None = None) -> Slope:
    """Direction of the EMA over `lookback` steps.

    Normalised against ATR when one is supplied, so "rising" means the same
    thing on a ₹200 option and a 24,000 index. Without ATR it falls back to a
    relative threshold, which is weaker but never silently treats noise on a
    large number as a trend.
    """
    if len(ema_values) < lookback + 1:
        return Slope.FLAT

    change = ema_values[-1] - ema_values[-1 - lookback]
    scale = atr if atr and atr > 0 else abs(ema_values[-1]) * 0.001
    if scale <= 0:
        return Slope.FLAT

    normalised = change / scale
    if normalised > 0.25:
        return Slope.RISING
    if normalised < -0.25:
        return Slope.FALLING
    return Slope.FLAT


def atr(candles: list[Candle], period: int = 14) -> float | None:
    """Average true range. None below `period` candles rather than an average
    of whatever happens to be there."""
    if len(candles) < period + 1:
        return None
    trs: list[float] = []
    for previous, current in zip(candles[-period - 1 : -1], candles[-period:]):
        trs.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
    return sum(trs) / len(trs) if trs else None


def relative_volume(candles: list[Candle], period: int = 20) -> float | None:
    """Latest volume as a multiple of the trailing average. None when there
    is no history or the instrument reports no volume at all."""
    if len(candles) < period + 1:
        return None
    window = candles[-(period + 1) : -1]
    average = sum(c.volume for c in window) / len(window)
    if average <= 0:
        return None
    return candles[-1].volume / average


@dataclass(frozen=True)
class BodyInteraction:
    """How a candle's BODY sat relative to a level.

    The distinction the EMA-7 setup rests on: a wick that pokes the EMA is
    not the same event as a body that trades into it and closes back above.
    Wick-only touches are extremely common and mean much less.
    """

    touched_body: bool
    touched_wick: bool
    closed_above: bool
    closed_below: bool


def body_interaction(candle: Candle, level: float) -> BodyInteraction:
    body_low = min(candle.open, candle.close)
    body_high = max(candle.open, candle.close)
    return BodyInteraction(
        touched_body=body_low <= level <= body_high,
        touched_wick=candle.low <= level <= candle.high,
        closed_above=candle.close > level,
        closed_below=candle.close < level,
    )


@dataclass(frozen=True)
class Reclaim:
    index: int
    level: float
    detail: str


def find_bullish_reclaims(candles: list[Candle], ema_values: list[float]) -> list[Reclaim]:
    """Every bullish reclaim in the series, oldest first.

    Callers need the whole list rather than only the newest one: a candle
    that follows through on an earlier reclaim can itself touch the EMA and
    qualify as a reclaim. Returning only the most recent made the newest
    reclaim permanently "still waiting", because the very candle that
    confirmed it became the thing awaiting confirmation.
    """
    if not ema_values:
        return []

    offset = len(candles) - len(ema_values)
    found: list[Reclaim] = []
    for i in range(offset, len(candles)):
        level = ema_values[i - offset]
        interaction = body_interaction(candles[i], level)
        if interaction.touched_body and interaction.closed_above:
            found.append(
                Reclaim(
                    index=i,
                    level=level,
                    detail=f"body reached EMA {level:.2f} and closed above at {candles[i].close:.2f}",
                )
            )
    return found


def find_bullish_reclaim(candles: list[Candle], ema_values: list[float]) -> Reclaim | None:
    """A candle whose BODY reached down into the EMA and still closed above it.

    Long-only by construction: this is the bullish reclaim, and there is no
    bearish counterpart here. A setup that only ever describes one side
    cannot be quietly reused to justify the other.

    Scans newest-first and returns the most recent qualifying candle.
    """
    reclaims = find_bullish_reclaims(candles, ema_values)
    return reclaims[-1] if reclaims else None
