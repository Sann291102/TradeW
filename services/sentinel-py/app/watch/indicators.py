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


class PullbackDepth(str, Enum):
    SHALLOW = "shallow"
    NORMAL = "normal"
    DEEP = "deep"


@dataclass(frozen=True)
class Pullback:
    swing_high_index: int
    low_index: int
    #: Raw price retracement. Kept, but never the number decisions are made on.
    depth: float
    #: Retracement in ATR multiples — the comparable measure across symbols.
    depth_atr: float | None
    #: Retracement as a multiple of the fast/slow EMA spread, which scales
    #: with how stretched the trend already is.
    depth_spread: float | None
    classification: PullbackDepth
    detail: str


# Boundaries in ATR multiples. A stated convention so the buckets are
# comparable across symbols from day one — the point is that the engine can
# later show how the USER's strategy performed in each bucket, and the
# boundaries can move once there is data to move them with.
SHALLOW_MAX_ATR = 1.0
NORMAL_MAX_ATR = 2.0


def classify_depth(depth_atr: float | None) -> PullbackDepth:
    if depth_atr is None or depth_atr < SHALLOW_MAX_ATR:
        return PullbackDepth.SHALLOW
    if depth_atr < NORMAL_MAX_ATR:
        return PullbackDepth.NORMAL
    return PullbackDepth.DEEP


def find_pullback(
    candles: list[Candle],
    fast: list[float],
    slow: list[float],
    atr_value: float | None,
) -> Pullback | None:
    """The most recent retracement from a swing high back toward the EMA pair.

    Measured from the highest high since the pair became bullish, down to the
    lowest low after it. Depth is reported in ATR multiples and in multiples
    of the fast/slow spread rather than in points: a 30-point pullback means
    something completely different on a 200-rupee option and on NIFTY, and a
    raw number would make the eventual shallow/normal/deep analysis
    meaningless across symbols.
    """
    if not fast or not slow:
        return None

    offset = len(candles) - min(len(fast), len(slow))
    window = candles[offset:]
    if len(window) < 3:
        return None

    high_at = max(range(len(window)), key=lambda i: window[i].high)
    after = window[high_at + 1 :]
    if not after:
        return None

    low_at = min(range(len(after)), key=lambda i: after[i].low)
    depth = window[high_at].high - after[low_at].low
    if depth <= 0:
        return None

    depth_atr = (depth / atr_value) if atr_value and atr_value > 0 else None
    spread = abs(fast[-1] - slow[-1])
    depth_spread = (depth / spread) if spread > 0 else None
    classification = classify_depth(depth_atr)

    return Pullback(
        swing_high_index=offset + high_at,
        low_index=offset + high_at + 1 + low_at,
        depth=depth,
        depth_atr=depth_atr,
        depth_spread=depth_spread,
        classification=classification,
        detail=(
            f"pulled back {depth:.2f}"
            + (f" ({depth_atr:.2f} ATR)" if depth_atr is not None else "")
            + f" — {classification.value}"
        ),
    )


# --- Horizontal levels -------------------------------------------------------
#
# A "level" here is not a line someone drew. It is a price the market has
# turned at more than once, discovered from swing pivots, with the evidence
# for it kept attached: how many times it was touched and how long ago it was
# first established. Those two numbers are the whole reason this is a
# primitive rather than a constant — a level formed twenty bars ago and
# touched twice is a different object from one that has held all session, and
# the flip strategy is entitled to require the second kind.


#: Bars either side of a candle for it to count as a pivot. Two is the common
#: fractal definition and keeps intraday noise from minting levels.
PIVOT_WINDOW = 2

#: A single pivot is a swing point, not a level. It takes a second touch at
#: the same price before the market can be said to have respected it.
MIN_LEVEL_TOUCHES = 2

#: How old a level must be before the flip strategy will use it. A level that
#: formed three bars ago has not been established, it has just happened.
MIN_LEVEL_AGE_BARS = 10


class LevelKind(str, Enum):
    RESISTANCE = "resistance"
    SUPPORT = "support"


@dataclass(frozen=True)
class Level:
    price: float
    kind: LevelKind
    #: How many distinct pivots formed at this price.
    touches: int
    #: Index of the first pivot — where the level was established.
    first_index: int
    last_index: int

    def age(self, total_candles: int) -> int:
        """Bars since the level was established."""
        return max(0, total_candles - 1 - self.first_index)


def find_swing_pivots(candles: list[Candle], window: int = PIVOT_WINDOW) -> tuple[list[int], list[int]]:
    """Indices of swing highs and swing lows.

    A pivot needs `window` bars on BOTH sides, so the most recent bars can
    never be pivots — by construction, not by oversight. A "pivot" confirmed
    by bars that have not printed yet would be a guess.

    The comparison is STRICT. With a non-strict test every bar of a flat tape
    ties for the maximum and so becomes a pivot, which would mint a level at
    every price in a market that had not turned anywhere.
    """
    highs: list[int] = []
    lows: list[int] = []
    for i in range(window, len(candles) - window):
        neighbours = candles[i - window : i] + candles[i + 1 : i + window + 1]
        if all(candles[i].high > c.high for c in neighbours):
            highs.append(i)
        if all(candles[i].low < c.low for c in neighbours):
            lows.append(i)
    return highs, lows


def level_tolerance(candles: list[Candle], atr_value: float | None) -> float:
    """How close two pivots must be to count as the same level. ATR-scaled so
    "the same price" means the same thing on an index and on an option."""
    if atr_value and atr_value > 0:
        return atr_value * 0.25
    return abs(candles[-1].close) * 0.001 if candles else 0.0


def find_levels(
    candles: list[Candle],
    atr_value: float | None = None,
    min_touches: int = MIN_LEVEL_TOUCHES,
) -> list[Level]:
    """Horizontal levels the market has actually turned at, newest pivot first.

    Pivots within an ATR-scaled tolerance are clustered into one level and the
    cluster keeps its touch count and the index of its FIRST pivot, which is
    what makes `level_age` answerable later.
    """
    if not candles:
        return []

    highs, lows = find_swing_pivots(candles)
    tolerance = level_tolerance(candles, atr_value)
    if tolerance <= 0:
        return []

    levels: list[Level] = []
    for indices, kind, price_of in (
        (highs, LevelKind.RESISTANCE, lambda i: candles[i].high),
        (lows, LevelKind.SUPPORT, lambda i: candles[i].low),
    ):
        clusters: list[list[int]] = []
        for i in indices:
            for cluster in clusters:
                if abs(price_of(i) - price_of(cluster[0])) <= tolerance:
                    cluster.append(i)
                    break
            else:
                clusters.append([i])

        for cluster in clusters:
            if len(cluster) < min_touches:
                continue
            levels.append(
                Level(
                    price=sum(price_of(i) for i in cluster) / len(cluster),
                    kind=kind,
                    touches=len(cluster),
                    first_index=min(cluster),
                    last_index=max(cluster),
                )
            )

    return sorted(levels, key=lambda level: level.first_index, reverse=True)


# --- VWAP --------------------------------------------------------------------


def vwap_series(candles: list[Candle]) -> list[float]:
    """Session-anchored VWAP, one value per candle in the CURRENT session.

    Sum(typical price x volume) / sum(volume), typical price = (H+L+C)/3,
    reset at each session boundary because a VWAP carried across days is not
    the level anyone trades against.

    Returns EMPTY when the instrument reports no volume. That is deliberate
    and load-bearing: several option contracts come back from the bridge with
    zero volume, and a "VWAP" computed by falling back to an average price
    would look like a working level while being unrelated to volume. A
    strategy that cannot be evaluated must fail to evaluate, not quietly
    evaluate against a fabricated number.
    """
    from app.market.clock import session_key

    if not candles:
        return []

    today = session_key(candles[-1].timestamp)
    session = [c for c in candles if session_key(c.timestamp) == today]
    if not session or all(c.volume <= 0 for c in session):
        return []

    out: list[float] = []
    cumulative_pv = 0.0
    cumulative_volume = 0.0
    for candle in session:
        typical = (candle.high + candle.low + candle.close) / 3
        cumulative_pv += typical * candle.volume
        cumulative_volume += candle.volume
        if cumulative_volume <= 0:
            # Leading zero-volume candles carry no VWAP yet; recording the
            # typical price here would invent one.
            continue
        out.append(cumulative_pv / cumulative_volume)
    return out


def vwap_deviation(price: float, vwap: float, atr_value: float | None) -> float | None:
    """How far price sits from VWAP, in ATR multiples. Signed: positive above.
    None without an ATR, rather than a raw distance that is incomparable
    across symbols."""
    if atr_value is None or atr_value <= 0:
        return None
    return (price - vwap) / atr_value


class VwapTest(str, Enum):
    FIRST = "first"
    SECOND = "second"
    REPEATED = "repeated"


@dataclass(frozen=True)
class VwapInteraction:
    count: int
    ordinal: VwapTest
    last_index: int | None
    detail: str


def vwap_slope(vwap_values: list[float], lookback: int = 5, atr_value: float | None = None) -> Slope:
    """Direction of VWAP itself, rising / flat / falling.

    Deliberately the SAME classifier the EMAs use, with a configurable
    lookback rather than a universal points threshold: "VWAP rising by 3" is
    meaningless without knowing whether the instrument is a 24,000 index or a
    ₹180 option, so the measurement is normalised against ATR exactly as the
    EMA slope is. A longer default lookback than the EMA's because VWAP is a
    cumulative average and moves more slowly by construction.
    """
    return classify_slope(vwap_values, lookback=lookback, atr=atr_value)


#: Deviation buckets in ATR multiples. Stated as a convention so the funnel can
#: split results by how stretched price was; the boundaries move once this
#: user's own history says they should, not before.
DEVIATION_BUCKETS = ((0.5, "0.5-1"), (1.0, "1-2"), (2.0, "2+"))

#: What counts as "extended" for the mean-reversion setup. A convention, not a
#: claim about edge — the funnel reports what actually happened at it.
EXTENSION_MIN_ATR = 1.5


def classify_deviation(deviation_atr: float | None) -> str | None:
    """Bucket a signed ATR deviation by magnitude. None when there is no ATR —
    an unbucketed sample is better than one filed under a made-up bucket."""
    if deviation_atr is None:
        return None
    magnitude = abs(deviation_atr)
    if magnitude < 0.5:
        return "under-0.5"
    if magnitude < 1.0:
        return "0.5-1"
    if magnitude < 2.0:
        return "1-2"
    return "2+"


@dataclass(frozen=True)
class VwapExtreme:
    index: int
    #: Signed ATR deviation at the extreme: positive above VWAP, negative below.
    deviation_atr: float
    price: float
    vwap: float
    detail: str


def find_vwap_extreme(
    candles: list[Candle],
    vwap_values: list[float],
    atr_value: float | None,
) -> VwapExtreme | None:
    """The most stretched point away from VWAP this session, in ATR multiples.

    Measured on candle EXTREMES rather than closes: the stretch that matters
    for a reversion setup is how far price actually travelled, and a bar that
    ran 2 ATR clear of VWAP before closing back is precisely the event.
    """
    if not vwap_values or atr_value is None or atr_value <= 0:
        return None

    offset = len(candles) - len(vwap_values)
    best: VwapExtreme | None = None
    for i in range(offset, len(candles)):
        level = vwap_values[i - offset]
        candle = candles[i]
        for price in (candle.high, candle.low):
            deviation = vwap_deviation(price, level, atr_value)
            if deviation is None:
                continue
            if best is None or abs(deviation) > abs(best.deviation_atr):
                best = VwapExtreme(
                    index=i,
                    deviation_atr=deviation,
                    price=price,
                    vwap=level,
                    detail=(
                        f"{abs(deviation):.2f} ATR "
                        f"{'above' if deviation > 0 else 'below'} VWAP {level:.2f}"
                    ),
                )
    return best


def count_vwap_tests(candles: list[Candle], vwap_values: list[float]) -> VwapInteraction:
    """How many distinct times price has come back to VWAP this session.

    Distinct matters: price hugging VWAP for six candles is ONE test, not
    six. A new test is only counted after price has left the level — the run
    of touching candles is collapsed the same way the feed collapses a state
    the watch is sitting in.

    The ordinal is what the performance engine will eventually bucket on,
    since a first test and a fourth test are not the same event.
    """
    if not vwap_values:
        return VwapInteraction(0, VwapTest.FIRST, None, "no VWAP available")

    offset = len(candles) - len(vwap_values)
    count = 0
    last_index: int | None = None
    touching = False

    for i in range(offset, len(candles)):
        level = vwap_values[i - offset]
        interaction = body_interaction(candles[i], level)
        if interaction.touched_wick:
            if not touching:
                count += 1
                touching = True
            last_index = i
        else:
            touching = False

    ordinal = VwapTest.FIRST if count <= 1 else VwapTest.SECOND if count == 2 else VwapTest.REPEATED
    return VwapInteraction(
        count=count,
        ordinal=ordinal,
        last_index=last_index,
        detail=f"{count} VWAP interaction(s) this session ({ordinal.value})",
    )
