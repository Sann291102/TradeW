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

from app.market.clock import minutes_to_close, session_key
from app.market.feed import Candle
from app.watch.indicators import (
    EXTENSION_MIN_ATR,
    MIN_LEVEL_AGE_BARS,
    MIN_LEVEL_TOUCHES,
    Level,
    LevelKind,
    Slope,
    atr,
    body_interaction,
    classify_deviation,
    classify_slope,
    count_vwap_tests,
    ema_of,
    find_bullish_reclaim,
    find_bullish_reclaims,
    find_levels,
    find_pullback,
    find_vwap_extreme,
    level_tolerance,
    vwap_deviation,
    vwap_series,
    vwap_slope,
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


# --- 9/21 EMA Pullback -------------------------------------------------------
#
# Reuses the SAME ema/slope primitives as EMA-7 rather than a private copy.
# This is deliberately not a crossover strategy: the cross is the least
# interesting moment. What it looks for is an established trend, a pullback
# into the pair, and then continuation.


def _ema_pair(candles: list[Candle]) -> tuple[list[float], list[float]]:
    return ema_of(candles, 9), ema_of(candles, 21)


def _ema_9_21_bullish(candles: list[Candle]) -> tuple[bool, str]:
    """Trend intact: the 9 is above the 21 and the 21 is not rolling over.

    Deliberately NOT "both rising". A pullback is precisely what bends the
    fast EMA down, so requiring the 9 to be rising at the same moment the
    strategy requires a retracement is close to self-contradictory — the
    setup could only ever confirm in the narrow window where the 9 had
    already turned back up but price had not yet closed above it.

    The slow EMA carries the trend; the fast one dipping IS the pullback, and
    `pullback_rejection_continuation` is what proves the trend resumed.
    """
    fast, slow = _ema_pair(candles)
    if not fast or not slow:
        return False, "not enough candles for a 9/21 EMA pair"

    a = atr(candles)
    fast_slope = classify_slope(fast, atr=a)
    slow_slope = classify_slope(slow, atr=a)
    aligned = fast[-1] > slow[-1] and slow_slope is not Slope.FALLING
    return aligned, (
        f"9 EMA {fast[-1]:.2f} ({fast_slope.value}) above 21 EMA {slow[-1]:.2f} ({slow_slope.value})"
        if aligned
        else f"9 EMA {fast[-1]:.2f} vs 21 EMA {slow[-1]:.2f} — trend not intact ({slow_slope.value} 21)"
    )


def _pullback_into_zone(candles: list[Candle]) -> tuple[bool, str]:
    fast, slow = _ema_pair(candles)
    pullback = find_pullback(candles, fast, slow, atr(candles))
    if pullback is None:
        return False, "no pullback from a swing high yet"
    # The retracement has to actually reach the pair — a dip that never
    # approaches the EMAs is not this setup.
    low = candles[pullback.low_index].low
    zone_top = max(fast[-1], slow[-1])
    if low > zone_top:
        return False, f"pullback low {low:.2f} never reached the 9/21 zone (top {zone_top:.2f})"
    return True, pullback.detail


def _pullback_continuation(candles: list[Candle]) -> tuple[bool, str]:
    """Rejection and continuation, not merely a touch: after the pullback low,
    price must close back above the fast EMA."""
    fast, slow = _ema_pair(candles)
    pullback = find_pullback(candles, fast, slow, atr(candles))
    if pullback is None:
        return False, "no pullback to continue from"

    offset = len(candles) - len(fast)
    for i in range(pullback.low_index + 1, len(candles)):
        if candles[i].close > fast[i - offset]:
            return True, f"closed {candles[i].close:.2f} back above the 9 EMA {fast[i - offset]:.2f}"
    return False, "waiting for a close back above the 9 EMA"


# --- Support / Resistance Flip -----------------------------------------------
#
# The whole strategy is ONE ordered story about ONE level: an established
# level breaks, price comes back to it FROM THE OTHER SIDE, and it holds.
# Resistance becomes support, or support becomes resistance.
#
# So the four conditions are not independent checks that happen to be about
# levels — they are four stages of the same sequence, and they all read from
# `_find_flip`. Evaluating them separately would let "a level broke" and "a
# level held" be true of two different levels on the same chart and call that
# a flip.


@dataclass(frozen=True)
class Flip:
    level: Level
    #: True when the break was upward (resistance -> support).
    upward: bool
    break_index: int
    retest_index: int | None
    hold_index: int | None
    detail: str

    @property
    def stage(self) -> int:
        return 3 if self.hold_index is not None else 2 if self.retest_index is not None else 1


def _find_flip(candles: list[Candle]) -> Flip | None:
    """The most advanced flip in progress, or None.

    "Most advanced" rather than "most recent": a completed flip on an older
    level is more informative than a fresh break that has not been retested,
    and reporting the fresh one would make a finished setup look like it had
    regressed to waiting.
    """
    a = atr(candles)
    levels = find_levels(candles, a)
    tolerance = level_tolerance(candles, a)
    if not levels or tolerance <= 0:
        return None

    best: Flip | None = None
    for level in levels:
        if level.age(len(candles)) < MIN_LEVEL_AGE_BARS:
            continue

        # The break direction is fixed by what the level IS. Resistance is
        # broken upward and support downward — price that has been below a
        # resistance all along has not "broken it downward", it has simply
        # stayed where it was, and treating that as a break would have every
        # quiet bar under a level count as one.
        upward = level.kind is LevelKind.RESISTANCE

        # The break also has to happen AFTER the level was formed. A candle
        # that helped establish the level cannot be the one that broke it.
        for i in range(level.last_index + 1, len(candles)):
            broke = (
                candles[i].close > level.price + tolerance
                if upward
                else candles[i].close < level.price - tolerance
            )
            if not broke:
                continue

            retest_index = None
            hold_index = None
            for j in range(i + 1, len(candles)):
                if retest_index is None:
                    # Back to the level from the side price broke to.
                    reached = (
                        candles[j].low <= level.price + tolerance
                        if upward
                        else candles[j].high >= level.price - tolerance
                    )
                    if reached:
                        retest_index = j
                    continue
                # It holds when a LATER candle closes away from the level
                # again in the break direction. A candle that closes through
                # it is the flip failing, not the flip completing.
                if upward and candles[j].close > level.price + tolerance:
                    hold_index = j
                    break
                if not upward and candles[j].close < level.price - tolerance:
                    hold_index = j
                    break

            became = "support" if upward else "resistance"
            flip = Flip(
                level=level,
                upward=upward,
                break_index=i,
                retest_index=retest_index,
                hold_index=hold_index,
                detail=(
                    f"{level.kind.value} {level.price:.2f} "
                    f"({level.touches} touches, {level.age(len(candles))} bars old) "
                    f"broke {'above' if upward else 'below'}"
                    + ("" if retest_index is None else ", retested")
                    + ("" if hold_index is None else f" and held as {became}")
                ),
            )
            if best is None or flip.stage > best.stage:
                best = flip
            break

    return best


def _established_level(candles: list[Candle]) -> tuple[bool, str]:
    """There is a level worth watching at all: touched more than once and old
    enough to have been respected rather than merely printed."""
    a = atr(candles)
    levels = [lvl for lvl in find_levels(candles, a) if lvl.age(len(candles)) >= MIN_LEVEL_AGE_BARS]
    if not levels:
        return False, f"no level with {MIN_LEVEL_TOUCHES}+ touches and {MIN_LEVEL_AGE_BARS}+ bars of age"
    newest = levels[0]
    return True, (
        f"{newest.kind.value} at {newest.price:.2f} — {newest.touches} touches, "
        f"{newest.age(len(candles))} bars old"
    )


def _level_broke(candles: list[Candle]) -> tuple[bool, str]:
    flip = _find_flip(candles)
    if flip is None:
        return False, "no established level has been broken"
    return True, flip.detail


def _flip_retested(candles: list[Candle]) -> tuple[bool, str]:
    flip = _find_flip(candles)
    if flip is None:
        return False, "no break to retest"
    if flip.retest_index is None:
        return False, f"waiting for price to return to {flip.level.price:.2f} from the other side"
    return True, flip.detail


def _flip_held(candles: list[Candle]) -> tuple[bool, str]:
    """The flip completing: the old level did its new job. Until this closes,
    the level has only been broken and revisited, which is also what a failed
    break looks like."""
    flip = _find_flip(candles)
    if flip is None:
        return False, "no flip in progress"
    if flip.retest_index is None:
        return False, "the break has not been retested yet"
    if flip.hold_index is None:
        became = "support" if flip.upward else "resistance"
        return False, f"waiting for {flip.level.price:.2f} to hold as {became}"
    return True, flip.detail


def measure_flip(candles: list[Candle]) -> dict | None:
    """Flip measurements for the observation record: which level, how old it
    was, how many touches it had, and how far the sequence got. Level age and
    touch count are what the funnel will eventually split on — whether THIS
    user's flips work better on older, more-tested levels is a question only
    their own history can answer."""
    flip = _find_flip(closed_candles(candles))
    if flip is None:
        return None
    return {
        "price": round(flip.level.price, 4),
        "kind": flip.level.kind.value,
        "touches": flip.level.touches,
        "ageBars": flip.level.age(len(closed_candles(candles))),
        "direction": "upward" if flip.upward else "downward",
        "stage": flip.stage,
        "retested": flip.retest_index is not None,
        "held": flip.hold_index is not None,
    }


# --- VWAP --------------------------------------------------------------------
#
# TWO strategies share these primitives and nothing else. VWAP Bounce is a
# CONTINUATION setup: the trend is intact, price comes back to VWAP, rejects
# it, and carries on. EOD Mean Reversion is the opposite claim: price is
# stretched away from VWAP late in the day and returns to it. Merging them
# into one "VWAP strategy" would produce a funnel that averaged a
# trend-following setup with a fade, and the resulting number would describe
# neither. They stay separate all the way down to their conditions.
#
# Every VWAP condition below fails CLOSED when the instrument reports no
# volume (vwap_series returns []), because a VWAP without volume is not a VWAP.


def _vwap_context(candles: list[Candle]) -> tuple[list[float], float | None]:
    return vwap_series(candles), atr(candles)


def _vwap_available(candles: list[Candle]) -> tuple[bool, str]:
    values, _ = _vwap_context(candles)
    if not values:
        return False, "no VWAP: this instrument reports no volume for the session"
    return True, f"VWAP {values[-1]:.2f}"


def _vwap_trend_established(candles: list[Candle]) -> tuple[bool, str]:
    """Context for the BOUNCE only: VWAP has a direction, so a return to it is
    a pullback within a trend rather than a drift inside a range."""
    values, a = _vwap_context(candles)
    if not values:
        return False, "no VWAP: this instrument reports no volume for the session"
    slope = vwap_slope(values, atr_value=a)
    if slope is Slope.FLAT:
        return False, f"VWAP {values[-1]:.2f} is flat — no trend to continue"
    above = candles[-1].close > values[-1]
    agrees = (slope is Slope.RISING and above) or (slope is Slope.FALLING and not above)
    return agrees, (
        f"VWAP {slope.value} at {values[-1]:.2f}, price {'above' if above else 'below'} it"
        if agrees
        else f"VWAP {slope.value} at {values[-1]:.2f} but price is on the other side"
    )


def _vwap_interaction(candles: list[Candle]) -> tuple[bool, str]:
    """Approach and interaction: a candle BODY has reached VWAP this session.
    Body, not wick — the same distinction the EMA-7 reclaim rests on."""
    values, _ = _vwap_context(candles)
    if not values:
        return False, "no VWAP: this instrument reports no volume for the session"
    offset = len(candles) - len(values)
    for i in range(len(candles) - 1, offset - 1, -1):
        if body_interaction(candles[i], values[i - offset]).touched_body:
            tests = count_vwap_tests(candles, values)
            return True, f"body reached VWAP {values[i - offset]:.2f} — {tests.detail}"
    return False, "price has not traded back into VWAP"


def _vwap_rejection(candles: list[Candle]) -> tuple[bool, str]:
    """Rejection / reclaim: after touching VWAP, a candle closed back onto the
    side price came from. A touch that closes through is the opposite event."""
    values, _ = _vwap_context(candles)
    if not values:
        return False, "no VWAP: this instrument reports no volume for the session"
    offset = len(candles) - len(values)
    for i in range(offset, len(candles)):
        level = values[i - offset]
        interaction = body_interaction(candles[i], level)
        if not interaction.touched_body:
            continue
        for j in range(i + 1, len(candles)):
            later, later_vwap = candles[j], values[j - offset]
            if later.close > later_vwap and candles[i].open > level:
                return True, f"closed {later.close:.2f} back above VWAP {later_vwap:.2f}"
            if later.close < later_vwap and candles[i].open < level:
                return True, f"closed {later.close:.2f} back below VWAP {later_vwap:.2f}"
    return False, "waiting for a close back onto the side price approached from"


def _vwap_continuation(candles: list[Candle]) -> tuple[bool, str]:
    """Confirmation that the bounce carried: price closed beyond the extreme of
    the candle that interacted with VWAP, in the direction it rejected."""
    values, _ = _vwap_context(candles)
    if not values:
        return False, "no VWAP: this instrument reports no volume for the session"
    offset = len(candles) - len(values)
    for i in range(offset, len(candles)):
        level = values[i - offset]
        if not body_interaction(candles[i], level).touched_body:
            continue
        upward = candles[i].open > level
        trigger = candles[i].high if upward else candles[i].low
        for later in candles[i + 1 :]:
            if upward and later.close > trigger:
                return True, f"closed {later.close:.2f} above the VWAP-test high {trigger:.2f}"
            if not upward and later.close < trigger:
                return True, f"closed {later.close:.2f} below the VWAP-test low {trigger:.2f}"
    return False, "no close beyond the VWAP-test candle yet"


# --- EOD VWAP Mean Reversion -------------------------------------------------


#: How late "late in the session" is. 90 minutes puts the window at 14:00 IST.
LATE_SESSION_MINUTES = 90


def _late_in_session(candles: list[Candle]) -> tuple[bool, str]:
    """Session clock. Read off the last CLOSED candle rather than wall-clock
    time so a replay of yesterday's candles evaluates the same way it did
    live — the condition describes the data, not when it was looked at."""
    if not candles:
        return False, "no candles"
    remaining = minutes_to_close(candles[-1].timestamp)
    if remaining < 0:
        return False, "session already closed"
    inside = remaining <= LATE_SESSION_MINUTES
    return inside, f"{remaining} minutes to the close"


def _vwap_extended(candles: list[Candle]) -> tuple[bool, str]:
    values, a = _vwap_context(candles)
    if not values:
        return False, "no VWAP: this instrument reports no volume for the session"
    if a is None:
        return False, "not enough candles for an ATR, so deviation is not comparable"
    extreme = find_vwap_extreme(candles, values, a)
    if extreme is None:
        return False, "no measurable deviation from VWAP"
    met = abs(extreme.deviation_atr) >= EXTENSION_MIN_ATR
    return met, (
        extreme.detail if met else f"only {extreme.detail} (needs {EXTENSION_MIN_ATR} ATR)"
    )


def _vwap_exhaustion(candles: list[Candle]) -> tuple[bool, str]:
    """After the stretch, a candle closes back TOWARD VWAP — the extension
    stopped extending. Not yet the return; this is the turn."""
    values, a = _vwap_context(candles)
    if not values or a is None:
        return False, "no VWAP/ATR available for this instrument"
    extreme = find_vwap_extreme(candles, values, a)
    if extreme is None or abs(extreme.deviation_atr) < EXTENSION_MIN_ATR:
        return False, "no qualifying extension to reverse from"

    offset = len(candles) - len(values)
    for i in range(extreme.index + 1, len(candles)):
        level = values[i - offset]
        moved_back = vwap_deviation(candles[i].close, level, a)
        if moved_back is None:
            continue
        if abs(moved_back) < abs(extreme.deviation_atr):
            return True, f"closed back to {abs(moved_back):.2f} ATR from {extreme.detail}"
    return False, "price has not closed back toward VWAP yet"


def _vwap_return(candles: list[Candle]) -> tuple[bool, str]:
    """The reversion completing: price trades back to VWAP itself."""
    values, a = _vwap_context(candles)
    if not values or a is None:
        return False, "no VWAP/ATR available for this instrument"
    extreme = find_vwap_extreme(candles, values, a)
    if extreme is None or abs(extreme.deviation_atr) < EXTENSION_MIN_ATR:
        return False, "no qualifying extension to revert from"
    offset = len(candles) - len(values)
    for i in range(extreme.index + 1, len(candles)):
        if body_interaction(candles[i], values[i - offset]).touched_wick:
            return True, f"returned to VWAP {values[i - offset]:.2f}"
    return False, "price has not reached VWAP again"


def measure_vwap(candles: list[Candle]) -> dict | None:
    """VWAP measurements for the observation record.

    Recorded so the funnel can later split THIS user's results by test ordinal
    (1st / 2nd / repeated) and by deviation bucket. The buckets are stated
    conventions; the expectancy, MAE and MFE inside them come from the user's
    own watch history and nowhere else.
    """
    bars = closed_candles(candles)
    values = vwap_series(bars)
    if not values:
        return None
    a = atr(bars)
    tests = count_vwap_tests(bars, values)
    extreme = find_vwap_extreme(bars, values, a)
    deviation = vwap_deviation(bars[-1].close, values[-1], a)
    return {
        "vwap": round(values[-1], 4),
        "slope": vwap_slope(values, atr_value=a).value,
        "testCount": tests.count,
        "testOrdinal": tests.ordinal.value,
        "deviationAtr": round(deviation, 4) if deviation is not None else None,
        "deviationBucket": classify_deviation(deviation),
        "maxDeviationAtr": round(extreme.deviation_atr, 4) if extreme else None,
        "maxDeviationBucket": classify_deviation(extreme.deviation_atr) if extreme else None,
    }


def measure_pullback(candles: list[Candle]) -> dict | None:
    """Pullback measurements for the observation record, so the performance
    engine can eventually split this user's results by shallow/normal/deep.
    Reported in ATR and spread multiples — a raw point distance would not be
    comparable across symbols or volatility regimes."""
    bars = closed_candles(candles)
    fast, slow = _ema_pair(bars)
    pullback = find_pullback(bars, fast, slow, atr(bars))
    if pullback is None:
        return None
    return {
        "depth": round(pullback.depth, 4),
        "depthAtr": round(pullback.depth_atr, 4) if pullback.depth_atr is not None else None,
        "depthSpread": round(pullback.depth_spread, 4) if pullback.depth_spread is not None else None,
        "classification": pullback.classification.value,
    }


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
        elif condition == "ema_9_21_bullish_alignment":
            met, detail = _ema_9_21_bullish(bars)
        elif condition == "pullback_into_ema_zone":
            met, detail = _pullback_into_zone(bars)
        elif condition == "pullback_rejection_continuation":
            met, detail = _pullback_continuation(bars)
        # Support / Resistance Flip — four stages of ONE sequence on ONE level.
        elif condition == "established_level_present":
            met, detail = _established_level(bars)
        elif condition == "level_break_close":
            met, detail = _level_broke(bars)
        elif condition == "level_flip_retest":
            met, detail = _flip_retested(bars)
        elif condition == "level_flip_holds":
            met, detail = _flip_held(bars)
        # VWAP Bounce / Rejection — a continuation setup.
        elif condition == "vwap_available":
            met, detail = _vwap_available(bars)
        elif condition == "vwap_trend_established":
            met, detail = _vwap_trend_established(bars)
        elif condition == "vwap_body_interaction":
            met, detail = _vwap_interaction(bars)
        elif condition == "vwap_rejection_reclaim":
            met, detail = _vwap_rejection(bars)
        elif condition == "vwap_continuation":
            met, detail = _vwap_continuation(bars)
        # EOD VWAP Mean Reversion — a different strategy, not a mode of the above.
        elif condition == "late_session_window":
            met, detail = _late_in_session(bars)
        elif condition == "vwap_extension_beyond_atr":
            met, detail = _vwap_extended(bars)
        elif condition == "vwap_exhaustion_reversal":
            met, detail = _vwap_exhaustion(bars)
        elif condition == "vwap_return_to_level":
            met, detail = _vwap_return(bars)
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
