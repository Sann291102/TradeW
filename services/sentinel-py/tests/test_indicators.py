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


# --- 9/21 EMA Pullback -------------------------------------------------------


def _trend_then_pullback():
    """Rising trend, a retracement into the 9/21 zone, then a close back above
    the 9 EMA."""
    bars, p = [], 100.0
    for i in range(30):                       # establish the trend
        bars.append(candle(i * 5, p, p + 1.4, p - 0.3, p + 1.2, 1000)); p += 1.2
    top = bars[-1].close
    for i in range(6):                        # pull back
        bars.append(candle((30 + i) * 5, top, top + 0.2, top - 2.2, top - 2.0, 900)); top -= 2.0
    bars.append(candle(36 * 5, top, top + 6.0, top - 0.2, top + 5.5, 1400))  # continuation
    return bars


def test_pullback_reuses_the_shared_ema_layer_not_a_private_copy():
    """The 9/21 conditions must be computed from the same primitives EMA-7
    uses — a second implementation would drift."""
    import app.watch.evaluator as ev
    from app.strategy.templates import get_template

    calls = {"n": 0}
    original = ev.ema_of

    def counting(candles, period):
        calls["n"] += 1
        return original(candles, period)

    ev.ema_of = counting
    try:
        rules = get_template("ema_9_21_pullback").rules["rules"]
        ev.evaluate(rules, forming_tail(_trend_then_pullback()))
    finally:
        ev.ema_of = original

    assert calls["n"] > 0, "9/21 conditions did not go through the shared ema_of primitive"


def test_full_9_21_pullback_sequence_confirms():
    from app.strategy.templates import get_template
    from app.watch.evaluator import evaluate

    rules = get_template("ema_9_21_pullback").rules["rules"]
    result = evaluate(rules, forming_tail(_trend_then_pullback()))
    by_name = {r.name: r for r in result.rules}

    assert by_name["ema_9_21_bullish_alignment"].met, by_name["ema_9_21_bullish_alignment"].detail
    assert by_name["pullback_into_ema_zone"].met, by_name["pullback_into_ema_zone"].detail
    assert by_name["pullback_rejection_continuation"].met, by_name["pullback_rejection_continuation"].detail
    assert result.all_mandatory_met


def test_a_steady_trend_with_no_pullback_does_not_confirm():
    """The condition that must fail when the setup's defining event is absent."""
    from app.strategy.templates import get_template
    from app.watch.evaluator import evaluate

    rules = get_template("ema_9_21_pullback").rules["rules"]
    bars, p = [], 100.0
    for i in range(30):
        bars.append(candle(i * 5, p, p + 1.4, p - 0.3, p + 1.2, 1000)); p += 1.2

    result = evaluate(rules, forming_tail(bars))
    by_name = {r.name: r for r in result.rules}
    assert by_name["ema_9_21_bullish_alignment"].met      # trend is real
    assert not by_name["pullback_into_ema_zone"].met      # but nothing pulled back
    assert not result.all_mandatory_met


def test_a_downtrend_never_aligns():
    from app.strategy.templates import get_template
    from app.watch.evaluator import evaluate

    rules = get_template("ema_9_21_pullback").rules["rules"]
    bars, p = [], 140.0
    for i in range(30):
        bars.append(candle(i * 5, p, p + 0.3, p - 1.4, p - 1.2, 1000)); p -= 1.2

    result = evaluate(rules, forming_tail(bars))
    by_name = {r.name: r for r in result.rules}
    assert not by_name["ema_9_21_bullish_alignment"].met
    assert not result.all_mandatory_met


def test_pullback_depth_is_reported_in_atr_multiples_not_raw_points():
    """A 30-point pullback means different things on a 200-rupee option and on
    NIFTY; the raw number alone would make the eventual shallow/normal/deep
    analysis meaningless across symbols."""
    from app.watch.evaluator import measure_pullback

    measured = measure_pullback(forming_tail(_trend_then_pullback()))
    assert measured is not None
    assert measured["depthAtr"] is not None
    assert measured["depthSpread"] is not None
    assert measured["classification"] in {"shallow", "normal", "deep"}


def test_depth_classification_boundaries():
    from app.watch.indicators import PullbackDepth, classify_depth

    assert classify_depth(0.5) is PullbackDepth.SHALLOW
    assert classify_depth(1.5) is PullbackDepth.NORMAL
    assert classify_depth(3.0) is PullbackDepth.DEEP
    assert classify_depth(None) is PullbackDepth.SHALLOW
