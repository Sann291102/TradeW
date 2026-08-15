"""Liquidity Sweep + Fair Value Gap — seven stages of ONE event.

The correctness property under test is that the stages describe the same
event. Detected independently, "a pool was swept" could be about this
morning's low, "displacement" about an unrelated afternoon move and "an FVG
exists" about a gap on the other side of the chart, and the strategy would
confirm on a chart where none of it happened together.
"""

from app.strategy.templates import get_template
from app.watch.evaluator import _find_liquidity_event, evaluate, measure_liquidity
from app.watch.indicators import (
    atr,
    find_fair_value_gaps,
    find_structure_shift,
    find_sweeps,
)
from tests.conftest import candle, forming_tail


def _rules() -> list[dict]:
    template = get_template("liquidity_sweep_fvg")
    assert template is not None and template.available
    return template.rules["rules"]


def _outcome(candles) -> dict[str, bool]:
    result = evaluate(_rules(), forming_tail(candles))
    return {r.name: r.met for r in result.rules}


def _sequence(
    sweep: bool = True,
    displace: bool = True,
    gap: bool = True,
    retrace: bool = True,
    continues: bool = True,
):
    """Equal lows at 98 form a pool; price takes them and closes back, runs
    away leaving a gap, returns into it, then carries on."""
    def quiet(i: int, low: float = 99.5):
        return candle(i * 5, 100, 101, low, 100, volume=1000)

    # Two equal lows at 98, each a proper swing pivot (two bars either side),
    # on enough history for an ATR to exist at all.
    bars = [quiet(i) for i in range(3)]
    bars.append(candle(15, 100, 101, 98, 100, volume=1000))  # low 1
    bars += [quiet(i) for i in range(4, 9)]
    bars.append(candle(45, 100, 101, 98, 100, volume=1000))  # low 2 — the pool
    bars += [quiet(i) for i in range(10, 12)]
    bars.append(candle(60, 100, 103, 99.5, 102, volume=1000))  # the swing high
    bars += [quiet(i) for i in range(13, 16)]
    if not sweep:
        return bars

    # Takes the 98s and closes back above them.
    bars.append(candle(80, 100, 101, 94, 100.5, volume=2500))
    if not displace:
        bars += [candle(85 + i * 5, 100.5, 101, 100, 100.5, volume=900) for i in range(4)]
        return bars

    if gap:
        # Three-candle imbalance: candle 41's high < candle 43's low.
        bars.append(candle(85, 100.5, 104, 100.5, 104, volume=2500))
        bars.append(candle(90, 104, 111, 104, 110, volume=2500))
        bars.append(candle(95, 110, 116, 109, 115, volume=2500))  # low 109 > 104
    else:
        bars.append(candle(85, 100.5, 105, 100.5, 104, volume=2500))
        bars.append(candle(90, 104, 110, 100.5, 109, volume=2500))
        bars.append(candle(95, 109, 116, 104, 115, volume=2500))  # overlaps: no gap

    if retrace:
        bars.append(candle(100, 115, 115.5, 105, 106, volume=1500))  # back into the gap
    if continues:
        bars.append(candle(105, 106, 118, 105.5, 117, volume=2500))  # beyond the extreme
    return bars


# --- the pieces --------------------------------------------------------------


def test_a_sweep_takes_the_pool_it_does_not_break_it():
    bars = _sequence()
    sweeps = find_sweeps(bars, atr(bars))
    assert sweeps
    assert sweeps[0].bullish is True
    assert sweeps[0].penetration_atr > 0


def test_a_close_beyond_the_pool_is_a_break_not_a_sweep():
    """The two imply opposite directions, so confusing them would invert the
    setup."""
    bars = _sequence(sweep=False)
    bars.append(candle(80, 100, 101, 94, 95, volume=2500))  # closes BELOW the pool
    assert find_sweeps(bars, atr(bars)) == []


def test_a_bullish_gap_is_a_band_that_never_traded():
    bars = [
        candle(0, 100, 101, 99, 100),
        candle(5, 100, 108, 100, 107),
        candle(10, 107, 110, 103, 109),  # low 103 > 101
    ]
    gaps = find_fair_value_gaps(bars, bullish=True)
    assert len(gaps) == 1
    assert gaps[0].bottom == 101 and gaps[0].top == 103


def test_gaps_can_be_restricted_to_one_move():
    """A gap from an hour earlier is not the imbalance this displacement
    created."""
    bars = _sequence()
    everything = find_fair_value_gaps(bars, bullish=True)
    just_the_move = find_fair_value_gaps(bars, bullish=True, start=16, end=19)
    assert len(just_the_move) <= len(everything)


def test_structure_shift_needs_the_prior_swing_to_be_taken():
    bars = _sequence()
    swept = find_sweeps(bars, atr(bars))[0].index
    shift = find_structure_shift(bars, from_index=swept, bullish=True)
    assert shift is not None and shift > swept


def test_no_structure_shift_without_a_prior_swing():
    flat = [candle(i * 5, 100, 101, 99, 100) for i in range(4)]
    assert find_structure_shift(flat, from_index=1, bullish=True) is None


# --- the lifecycle -----------------------------------------------------------


def test_the_full_sequence_confirms():
    outcome = _outcome(_sequence())
    assert outcome["liquidity_pool_swept"] is True
    assert outcome["displacement_from_sweep"] is True
    assert outcome["structure_shift"] is True
    assert outcome["fair_value_gap_left"] is True
    assert outcome["fvg_retrace"] is True
    assert outcome["liquidity_continuation"] is True


def test_a_sweep_that_goes_nowhere_stops_at_stage_two():
    """A level taken without consequence is a very common and very different
    event from a level taken that displaces."""
    event = _find_liquidity_event(_sequence(displace=False))
    assert event is not None
    assert event.stage == 2
    outcome = _outcome(_sequence(displace=False))
    assert outcome["liquidity_pool_swept"] is True
    assert outcome["displacement_from_sweep"] is False


def test_a_displacement_without_a_gap_does_not_confirm():
    outcome = _outcome(_sequence(gap=False, retrace=False, continues=False))
    assert outcome["displacement_from_sweep"] is True
    assert outcome["fair_value_gap_left"] is False
    assert outcome["fvg_retrace"] is False


def test_an_unfilled_gap_is_still_waiting():
    outcome = _outcome(_sequence(retrace=False, continues=False))
    assert outcome["fair_value_gap_left"] is True
    assert outcome["fvg_retrace"] is False
    assert outcome["liquidity_continuation"] is False


def test_a_retrace_without_continuation_is_incomplete():
    outcome = _outcome(_sequence(continues=False))
    assert outcome["fvg_retrace"] is True
    assert outcome["liquidity_continuation"] is False


def test_every_stage_describes_the_same_sweep():
    """The whole point of one canonical detection result."""
    event = _find_liquidity_event(_sequence())
    assert event is not None
    assert event.displacement is not None and event.fvg is not None
    assert event.sweep.index < event.fvg.index
    assert event.fvg.index < event.retrace_index < event.continuation_index
    assert event.stage == 7


def test_a_quiet_tape_produces_no_event():
    flat = [candle(i * 5, 100, 101, 99, 100, volume=1000) for i in range(40)]
    assert _find_liquidity_event(flat) is None


# --- observation record ------------------------------------------------------


def test_measure_liquidity_records_the_stage_reached():
    measured = measure_liquidity(forming_tail(_sequence()))
    assert measured is not None
    assert measured["stage"] == 7
    assert measured["bullish"] is True
    assert measured["continued"] is True
    assert measured["fvg"]["bottom"] < measured["fvg"]["top"]


def test_measure_liquidity_records_where_a_partial_sequence_stopped():
    measured = measure_liquidity(forming_tail(_sequence(retrace=False, continues=False)))
    assert measured is not None
    assert measured["retraced"] is False
    assert measured["stage"] == 5


def test_measure_liquidity_is_none_on_a_quiet_tape():
    flat = [candle(i * 5, 100, 101, 99, 100, volume=1000) for i in range(40)]
    assert measure_liquidity(forming_tail(flat)) is None


# --- catalogue ---------------------------------------------------------------


def test_liquidity_sweep_is_adoptable():
    template = get_template("liquidity_sweep_fvg")
    assert template.available is True
    assert template.missing == []
