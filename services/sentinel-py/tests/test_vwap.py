"""VWAP primitives and the two strategies built on them.

The point of these tests is not that VWAP arithmetic works — it is that the
two templates stay DIFFERENT strategies. A bounce is a continuation; an
end-of-day reversion is a fade. A candle series that confirms one must not
confirm the other, or the funnels would be measuring the same thing twice
under two names.
"""

import pytest

from app.market.clock import minutes_to_close
from app.strategy.templates import get_template
from app.watch.evaluator import evaluate, measure_vwap
from app.watch.indicators import (
    Slope,
    VwapTest,
    atr,
    classify_deviation,
    count_vwap_tests,
    find_vwap_extreme,
    vwap_deviation,
    vwap_series,
    vwap_slope,
)
from tests.conftest import candle, forming_tail


def _rules(template_id: str) -> list[dict]:
    template = get_template(template_id)
    assert template is not None and template.available
    return template.rules["rules"]


def _outcome(template_id: str, candles) -> dict[str, bool]:
    result = evaluate(_rules(template_id), forming_tail(candles))
    return {r.name: r.met for r in result.rules}


# --- vwap_series -------------------------------------------------------------


def test_vwap_matches_a_hand_computed_series():
    bars = [
        candle(0, 100, 102, 98, 100, volume=100),  # typical 100
        candle(5, 100, 114, 106, 110, volume=100),  # typical 110
    ]
    values = vwap_series(bars)
    assert values == pytest.approx([100.0, 105.0])


def test_vwap_is_empty_when_the_instrument_reports_no_volume():
    """Load-bearing. Several option contracts come back from the bridge with
    zero volume; a fallback average price would look like a working level
    while being unrelated to volume, and the strategy would appear functional
    when it is not."""
    bars = [candle(i * 5, 100, 101, 99, 100, volume=0) for i in range(10)]
    assert vwap_series(bars) == []


def test_vwap_resets_at_the_session_boundary():
    from datetime import timedelta

    today = [candle(0, 100, 100, 100, 100, volume=100)]
    yesterday = [
        type(today[0])(
            timestamp=today[0].timestamp - timedelta(days=1),
            open=500,
            high=500,
            low=500,
            close=500,
            volume=1000,
        )
    ]
    assert vwap_series(yesterday + today) == pytest.approx([100.0])


# --- vwap_slope --------------------------------------------------------------


def test_vwap_slope_classifies_rather_than_asserting_a_universal_threshold():
    rising = [100 + i for i in range(8)]
    assert vwap_slope(rising, atr_value=1.0) is Slope.RISING
    assert vwap_slope(list(reversed(rising)), atr_value=1.0) is Slope.FALLING
    assert vwap_slope([100.0] * 8, atr_value=1.0) is Slope.FLAT


def test_vwap_slope_lookback_is_configurable():
    values = [100, 100, 100, 100, 100, 101, 102, 103]
    assert vwap_slope(values, lookback=3, atr_value=1.0) is Slope.RISING
    assert vwap_slope(values, lookback=7, atr_value=20.0) is Slope.FLAT


# --- vwap_test_count ---------------------------------------------------------


def test_a_run_of_touching_candles_is_one_test_not_six():
    bars = [candle(i * 5, 100, 101, 99, 100, volume=100) for i in range(6)]
    interaction = count_vwap_tests(bars, vwap_series(bars))
    assert interaction.count == 1
    assert interaction.ordinal is VwapTest.FIRST


def test_tests_are_counted_again_only_after_price_leaves_the_level():
    bars = [
        candle(0, 100, 101, 99, 100, volume=100),  # touch -> 1st
        candle(5, 100, 130, 120, 125, volume=100),  # away
        candle(10, 125, 126, 100, 101, volume=100),  # back -> 2nd
        candle(15, 101, 140, 130, 135, volume=100),  # away
        candle(20, 135, 136, 100, 102, volume=100),  # back -> 3rd
    ]
    interaction = count_vwap_tests(bars, vwap_series(bars))
    assert interaction.count == 3
    assert interaction.ordinal is VwapTest.REPEATED


def test_no_vwap_means_no_tests_rather_than_a_default_of_one():
    bars = [candle(i * 5, 100, 101, 99, 100, volume=0) for i in range(4)]
    assert count_vwap_tests(bars, vwap_series(bars)).count == 0


# --- deviation ---------------------------------------------------------------


def test_deviation_is_atr_normalised_and_signed():
    assert vwap_deviation(110, 100, 5) == pytest.approx(2.0)
    assert vwap_deviation(90, 100, 5) == pytest.approx(-2.0)


def test_deviation_is_none_without_an_atr_rather_than_a_raw_distance():
    """A raw point distance is not comparable across symbols, so there is no
    number to report."""
    assert vwap_deviation(110, 100, None) is None
    assert vwap_deviation(110, 100, 0) is None


def test_deviation_buckets_match_the_stated_convention():
    assert classify_deviation(0.3) == "under-0.5"
    assert classify_deviation(0.7) == "0.5-1"
    assert classify_deviation(-1.4) == "1-2"
    assert classify_deviation(3.0) == "2+"
    assert classify_deviation(None) is None


def test_extreme_is_measured_on_candle_extremes_not_closes():
    bars = [
        candle(0, 100, 100, 100, 100, volume=100),
        candle(5, 100, 140, 100, 101, volume=100),  # ran far, closed back
    ]
    extreme = find_vwap_extreme(bars, vwap_series(bars), atr_value=10.0)
    assert extreme is not None
    assert extreme.deviation_atr > 0


# --- session clock -----------------------------------------------------------


def test_minutes_to_close_is_honest_outside_market_hours():
    from datetime import timedelta

    at_open = candle(0, 1, 1, 1, 1).timestamp
    assert minutes_to_close(at_open) == 375
    assert minutes_to_close(at_open + timedelta(hours=7)) < 0


# --- the two strategies stay separate ----------------------------------------


def _bounce_series():
    """Uptrending session: price runs up, comes back to VWAP, rejects it,
    then closes above the test candle's high."""
    bars = [candle(i * 5, 100 + i, 101 + i, 99 + i, 100.5 + i, volume=1000) for i in range(20)]
    vwap_now = vwap_series(bars)[-1]
    bars.append(candle(100, 120, 121, vwap_now - 1, vwap_now - 0.5, volume=1200))  # body into VWAP
    bars.append(candle(105, vwap_now, 123, vwap_now - 0.5, 122, volume=1500))  # reject + carry
    bars.append(candle(110, 122, 126, 121, 125, volume=1500))  # continuation
    return bars


def test_vwap_bounce_confirms_on_a_trend_pullback_to_vwap():
    outcome = _outcome("vwap_bounce", _bounce_series())
    assert outcome["vwap_body_interaction"] is True
    assert outcome["vwap_rejection_reclaim"] is True
    assert outcome["vwap_continuation"] is True


def test_vwap_bounce_does_not_confirm_when_the_instrument_has_no_volume():
    """Fails CLOSED. Without volume there is no VWAP, and an inert strategy
    must report that rather than quietly evaluating against nothing."""
    bars = [c.__class__(**{**c.__dict__, "volume": 0}) for c in _bounce_series()]
    outcome = _outcome("vwap_bounce", bars)
    assert outcome["vwap_trend_established"] is False
    assert outcome["vwap_body_interaction"] is False
    assert outcome["vwap_rejection_reclaim"] is False
    assert outcome["vwap_continuation"] is False


def test_vwap_bounce_does_not_confirm_when_price_never_returns_to_vwap():
    bars = [candle(i * 5, 100 + i * 2, 102 + i * 2, 99 + i * 2, 101 + i * 2, volume=1000) for i in range(25)]
    outcome = _outcome("vwap_bounce", bars)
    assert outcome["vwap_continuation"] is False


def _reversion_series():
    """Quiet morning, then a late stretch far below VWAP that turns back."""
    bars = [candle(i * 5, 100, 101, 99, 100, volume=1000) for i in range(60)]  # to ~14:15
    bars.append(candle(300, 100, 100, 88, 89, volume=2000))  # extension down
    bars.append(candle(305, 89, 94, 89, 93, volume=2000))  # exhaustion / turn
    bars.append(candle(310, 93, 101, 93, 100, volume=2000))  # return to VWAP
    return bars


def test_eod_reversion_confirms_on_a_late_stretch_that_returns():
    outcome = _outcome("vwap_reversion_eod", _reversion_series())
    assert outcome["late_session_window"] is True
    assert outcome["vwap_extension_beyond_atr"] is True
    assert outcome["vwap_exhaustion_reversal"] is True
    assert outcome["vwap_return_to_level"] is True


def test_eod_reversion_does_not_confirm_early_in_the_session():
    """Same shape, wrong time of day. The session clock is a real condition,
    not decoration."""
    bars = [candle(i * 5, 100, 101, 99, 100, volume=1000) for i in range(20)]
    bars.append(candle(100, 100, 100, 88, 89, volume=2000))
    bars.append(candle(105, 89, 94, 89, 93, volume=2000))
    bars.append(candle(110, 93, 101, 93, 100, volume=2000))
    outcome = _outcome("vwap_reversion_eod", bars)
    assert outcome["late_session_window"] is False


def test_the_two_vwap_strategies_do_not_confirm_on_the_same_series():
    """The separation the funnels depend on: a continuation setup and a fade
    cannot both be true of one tape, so merging them into one 'VWAP strategy'
    would blend a trend-follower with its opposite."""
    bounce = _bounce_series()
    reversion = _reversion_series()

    def mandatory_all(template_id, bars):
        result = evaluate(_rules(template_id), forming_tail(bars))
        return result.all_mandatory_met

    assert mandatory_all("vwap_bounce", bounce) is True
    assert mandatory_all("vwap_reversion_eod", bounce) is False
    assert mandatory_all("vwap_reversion_eod", reversion) is True
    assert mandatory_all("vwap_bounce", reversion) is False


# --- observation record ------------------------------------------------------


def test_measure_vwap_records_ordinal_and_deviation_bucket():
    measured = measure_vwap(forming_tail(_bounce_series()))
    assert measured is not None
    assert measured["testOrdinal"] in {"first", "second", "repeated"}
    assert measured["deviationBucket"] in {"under-0.5", "0.5-1", "1-2", "2+"}
    assert measured["slope"] in {"rising", "flat", "falling"}


def test_measure_vwap_is_none_without_volume():
    bars = [candle(i * 5, 100, 101, 99, 100, volume=0) for i in range(30)]
    assert measure_vwap(forming_tail(bars)) is None


# --- catalogue ---------------------------------------------------------------


def test_both_vwap_templates_are_adoptable_and_separate():
    bounce, reversion = get_template("vwap_bounce"), get_template("vwap_reversion_eod")
    assert bounce is not None and reversion is not None
    assert bounce.available and reversion.available
    assert bounce.rules["rules"] != reversion.rules["rules"]
