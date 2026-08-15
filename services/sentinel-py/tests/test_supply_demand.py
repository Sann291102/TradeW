"""Supply / demand zones — identity first, then the strategy on top of it.

The central problem here is not detection, it is IDENTITY. The sweep runs
every fifteen seconds; a zone model that re-derives fresh objects each pass
would report a brand-new zone every time, lose its touch history, and make
"this zone has been tested twice" unsayable. So the first tests are about a
zone staying the same zone.
"""

from app.strategy.templates import get_template
from app.watch.evaluator import _find_zone, evaluate, measure_zone
from app.watch.indicators import (
    ZONE_MIN_DEPARTURE_ATR,
    ZoneKind,
    atr,
    find_zones,
    resample,
    score_zone,
)
from tests.conftest import candle, forming_tail


def _rules() -> list[dict]:
    template = get_template("supply_demand_zone")
    assert template is not None and template.available
    return template.rules["rules"]


def _outcome(candles) -> dict[str, bool]:
    result = evaluate(_rules(), forming_tail(candles))
    return {r.name: r.met for r in result.rules}


def _quiet(n: int, price: float = 100.0, start: int = 0):
    return [candle(start + i * 5, price, price + 1, price - 1, price, volume=1000) for i in range(n)]


def _demand_series(returns: bool = True, reacts: bool = True, through: bool = False):
    """Base around 100, hard departure up, then (optionally) a return to it."""
    bars = _quiet(20)
    bars += [
        candle(100, 100, 105, 99.5, 105, volume=2500),
        candle(105, 105, 111, 104.5, 111, volume=2500),
        candle(110, 111, 117, 110.5, 117, volume=2500),
    ]
    bars += _quiet(3, price=116, start=115)
    if returns:
        bars.append(candle(130, 116, 116.5, 100.5, 101, volume=2000))  # back into the base
    if through:
        bars.append(candle(135, 101, 101.5, 92, 93, volume=2000))  # straight through it
    elif reacts:
        bars.append(candle(135, 101, 108, 100.5, 107, volume=2200))  # closes back out above
    return bars


# --- identity ----------------------------------------------------------------


def test_a_zone_keeps_its_identity_across_sweeps():
    """The same zone re-detected on a longer window must be the SAME zone.
    Otherwise every sweep discovers a new one and touches never accumulate."""
    bars = _demand_series(returns=False, reacts=False)
    first = _find_zone(bars)
    later = _find_zone(bars + _quiet(2, price=116, start=200))
    assert first is not None and later is not None
    assert first.id == later.id


def test_zone_identity_comes_from_the_formation_not_the_detection_time():
    bars = _demand_series(returns=False, reacts=False)
    zone = _find_zone(bars)
    assert zone is not None
    assert bars[zone.base_index].timestamp.isoformat() in zone.id
    assert zone.timeframe in zone.id


def test_touches_accumulate_rather_than_resetting():
    untouched = _find_zone(_demand_series(returns=False, reacts=False))
    touched = _find_zone(_demand_series())
    assert untouched is not None and touched is not None
    assert untouched.id == touched.id
    assert untouched.touches == 0 and untouched.fresh is True
    assert touched.touches >= 1 and touched.fresh is False


def test_sitting_inside_a_zone_is_one_touch_not_six():
    bars = _demand_series(returns=False, reacts=False)
    bars += [candle(130 + i * 5, 100.5, 101, 99.8, 100.2, volume=900) for i in range(6)]
    zone = _find_zone(bars)
    assert zone is not None and zone.touches == 1


# --- detection ---------------------------------------------------------------


def test_a_base_without_a_hard_departure_is_not_a_zone():
    """Price drifting away from an area does not make that area a zone."""
    drift = _quiet(20) + [
        candle(100 + i * 5, 100 + i * 0.3, 100.6 + i * 0.3, 99.6 + i * 0.3, 100.2 + i * 0.3)
        for i in range(8)
    ]
    assert find_zones(drift, atr(drift)) == []


def test_a_hard_departure_upward_makes_a_demand_zone():
    zone = _find_zone(_demand_series(returns=False, reacts=False))
    assert zone is not None
    assert zone.kind is ZoneKind.DEMAND
    assert zone.departure_atr >= ZONE_MIN_DEPARTURE_ATR
    assert zone.bottom < zone.top


def test_a_hard_departure_downward_makes_a_supply_zone():
    bars = _quiet(20)
    bars += [
        candle(100, 100, 100.5, 95, 95, volume=2500),
        candle(105, 95, 95.5, 89, 89, volume=2500),
        candle(110, 89, 89.5, 83, 83, volume=2500),
    ]
    zone = _find_zone(bars)
    assert zone is not None and zone.kind is ZoneKind.SUPPLY


def test_zone_width_is_reported_in_atr_not_points():
    zone = _find_zone(_demand_series(returns=False, reacts=False))
    assert zone is not None and zone.width_atr > 0


# --- scoring -----------------------------------------------------------------


def test_scoring_describes_the_zone_and_does_not_rank_strategies():
    zone = _find_zone(_demand_series(returns=False, reacts=False))
    score = score_zone(zone)
    assert 0 <= score.total <= 1
    assert score.freshness == 1.0  # untested
    assert set(score.__dict__) == {"freshness", "departure", "tightness", "total", "detail"}


def test_a_tested_zone_scores_lower_on_freshness_than_an_untested_one():
    fresh = score_zone(_find_zone(_demand_series(returns=False, reacts=False)))
    tested = score_zone(_find_zone(_demand_series()))
    assert tested.freshness < fresh.freshness


# --- higher timeframe --------------------------------------------------------


def test_resample_aggregates_without_a_second_request():
    """Derived from the SAME series, so the two timeframes cannot disagree
    about what happened."""
    bars = [candle(i * 5, 100 + i, 105 + i, 95 + i, 102 + i, volume=100) for i in range(6)]
    coarse = resample(bars, 3)
    assert len(coarse) == 2
    assert coarse[0].open == bars[0].open
    assert coarse[0].close == bars[2].close
    assert coarse[0].high == max(c.high for c in bars[:3])
    assert coarse[0].volume == 300


def test_resample_drops_a_trailing_partial_group():
    bars = [candle(i * 5, 100, 101, 99, 100) for i in range(7)]
    assert len(resample(bars, 3)) == 2


def test_htf_alignment_is_reported_not_enforced():
    """It is an optional rule: the condition reports the context and the
    user's rule decides what to do with it."""
    optional = [r for r in _rules() if r["name"] == "zone_htf_aligned"]
    assert optional and optional[0]["mandatory"] is False


# --- the strategy ------------------------------------------------------------


def test_the_full_zone_sequence_confirms():
    outcome = _outcome(_demand_series())
    assert outcome["zone_present"] is True
    assert outcome["price_returns_to_zone"] is True
    assert outcome["zone_reaction"] is True


def test_a_zone_price_has_not_returned_to_is_still_waiting():
    outcome = _outcome(_demand_series(returns=False, reacts=False))
    assert outcome["zone_present"] is True
    assert outcome["price_returns_to_zone"] is False
    assert outcome["zone_reaction"] is False


def test_price_cutting_straight_through_is_not_a_reaction():
    """The zone failing is the outcome the funnel most needs to be able to
    count, so it must not read as a partial success."""
    outcome = _outcome(_demand_series(through=True))
    assert outcome["price_returns_to_zone"] is True
    assert outcome["zone_reaction"] is False


# --- observation record ------------------------------------------------------


def test_measure_zone_carries_the_stable_id():
    measured = measure_zone(forming_tail(_demand_series()))
    assert measured is not None
    assert measured["id"] == _find_zone(_demand_series()).id
    assert measured["kind"] == "demand"
    assert measured["fresh"] is False
    assert 0 <= measured["score"] <= 1


def test_measure_zone_is_none_on_a_quiet_tape():
    assert measure_zone(forming_tail(_quiet(40))) is None


# --- catalogue ---------------------------------------------------------------


def test_supply_demand_is_adoptable():
    template = get_template("supply_demand_zone")
    assert template.available is True
    assert template.missing == []
