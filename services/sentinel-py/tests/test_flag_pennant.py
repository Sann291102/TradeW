"""Impulse detection, volatility contraction, and the flag/pennant.

Both primitives exist to refuse a weaker thing in place of a stronger one.
Any sustained drift looks like an impulse if speed is not required, and any
quiet stretch looks like a flag if the range is not compared with the impulse
that preceded it. The tests below are mostly about those refusals.
"""

from app.strategy.templates import get_template
from app.watch.evaluator import _find_flag, evaluate, measure_flag
from app.watch.indicators import (
    CONTRACTION_MAX,
    IMPULSE_MIN_ATR,
    atr,
    find_contraction,
    find_impulse,
)
from tests.conftest import candle, forming_tail


def _rules() -> list[dict]:
    template = get_template("flag_pennant")
    assert template is not None and template.available
    return template.rules["rules"]


def _outcome(candles) -> dict[str, bool]:
    result = evaluate(_rules(), forming_tail(candles))
    return {r.name: r.met for r in result.rules}


def _base(n: int = 20, price: float = 100.0, start: int = 0):
    """Enough quiet bars to give ATR something to work with."""
    return [
        candle(start + i * 5, price, price + 1, price - 1, price, volume=1000) for i in range(n)
    ]


def _impulse_up(start: int, frm: float = 100.0):
    return [
        candle(start, frm, frm + 4, frm - 0.5, frm + 4, volume=2000),
        candle(start + 5, frm + 4, frm + 9, frm + 3.5, frm + 9, volume=2000),
        candle(start + 10, frm + 9, frm + 14, frm + 8.5, frm + 14, volume=2000),
    ]


def _flag_series(tight: bool = True, breakout: bool = True, deep: bool = False):
    bars = _base()
    bars += _impulse_up(100)
    top = 114.0
    if deep:
        # Gives back most of the move — a reversal, not a rest.
        pause = [(top - 10, top - 9), (top - 11, top - 10), (top - 12, top - 11)]
    elif tight:
        pause = [(top - 2, top - 1), (top - 2.5, top - 1.5), (top - 2, top - 1)]
    else:
        # Still swinging around: no contraction.
        pause = [(top - 9, top), (top - 8, top - 1), (top - 9, top)]
    for i, (low, high) in enumerate(pause):
        bars.append(candle(115 + i * 5, low + 0.2, high, low, high - 0.2, volume=900))
    if breakout:
        bars.append(candle(135, top, top + 6, top - 1, top + 5, volume=2500))
    return bars


# --- impulse -----------------------------------------------------------------


def test_an_impulse_needs_speed_not_just_distance():
    """A 2-ATR move that took thirty bars is a trend, not an impulse."""
    slow = [candle(i * 5, 100 + i * 0.4, 100.5 + i * 0.4, 99.5 + i * 0.4, 100 + i * 0.4) for i in range(30)]
    assert find_impulse(slow, atr(slow)) is None


def test_a_fast_directional_move_is_an_impulse():
    bars = _base() + _impulse_up(100)
    impulse = find_impulse(bars, atr(bars))
    assert impulse is not None
    assert impulse.up is True
    assert impulse.size_atr >= IMPULSE_MIN_ATR


def test_two_way_chop_that_ends_higher_is_not_an_impulse():
    """The flag that followed it would mean nothing."""
    bars = _base()
    bars += [
        candle(100, 100, 108, 99, 107, volume=2000),
        candle(105, 107, 108, 98, 99, volume=2000),
        candle(110, 99, 116, 98, 115, volume=2000),
        candle(115, 115, 116, 106, 107, volume=2000),
    ]
    impulse = find_impulse(bars, atr(bars))
    assert impulse is None or impulse.end_index != len(bars) - 1


def test_no_impulse_without_an_atr_to_measure_against():
    assert find_impulse(_base(3), None) is None


# --- contraction -------------------------------------------------------------


def test_contraction_is_measured_against_the_impulse_not_a_fixed_range():
    """An absolute 'range under X points' would call the same consolidation
    tight on a quiet day and wide on a busy one."""
    bars = _flag_series(breakout=False)
    impulse = find_impulse(bars, atr(bars))
    contraction = find_contraction(bars, impulse)
    assert contraction is not None
    assert contraction.ratio < CONTRACTION_MAX


def test_a_pause_that_is_still_swinging_is_not_a_contraction():
    outcome = _outcome(_flag_series(tight=False, breakout=False))
    assert outcome["impulse_leg"] is True
    assert outcome["volatility_contraction"] is False


def test_a_pause_that_gives_back_most_of_the_impulse_is_a_reversal():
    outcome = _outcome(_flag_series(deep=True, breakout=False))
    assert outcome["volatility_contraction"] is False


def test_one_inside_bar_is_not_a_pause():
    bars = _base() + _impulse_up(100)
    bars.append(candle(115, 113, 114, 112, 113, volume=900))
    outcome = _outcome(bars)
    assert outcome["volatility_contraction"] is False


# --- the full shape ----------------------------------------------------------


def test_the_full_flag_confirms():
    outcome = _outcome(_flag_series())
    assert outcome["impulse_leg"] is True
    assert outcome["volatility_contraction"] is True
    assert outcome["flag_breakout_continuation"] is True


def test_a_flag_without_a_breakout_is_still_waiting():
    outcome = _outcome(_flag_series(breakout=False))
    assert outcome["volatility_contraction"] is True
    assert outcome["flag_breakout_continuation"] is False


def test_a_break_the_wrong_way_is_not_a_continuation():
    """A close out the other side is the flag failing, not the flag
    completing."""
    bars = _flag_series(breakout=False)
    bars.append(candle(135, 112, 113, 104, 105, volume=2500))
    outcome = _outcome(bars)
    assert outcome["flag_breakout_continuation"] is False


def test_a_quiet_tape_produces_no_flag():
    assert _find_flag(_base(40)) is None


# --- observation record ------------------------------------------------------


def test_measure_flag_records_impulse_size_and_tightness():
    measured = measure_flag(forming_tail(_flag_series()))
    assert measured is not None
    assert measured["impulseAtr"] >= IMPULSE_MIN_ATR
    assert 0 < measured["contractionRatio"] < CONTRACTION_MAX
    assert measured["direction"] == "up"
    assert measured["brokeOut"] is True


def test_measure_flag_is_none_on_a_quiet_tape():
    assert measure_flag(forming_tail(_base(40))) is None


# --- catalogue ---------------------------------------------------------------


def test_flag_pennant_is_adoptable():
    template = get_template("flag_pennant")
    assert template.available is True
    assert template.missing == []
