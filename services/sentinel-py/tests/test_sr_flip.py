"""Level detection, level age, and the Support / Resistance Flip.

The strategy is one ordered story about ONE level. The tests that matter here
are the ones proving the sequence cannot be faked: a break of one level and a
hold of a different level is not a flip, and a break that fails back through
is the opposite of a flip rather than a partial one.
"""

from app.strategy.templates import get_template
from app.watch.evaluator import _find_flip, evaluate, measure_flip
from app.watch.indicators import (
    MIN_LEVEL_AGE_BARS,
    LevelKind,
    find_levels,
    find_swing_pivots,
    level_tolerance,
)
from tests.conftest import candle, forming_tail


def _rules() -> list[dict]:
    template = get_template("sr_flip")
    assert template is not None and template.available
    return template.rules["rules"]


def _outcome(candles) -> dict[str, bool]:
    result = evaluate(_rules(), forming_tail(candles))
    return {r.name: r.met for r in result.rules}


def _flat(n: int, price: float = 100.0, start: int = 0, step: int = 15):
    return [candle(start + i * step, price, price + 0.5, price - 0.5, price, volume=1000) for i in range(n)]


# --- pivots and levels -------------------------------------------------------


def test_a_pivot_needs_bars_on_both_sides():
    """The last bars can never be pivots. A 'pivot' confirmed by bars that
    have not printed yet would be a guess."""
    bars = _flat(3) + [candle(45, 100, 120, 99, 100)] + _flat(3, start=60)
    highs, _ = find_swing_pivots(bars)
    assert 3 in highs
    assert all(i < len(bars) - 2 for i in highs)


def test_one_pivot_is_a_swing_point_not_a_level():
    bars = _flat(4) + [candle(60, 100, 130, 99, 100)] + _flat(4, start=75)
    prices = [lvl.price for lvl in find_levels(bars, atr_value=1.0)]
    assert 130 not in prices


def test_two_touches_at_the_same_price_make_a_level():
    bars = (
        _flat(3)
        + [candle(45, 100, 130, 99, 100)]
        + _flat(3, start=60)
        + [candle(105, 100, 130, 99, 100)]
        + _flat(3, start=120)
    )
    levels = find_levels(bars, atr_value=1.0)
    resistance = [lvl for lvl in levels if lvl.kind is LevelKind.RESISTANCE and abs(lvl.price - 130) < 1]
    assert resistance and resistance[0].touches == 2


def test_level_age_counts_from_the_first_touch_not_the_last():
    """A level is as old as the first time the market turned there. Dating it
    from the most recent touch would make every re-tested level look fresh."""
    bars = (
        _flat(3)
        + [candle(45, 100, 130, 99, 100)]
        + _flat(8, start=60)
        + [candle(195, 100, 130, 99, 100)]
        + _flat(3, start=210)
    )
    level = next(lvl for lvl in find_levels(bars, atr_value=1.0) if abs(lvl.price - 130) < 1)
    assert level.first_index == 3
    assert level.age(len(bars)) == len(bars) - 1 - 3


def test_level_tolerance_is_atr_scaled():
    bars = _flat(3)
    assert level_tolerance(bars, 8.0) > level_tolerance(bars, 1.0)


# --- the flip sequence -------------------------------------------------------


def _flip_series(hold: bool = True, retest: bool = True):
    """Resistance at 130 formed twice, broken upward, retested from above, and
    (optionally) holding."""
    bars = (
        _flat(3)
        + [candle(45, 100, 130, 99, 100)]  # touch 1
        + _flat(6, start=60)
        + [candle(150, 100, 130, 99, 100)]  # touch 2
        + _flat(6, start=165)
    )
    bars.append(candle(255, 100, 140, 100, 138))  # break above
    if retest:
        bars.append(candle(270, 138, 139, 129, 131))  # back to the level
    if hold:
        bars.append(candle(285, 131, 145, 131, 143))  # holds as support
    return bars


def test_the_full_flip_confirms():
    outcome = _outcome(_flip_series())
    assert outcome["established_level_present"] is True
    assert outcome["level_break_close"] is True
    assert outcome["level_flip_retest"] is True
    assert outcome["level_flip_holds"] is True


def test_a_break_without_a_retest_is_not_a_flip():
    outcome = _outcome(_flip_series(retest=False, hold=False))
    assert outcome["level_break_close"] is True
    assert outcome["level_flip_retest"] is False
    assert outcome["level_flip_holds"] is False


def test_a_retest_that_has_not_held_yet_is_still_incomplete():
    outcome = _outcome(_flip_series(hold=False))
    assert outcome["level_flip_retest"] is True
    assert outcome["level_flip_holds"] is False


def test_a_break_that_fails_back_through_does_not_hold():
    """The failure case is the whole reason 'holds' is a separate condition:
    a break and a return look identical until the level either works or
    doesn't."""
    bars = _flip_series(hold=False)
    bars.append(candle(285, 131, 132, 110, 112))  # straight back through
    outcome = _outcome(bars)
    assert outcome["level_flip_retest"] is True
    assert outcome["level_flip_holds"] is False


def test_a_young_level_is_not_used():
    """A level that formed three bars ago has not been established, it has
    just happened."""
    bars = (
        [candle(0, 100, 130, 99, 100)]
        + _flat(2, start=15)
        + [candle(45, 100, 130, 99, 100)]
        + _flat(2, start=60)
        + [candle(90, 100, 140, 100, 138)]
    )
    assert _find_flip(bars) is None
    assert _outcome(bars)["established_level_present"] is False


def test_the_four_stages_all_describe_the_same_level():
    """A break of one level and a hold of another is not a flip. Every stage
    reads from the same `_find_flip` result, so they cannot disagree."""
    flip = _find_flip(_flip_series())
    assert flip is not None
    assert flip.break_index < flip.retest_index < flip.hold_index
    assert abs(flip.level.price - 130) < 2


def test_a_flat_tape_produces_no_flip():
    assert _find_flip(_flat(40)) is None


def test_downward_flips_are_supported_too():
    """Support becoming resistance is the same object mirrored — the template
    is declared 'both' and has to mean it."""
    bars = (
        _flat(3, price=140)
        + [candle(45, 140, 141, 110, 140)]  # touch 1 at 110
        + _flat(6, start=60, price=140)
        + [candle(150, 140, 141, 110, 140)]  # touch 2
        + _flat(6, start=165, price=140)
    )
    bars.append(candle(255, 140, 140, 100, 102))  # break below
    bars.append(candle(270, 102, 111, 101, 109))  # back up to the level
    bars.append(candle(285, 109, 110, 95, 97))  # holds as resistance
    outcome = _outcome(bars)
    assert outcome["level_flip_holds"] is True
    flip = _find_flip(forming_tail(bars)[:-1])
    assert flip is not None and flip.upward is False


# --- observation record ------------------------------------------------------


def test_measure_flip_records_level_age_and_touches():
    measured = measure_flip(forming_tail(_flip_series()))
    assert measured is not None
    assert measured["touches"] >= 2
    assert measured["ageBars"] >= MIN_LEVEL_AGE_BARS
    assert measured["stage"] == 3
    assert measured["held"] is True


def test_measure_flip_is_none_when_nothing_flipped():
    assert measure_flip(forming_tail(_flat(40))) is None


# --- catalogue ---------------------------------------------------------------


def test_sr_flip_is_adoptable():
    template = get_template("sr_flip")
    assert template.available is True
    assert template.missing == []
