"""Indicator primitives the evaluator builds conditions from.

Pure functions over candle lists — no I/O, no state — so each one can be
tested against a hand-built series rather than a market.

Everything here answers a factual question about price ("is this EMA
rising?", "did this candle's BODY reach the level?"). Nothing here decides
whether a setup is good, ranks anything, or suggests an action; that
separation is what keeps the evaluator describable to a user as "your rules,
checked".
"""

# The zone section references Impulse, which is defined further down; deferred
# annotations keep the file ordered by concept rather than by definition order.
from __future__ import annotations

from dataclasses import dataclass, replace
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


# --- Liquidity and fair value gaps -------------------------------------------
#
# A liquidity pool is just a level looked at from the other side: where equal
# highs or lows sit, resting orders sit behind them. So pools reuse
# `find_levels` rather than introducing a parallel notion of "a price that
# matters" that could drift out of agreement with it.
#
# A sweep is the specific event of price trading THROUGH such a pool and
# closing back — the level being taken, not broken. The distinction is the
# whole strategy: a close beyond the pool is a breakout, and reading it as a
# sweep would invert the direction the setup expects.


@dataclass(frozen=True)
class Sweep:
    index: int
    pool: Level
    #: True when a pool of lows was swept, which sets up a move UP.
    bullish: bool
    #: How far beyond the pool price reached, in ATR multiples.
    penetration_atr: float
    detail: str


def find_sweeps(candles: list[Candle], atr_value: float | None) -> list[Sweep]:
    """Every sweep of a liquidity pool, oldest first.

    Requires the candle to trade beyond the pool and CLOSE back on the side it
    came from. A close beyond the pool is a break, not a sweep, and the two
    imply opposite directions.
    """
    if atr_value is None or atr_value <= 0:
        return []

    tolerance = level_tolerance(candles, atr_value)
    found: list[Sweep] = []
    for pool in find_levels(candles, atr_value):
        for i in range(pool.last_index + 1, len(candles)):
            candle = candles[i]
            if pool.kind is LevelKind.SUPPORT:
                took = candle.low < pool.price - tolerance and candle.close > pool.price
                reach = pool.price - candle.low
            else:
                took = candle.high > pool.price + tolerance and candle.close < pool.price
                reach = candle.high - pool.price
            if not took:
                continue
            found.append(
                Sweep(
                    index=i,
                    pool=pool,
                    bullish=pool.kind is LevelKind.SUPPORT,
                    penetration_atr=reach / atr_value,
                    detail=(
                        f"swept the {pool.kind.value} pool at {pool.price:.2f} "
                        f"by {reach / atr_value:.2f} ATR and closed back"
                    ),
                )
            )
            break
    return sorted(found, key=lambda s: s.index)


@dataclass(frozen=True)
class FairValueGap:
    #: Index of the MIDDLE candle of the three that formed the gap.
    index: int
    top: float
    bottom: float
    bullish: bool

    @property
    def detail(self) -> str:
        return f"{'bullish' if self.bullish else 'bearish'} gap {self.bottom:.2f}-{self.top:.2f}"


def find_fair_value_gaps(
    candles: list[Candle],
    bullish: bool,
    start: int = 0,
    end: int | None = None,
) -> list[FairValueGap]:
    """Three-candle imbalances inside a range of the series.

    A bullish gap is where the first candle's HIGH sits below the third
    candle's LOW: price moved so fast that a band of prices never traded on
    the way through. `start`/`end` exist so a caller can ask only about the
    gaps left by one specific move rather than every gap on the chart — an
    unrelated gap from an hour earlier is not the one the setup is about.
    """
    stop = len(candles) if end is None else min(end + 1, len(candles))
    gaps: list[FairValueGap] = []
    for i in range(max(start + 1, 1), stop - 1):
        first, third = candles[i - 1], candles[i + 1]
        if bullish and first.high < third.low:
            gaps.append(FairValueGap(index=i, top=third.low, bottom=first.high, bullish=True))
        if not bullish and first.low > third.high:
            gaps.append(FairValueGap(index=i, top=first.low, bottom=third.high, bullish=False))
    return gaps


def find_structure_shift(
    candles: list[Candle],
    from_index: int,
    bullish: bool,
) -> int | None:
    """The first close beyond the swing that stood before `from_index`.

    This is what separates "price bounced" from "the market changed its mind":
    after a sweep, taking out the last opposing swing is the evidence that the
    move has structural consequence rather than being a single strong candle.
    """
    highs, lows = find_swing_pivots(candles)
    prior = [i for i in (highs if bullish else lows) if i < from_index]
    if not prior:
        return None

    level = candles[prior[-1]].high if bullish else candles[prior[-1]].low
    for i in range(from_index + 1, len(candles)):
        if bullish and candles[i].close > level:
            return i
        if not bullish and candles[i].close < level:
            return i
    return None


# --- Higher-timeframe context ------------------------------------------------


def resample(candles: list[Candle], factor: int) -> list[Candle]:
    """Aggregate candles into a coarser timeframe: 5m x 3 = 15m.

    Derived from the SAME series the watch already reads rather than fetched
    separately, so the higher timeframe can never disagree with the lower one
    about what happened — a second request could return a differently-aligned
    or differently-adjusted series and the two would quietly describe
    different markets.

    Only whole groups are emitted. A trailing partial group is dropped, for
    the same reason the evaluator drops the forming candle.
    """
    if factor <= 1 or len(candles) < factor:
        return list(candles) if factor <= 1 else []

    out: list[Candle] = []
    for start in range(0, len(candles) - factor + 1, factor):
        group = candles[start : start + factor]
        out.append(
            Candle(
                timestamp=group[0].timestamp,
                open=group[0].open,
                high=max(c.high for c in group),
                low=min(c.low for c in group),
                close=group[-1].close,
                volume=sum(c.volume for c in group),
            )
        )
    return out


# --- Supply / demand zones ---------------------------------------------------
#
# A zone is a PLACE, not an event: an area price left in a hurry, which it may
# come back to later today, tomorrow, or never. That makes identity the
# central problem. The sweep runs every fifteen seconds, and a zone model that
# re-derives fresh objects each pass would report a brand-new zone every time,
# lose its touch history, and make "this zone has been tested twice" unsayable.
#
# So a zone's identity comes from the bar that formed it — the base candle's
# timestamp and the zone's bounds — and is therefore stable across sweeps for
# as long as that bar is in the window. Nothing is stored; the same input
# yields the same id, which is what makes touches and freshness accumulate
# rather than reset.


#: A base is the quiet bit before the departure — the balance price left. More
#: than a few bars and it is a range, not a zone.
ZONE_MAX_BASE_BARS = 3

#: How hard price must leave for the area to count as a zone at all.
ZONE_MIN_DEPARTURE_ATR = 1.5

#: A base is BALANCE — small bodies. Without this the first candle of the
#: departure gets absorbed into the base and the zone is drawn across the very
#: range price travelled instead of the area it left.
BASE_MAX_BODY_ATR = 0.5


class ZoneKind(str, Enum):
    DEMAND = "demand"
    SUPPLY = "supply"


@dataclass(frozen=True)
class Zone:
    #: Stable across sweeps: derived from the forming bar, not from when the
    #: detection ran.
    id: str
    kind: ZoneKind
    top: float
    bottom: float
    base_index: int
    #: Where the departure finished. Touches are counted from here, not from
    #: the base: the candle that CREATED the zone by leaving it overlaps the
    #: zone on its way out, and counting that as a test would make every zone
    #: born already tested.
    departure_end_index: int
    #: Strength of the move away, in ATR multiples.
    departure_atr: float
    #: Distinct returns into the zone since it formed. 0 means untested.
    touches: int
    #: Bars since the zone formed.
    age: int
    #: Zone height in ATR multiples. A wide zone is a weaker claim about where
    #: price will react than a narrow one, and the number says so plainly.
    width_atr: float
    #: The timeframe this zone was detected on, carried so a 15m zone is never
    #: silently compared with a 5m one.
    timeframe: str

    @property
    def fresh(self) -> bool:
        return self.touches == 0

    def contains(self, price: float) -> bool:
        return self.bottom <= price <= self.top

    @property
    def detail(self) -> str:
        return (
            f"{self.kind.value} zone {self.bottom:.2f}-{self.top:.2f} "
            f"({self.timeframe}, {self.departure_atr:.2f} ATR departure, "
            f"{'untested' if self.fresh else f'{self.touches} touches'}, {self.age} bars old)"
        )


def _zone_id(kind: ZoneKind, base: Candle, top: float, bottom: float, timeframe: str) -> str:
    """Identity from the formation, so re-detection produces the SAME zone."""
    return f"{kind.value}:{timeframe}:{base.timestamp.isoformat()}:{bottom:.4f}-{top:.4f}"


def count_zone_touches(candles: list[Candle], zone: Zone) -> int:
    """Distinct returns into the zone after it formed.

    Collapsed the same way VWAP tests are: price sitting inside a zone for six
    bars has tested it once. Counting each bar would make a zone look heavily
    used purely for having been sat in.
    """
    touches = 0
    inside = False
    for candle in candles[zone.departure_end_index + 1 :]:
        overlapping = candle.low <= zone.top and candle.high >= zone.bottom
        if overlapping and not inside:
            touches += 1
        inside = overlapping
    return touches


def measure_departure(candles: list[Candle], atr_value: float | None) -> Impulse | None:
    """How hard price left, measured FROM the first candle given.

    Deliberately not `find_impulse`: that scans for the best leg anywhere in
    the window and will happily report one that starts a few bars later. The
    question a zone asks is narrower — did price leave THIS area immediately
    and fast — so the window is anchored at index 0.

    The leg ends at the first close that goes AGAINST it, not at whichever
    window happens to be biggest. Taking the biggest lets the leg swallow the
    pullback and the continuation that came after it, which leaves the caller
    with no bars in which to observe either — the same failure the flag had.
    """
    if atr_value is None or atr_value <= 0 or len(candles) < 2:
        return None

    up = candles[1].close > candles[0].open
    end = 1
    for i in range(2, min(IMPULSE_MAX_BARS, len(candles))):
        progressed = (
            candles[i].close > candles[i - 1].close
            if up
            else candles[i].close < candles[i - 1].close
        )
        if not progressed:
            break
        end = i

    leg = candles[: end + 1]
    displacement = leg[-1].close - leg[0].open
    if abs(displacement) / atr_value < ZONE_MIN_DEPARTURE_ATR or (displacement > 0) is not up:
        return None

    return Impulse(
        start_index=0,
        end_index=end,
        up=up,
        size_atr=abs(displacement) / atr_value,
        high=max(c.high for c in leg),
        low=min(c.low for c in leg),
        detail=f"left {abs(displacement):.2f} ({abs(displacement) / atr_value:.2f} ATR) "
        f"{'up' if up else 'down'} over {len(leg)} bars",
    )


def find_zones(
    candles: list[Candle],
    atr_value: float | None,
    timeframe: str = "5m",
) -> list[Zone]:
    """Zones formed by a base that price departed from hard, newest first.

    Both kinds are detected: demand (base, then away upward) and supply (base,
    then away downward).
    """
    if atr_value is None or atr_value <= 0 or len(candles) < ZONE_MAX_BASE_BARS + 2:
        return []

    zones: list[Zone] = []
    for base_end in range(ZONE_MAX_BASE_BARS - 1, len(candles) - 1):
        departure = measure_departure(candles[base_end + 1 :], atr_value)
        if departure is None:
            continue

        base = candles[max(0, base_end - ZONE_MAX_BASE_BARS + 1) : base_end + 1]
        # The base must be balance, not part of the move. A big-bodied candle
        # here is the departure starting, and including it draws the zone
        # across the range price travelled rather than the area it left.
        if any(abs(c.close - c.open) > BASE_MAX_BODY_ATR * atr_value for c in base):
            continue
        top = max(c.high for c in base)
        bottom = min(c.low for c in base)
        if top <= bottom:
            continue

        kind = ZoneKind.DEMAND if departure.up else ZoneKind.SUPPLY
        zone = Zone(
            id=_zone_id(kind, base[-1], top, bottom, timeframe),
            kind=kind,
            top=top,
            bottom=bottom,
            base_index=base_end,
            departure_end_index=base_end + 1 + departure.end_index,
            departure_atr=departure.size_atr,
            touches=0,
            age=len(candles) - 1 - base_end,
            width_atr=(top - bottom) / atr_value,
            timeframe=timeframe,
        )
        zones.append(replace(zone, touches=count_zone_touches(candles, zone)))

    # Newest first, and only one zone per identity: overlapping bases can
    # otherwise produce several descriptions of the same area.
    unique: dict[str, Zone] = {}
    for zone in sorted(zones, key=lambda z: z.base_index, reverse=True):
        unique.setdefault(zone.id, zone)
    return list(unique.values())


@dataclass(frozen=True)
class ZoneScore:
    """A DESCRIPTION of a zone's attributes, not a prediction and not a rank.

    Nothing here compares one strategy with another or nominates a zone to
    trade. It reports how fresh the zone is, how hard price left it, and how
    tight it is, because those are facts about the zone the user can see for
    themselves on the chart. The weights are stated conventions so that the
    number means the same thing every time it is shown — and the funnel will
    later report how the USER's own results actually varied across them.
    """

    freshness: float
    departure: float
    tightness: float
    total: float
    detail: str


def score_zone(zone: Zone) -> ZoneScore:
    # Each component is clamped to 0..1 so no single attribute can dominate
    # by being extreme.
    freshness = 1.0 if zone.fresh else max(0.0, 1.0 - 0.34 * zone.touches)
    departure = min(1.0, zone.departure_atr / 3.0)
    tightness = min(1.0, 1.0 / zone.width_atr) if zone.width_atr > 0 else 0.0
    total = round((freshness + departure + tightness) / 3, 4)
    return ZoneScore(
        freshness=round(freshness, 4),
        departure=round(departure, 4),
        tightness=round(tightness, 4),
        total=total,
        detail=(
            f"freshness {freshness:.2f}, departure {departure:.2f}, tightness {tightness:.2f}"
        ),
    )


# --- Impulse and contraction -------------------------------------------------
#
# The flag/pennant shape is three things in order: a move that goes somewhere
# fast, a pause that goes nowhere, and a resumption. The two hard parts are
# both about not accepting a weaker thing in place of a stronger one — any
# sustained drift looks like an impulse if you don't require speed, and any
# quiet stretch looks like a flag if you don't require the range to have
# actually contracted RELATIVE to the impulse that preceded it.


#: An impulse is a fast move, so it is bounded in bars as well as in size. A
#: 2-ATR move that took thirty bars is a trend, not an impulse.
IMPULSE_MAX_BARS = 6
IMPULSE_MIN_ATR = 2.0

#: A pause needs enough bars to be a pause rather than one inside bar.
MIN_CONSOLIDATION_BARS = 3

#: The consolidation range as a fraction of the impulse range. Above this the
#: market is still moving, not resting.
CONTRACTION_MAX = 0.5

#: How much of the impulse the pause may give back. Past this it stops being
#: a flag: a move that retraces most of its impulse is a reversal being
#: described optimistically.
MAX_RETRACEMENT = 0.5


@dataclass(frozen=True)
class Impulse:
    start_index: int
    end_index: int
    #: True when the impulse went up.
    up: bool
    #: Displacement in ATR multiples — the comparable measure of "fast".
    size_atr: float
    high: float
    low: float
    detail: str

    @property
    def span(self) -> float:
        return self.high - self.low


def find_impulse(
    candles: list[Candle],
    atr_value: float | None,
    end_before: int | None = None,
) -> Impulse | None:
    """The most recent fast directional move, or None.

    Requires displacement of at least `IMPULSE_MIN_ATR` within at most
    `IMPULSE_MAX_BARS`, and that the majority of those bars pushed the same
    way — a violent two-way chop that happens to end higher is not an impulse,
    and the flag that follows it would mean nothing.

    `end_before` caps where the leg may end. The caller needs it because the
    newest leg is not always the interesting one: a search that always ends at
    the latest bar absorbs the pause into the impulse, and then there is
    nothing left to be the flag.
    """
    if atr_value is None or atr_value <= 0 or len(candles) < 2:
        return None

    last = len(candles) - 1 if end_before is None else min(end_before, len(candles) - 1)
    for end in range(last, 0, -1):
        for length in range(2, min(IMPULSE_MAX_BARS, end + 1) + 1):
            start = end - length + 1
            leg = candles[start : end + 1]
            displacement = leg[-1].close - leg[0].open
            if abs(displacement) / atr_value < IMPULSE_MIN_ATR:
                continue

            up = displacement > 0

            # An impulse ends at its extreme. Trailing bars that made no
            # further progress belong to whatever came next — usually the very
            # pause the caller is looking for — and leaving them inside the leg
            # both overstates its length and eats the flag.
            extreme_at = (
                max(range(len(leg)), key=lambda i: leg[i].close)
                if up
                else min(range(len(leg)), key=lambda i: leg[i].close)
            )
            # Note the separate name: assigning back to `end` here mutates the
            # loop variable and the NEXT candidate length is then measured
            # against a window that no longer exists.
            leg = leg[: extreme_at + 1]
            leg_end = start + extreme_at
            if len(leg) < 2:
                continue

            displacement = leg[-1].close - leg[0].open
            if abs(displacement) / atr_value < IMPULSE_MIN_ATR or (displacement > 0) is not up:
                continue

            agreeing = sum(1 for c in leg if (c.close > c.open) is up)
            if agreeing * 2 <= len(leg):
                continue

            return Impulse(
                start_index=start,
                end_index=leg_end,
                up=up,
                size_atr=abs(displacement) / atr_value,
                high=max(c.high for c in leg),
                low=min(c.low for c in leg),
                detail=(
                    f"{abs(displacement):.2f} ({abs(displacement) / atr_value:.2f} ATR) "
                    f"{'up' if up else 'down'} over {len(leg)} bars"
                ),
            )
    return None


@dataclass(frozen=True)
class Contraction:
    start_index: int
    bars: int
    high: float
    low: float
    #: Consolidation range as a fraction of the impulse range. Lower is tighter.
    ratio: float
    #: How much of the impulse the pause gave back, as a fraction.
    retracement: float
    detail: str


def find_contraction(candles: list[Candle], impulse: Impulse) -> Contraction | None:
    """The pause after an impulse, measured against that impulse.

    Both numbers are RELATIVE on purpose. An absolute "range under X points"
    would call the same consolidation tight on a quiet day and wide on a busy
    one, and the whole claim of a flag is that the market went quiet compared
    with how it had just been moving.
    """
    rest = candles[impulse.end_index + 1 :]
    if len(rest) < MIN_CONSOLIDATION_BARS or impulse.span <= 0:
        return None

    high = max(c.high for c in rest)
    low = min(c.low for c in rest)
    ratio = (high - low) / impulse.span
    retracement = (
        (impulse.high - low) / impulse.span if impulse.up else (high - impulse.low) / impulse.span
    )

    return Contraction(
        start_index=impulse.end_index + 1,
        bars=len(rest),
        high=high,
        low=low,
        ratio=ratio,
        retracement=retracement,
        detail=(
            f"{len(rest)} bars in {ratio * 100:.0f}% of the impulse range, "
            f"{retracement * 100:.0f}% retraced"
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
