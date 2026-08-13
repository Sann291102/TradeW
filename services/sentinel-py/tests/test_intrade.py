from app.intrade.monitor import Direction, IntradeEvent, evaluate_position, r_multiple
from tests.conftest import candle, forming_tail

# Opening range 95–110 from the first candle, so structure-break checks have
# a level to work with.
OPENING = candle(0, 100, 110, 95, 105)


def bars(*rest):
    return forming_tail([OPENING, *rest])


def test_r_multiple_is_progress_in_units_of_declared_risk():
    # Long from 100 with invalidation at 90 → risk 10.
    assert r_multiple(100, 110, 90, Direction.LONG) == 1.0
    assert r_multiple(100, 120, 90, Direction.LONG) == 2.0
    # Against the position is negative, not zero.
    assert r_multiple(100, 95, 90, Direction.LONG) == -0.5


def test_r_multiple_is_none_when_risk_is_zero():
    """Entry equal to the invalidation level has no scale; dividing by it
    would produce an infinite R that reads as spectacular success."""
    assert r_multiple(100, 150, 100, Direction.LONG) is None


def test_short_direction_inverts_progress():
    assert r_multiple(100, 90, 110, Direction.SHORT) == 1.0
    assert r_multiple(100, 110, 110, Direction.SHORT) == -1.0


def test_milestone_fires_once_and_reports_the_highest_crossed():
    result = evaluate_position(
        candles=bars(candle(15, 105, 132, 104, 131)),  # 100 entry, 90 stop → 3.1R
        entry=100,
        stop=90,
        direction=Direction.LONG,
    )
    milestones = [f for f in result.findings if f.event is IntradeEvent.MILESTONE]
    assert len(milestones) == 1
    assert milestones[0].milestone == "3R"
    assert result.newly_reached == ["1R", "2R", "3R"]


def test_already_reported_milestone_does_not_refire():
    result = evaluate_position(
        candles=bars(candle(15, 105, 115, 104, 111)),  # 1.1R
        entry=100,
        stop=90,
        direction=Direction.LONG,
        already_reached=["1R"],
    )
    assert [f for f in result.findings if f.event is IntradeEvent.MILESTONE] == []
    assert result.newly_reached == []


def test_invalidation_uses_the_adverse_extreme_not_the_close():
    """Price traded through the user's level intrabar and closed back above.
    A watcher that stayed quiet here would hide the thing that matters most."""
    result = evaluate_position(
        candles=bars(candle(15, 105, 112, 89, 108)),  # low 89 < stop 90
        entry=100,
        stop=90,
        direction=Direction.LONG,
    )
    assert result.findings[0].event is IntradeEvent.INVALIDATION_REACHED
    assert result.closes_position


def test_milestone_uses_the_close_not_the_favourable_wick():
    """A wick that tags 2R and retraces has not achieved 2R."""
    result = evaluate_position(
        candles=bars(candle(15, 105, 125, 104, 108)),  # high=2.5R, close=0.8R
        entry=100,
        stop=90,
        direction=Direction.LONG,
    )
    assert [f for f in result.findings if f.event is IntradeEvent.MILESTONE] == []


def test_invalidation_wins_over_a_milestone_on_the_same_bar():
    result = evaluate_position(
        candles=bars(candle(15, 105, 130, 89, 125)),
        entry=100,
        stop=90,
        direction=Direction.LONG,
    )
    assert len(result.findings) == 1
    assert result.findings[0].event is IntradeEvent.INVALIDATION_REACHED


def test_projected_level_closes_the_position():
    result = evaluate_position(
        candles=bars(candle(15, 105, 128, 104, 126)),
        entry=100,
        stop=90,
        direction=Direction.LONG,
        target=125,
    )
    assert result.findings[0].event is IntradeEvent.PROJECTED_LEVEL_REACHED
    assert result.closes_position


def test_structure_break_is_reported_but_does_not_close_the_position():
    """Only the user's own invalidation level decides an exit."""
    result = evaluate_position(
        candles=bars(candle(15, 105, 106, 92, 93)),  # closes below OR low 95, above stop 90
        entry=100,
        stop=90,
        direction=Direction.LONG,
    )
    events = [f.event for f in result.findings]
    assert IntradeEvent.STRUCTURE_BREAK in events
    assert not result.closes_position


def test_no_findings_while_price_sits_between_levels():
    result = evaluate_position(
        candles=bars(candle(15, 105, 108, 100, 104)),
        entry=100,
        stop=90,
        direction=Direction.LONG,
    )
    assert result.findings == []
