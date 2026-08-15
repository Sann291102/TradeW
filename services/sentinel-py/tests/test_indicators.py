from app.market.feed import Candle
from app.watch.indicators import (
    Slope,
    atr,
    body_interaction,
    classify_slope,
    ema_series,
    find_bullish_reclaim,
    relative_volume,
)
from tests.conftest import candle, forming_tail


def test_ema_matches_a_hand_computed_series():
    # period 3 over 1..5: seed = mean(1,2,3) = 2, k = 0.5
    #   4 -> (4-2)*.5+2 = 3 ;  5 -> (5-3)*.5+3 = 4
    assert ema_series([1, 2, 3, 4, 5], 3) == [2, 3, 4]


def test_ema_refuses_to_compute_from_too_little_data():
    """An 'EMA-7' off three candles is not an EMA-7."""
    assert ema_series([1, 2, 3], 7) == []


def test_slope_classification():
    assert classify_slope([10, 11, 12, 13], lookback=3, atr=1.0) is Slope.RISING
    assert classify_slope([13, 12, 11, 10], lookback=3, atr=1.0) is Slope.FALLING
    assert classify_slope([10, 10.01, 10, 10.01], lookback=3, atr=1.0) is Slope.FLAT


def test_slope_is_flat_without_enough_history():
    assert classify_slope([10, 11], lookback=3) is Slope.FLAT


def test_slope_is_scale_free_when_atr_is_supplied():
    """The same absolute move must not read as a trend on a big number and
    noise on a small one."""
    small = classify_slope([100, 101, 102, 103], lookback=3, atr=1.0)
    large = classify_slope([24000, 24001, 24002, 24003], lookback=3, atr=1.0)
    assert small is large is Slope.RISING


def test_body_interaction_separates_wick_touches_from_body_touches():
    # Body 105..110, wick down to 95.
    c = Candle(candle(0, 105, 112, 95, 110).timestamp, 105, 112, 95, 110, 1000)
    wick_only = body_interaction(c, 100)
    assert wick_only.touched_wick and not wick_only.touched_body

    into_body = body_interaction(c, 107)
    assert into_body.touched_body and into_body.touched_wick


def test_bullish_reclaim_requires_the_body_not_just_the_wick():
    ema = [100.0, 100.0]
    # Body 101..104 never reaches 100; only the wick does.
    wick_only = [candle(0, 104, 105, 96, 101), candle(15, 101, 106, 99, 104)]
    assert find_bullish_reclaim(wick_only, ema) is None

    # Body opens at 104 and closes 103 having traded down through the EMA.
    reclaim = [candle(0, 104, 105, 96, 101), candle(15, 99, 106, 97, 103)]
    found = find_bullish_reclaim(reclaim, ema)
    assert found is not None
    assert "closed above" in found.detail


def test_a_close_below_the_ema_is_not_a_reclaim():
    ema = [100.0, 100.0]
    below = [candle(0, 104, 105, 96, 101), candle(15, 102, 103, 96, 98)]
    assert find_bullish_reclaim(below, ema) is None


def test_relative_volume_and_its_absence():
    flat = [candle(i, 100, 101, 99, 100, 1000) for i in range(21)]
    assert relative_volume(flat) == 1.0

    spiked = flat[:-1] + [candle(20, 100, 101, 99, 100, 2000)]
    assert relative_volume(spiked) == 2.0

    assert relative_volume(flat[:5]) is None                     # not enough history
    zero = [candle(i, 100, 101, 99, 100, 0) for i in range(21)]
    assert relative_volume(zero) is None                          # instrument reports none


def test_atr_needs_a_full_period():
    assert atr([candle(i, 100, 102, 98, 100) for i in range(5)], period=14) is None
    value = atr([candle(i, 100, 102, 98, 100) for i in range(20)], period=14)
    assert value == 4.0


# --- EMA-7 Bullish Reclaim, end to end ---------------------------------------


def _uptrend(n=10, start=100.0, step=1.2):
    """Rising candles so EMA-7 climbs beneath price."""
    out, p = [], start
    for i in range(n):
        out.append(candle(i * 5, p, p + 1.5, p - 0.4, p + 1.2, 1000))
        p += step
    return out


def test_full_ema7_sequence_confirms_only_after_follow_through():
    """Trend -> body reclaim -> close above the reclaim candle high.

    The reclaim alone must NOT confirm: the user said this setup needs
    patience, and the follow-through condition is what encodes that.
    """
    from app.strategy.templates import get_template
    from app.watch.evaluator import evaluate

    rules = get_template("ema7_bullish_reclaim").rules["rules"]
    trend = _uptrend()  # last close 112.0, EMA-7 ~108.4

    # A candle whose BODY (108.0..109.2) straddles the EMA and closes above it.
    reclaim = candle(50, 108.0, 110.0, 106.5, 109.2, 1200)

    # After the reclaim but BEFORE follow-through: still developing.
    forming = evaluate(rules, forming_tail(trend + [reclaim]))
    by_name = {r.name: r for r in forming.rules}
    assert by_name["ema7_body_reclaim"].met, by_name["ema7_body_reclaim"].detail
    assert not by_name["reclaim_follow_through"].met
    assert not forming.all_mandatory_met

    # A later candle closes above the reclaim candle's high -> confirmed.
    through = candle(55, 109.2, 113.0, 109.0, 112.5, 1500)  # closes above the reclaim high 110.0
    done = evaluate(rules, forming_tail(trend + [reclaim, through]))
    done_by_name = {r.name: r for r in done.rules}
    assert done_by_name["reclaim_follow_through"].met, done_by_name["reclaim_follow_through"].detail
    assert done.all_mandatory_met


def test_a_wick_into_the_ema_does_not_count_as_a_reclaim():
    """The distinction the whole setup rests on."""
    from app.strategy.templates import get_template
    from app.watch.evaluator import evaluate

    rules = get_template("ema7_bullish_reclaim").rules["rules"]
    trend = _uptrend()
    # Body stays well above the EMA (~108.4); only the lower wick reaches it.
    wick_only = candle(50, 111.0, 111.5, 106.0, 111.2, 1200)

    result = evaluate(rules, forming_tail(trend + [wick_only]))
    by_name = {r.name: r for r in result.rules}
    assert not by_name["ema7_body_reclaim"].met
    assert not result.all_mandatory_met


def test_a_falling_ema_never_qualifies_however_the_candles_look():
    from app.strategy.templates import get_template
    from app.watch.evaluator import evaluate

    rules = get_template("ema7_bullish_reclaim").rules["rules"]
    downtrend, p = [], 120.0
    for i in range(12):
        downtrend.append(candle(i * 5, p, p + 0.4, p - 1.5, p - 1.2, 1000))
        p -= 1.2

    result = evaluate(rules, forming_tail(downtrend))
    by_name = {r.name: r for r in result.rules}
    assert not by_name["ema7_rising"].met
    assert not result.all_mandatory_met
