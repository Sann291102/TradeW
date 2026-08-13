from app.strategy.parser import parse_strategy_text
from app.watch.evaluator import evaluate, opening_range
from tests.conftest import candle, forming_tail

ORB_TEXT = "First 15 minute high low. Breakout above high, with retest. Stop loss at 10 points. Target 1:2."


def orb_rules() -> list[dict]:
    parsed, _ = parse_strategy_text(ORB_TEXT)
    return [r.model_dump() for r in parsed.rules]


def test_opening_range_is_first_candle_of_session():
    bars = [candle(0, 100, 110, 95, 105), candle(15, 105, 120, 104, 118)]
    high, low = opening_range(bars)
    assert (high, low) == (110, 95)


def test_no_breakout_leaves_all_rules_unmet():
    bars = forming_tail([candle(0, 100, 110, 95, 105), candle(15, 105, 108, 100, 103)])
    result = evaluate(orb_rules(), bars)
    assert result.mandatory_met == 0
    assert not result.any_mandatory_met


def test_breakout_without_retest_is_partial():
    bars = forming_tail(
        [
            candle(0, 100, 110, 95, 105),
            candle(15, 105, 115, 104, 114),  # closes above OR high 110
        ]
    )
    result = evaluate(orb_rules(), bars)
    assert result.any_mandatory_met
    assert not result.all_mandatory_met


def test_breakout_then_retest_then_reclaim_confirms():
    bars = forming_tail(
        [
            candle(0, 100, 110, 95, 105),
            candle(15, 105, 115, 104, 114),  # break above 110
            candle(30, 114, 115, 109, 111),  # returns to the level
            candle(45, 111, 118, 110, 117),  # closes back above
        ]
    )
    result = evaluate(orb_rules(), bars)
    assert result.all_mandatory_met


def test_forming_candle_is_never_evaluated():
    """A breakout that exists ONLY in the still-forming candle must not count
    — this is the 'confirmation before notification' rule."""
    closed = [candle(0, 100, 110, 95, 105), candle(15, 105, 108, 100, 103)]
    bars = closed + [candle(30, 103, 130, 103, 129)]  # forming, way above OR high
    result = evaluate(orb_rules(), bars)
    assert result.mandatory_met == 0


def test_unrecognized_condition_never_counts_as_met():
    rules = [{"id": "r", "name": "weird", "condition": "moon_phase_waxing", "mandatory": True}]
    bars = forming_tail([candle(0, 100, 110, 95, 105), candle(15, 105, 115, 104, 114)])
    result = evaluate(rules, bars)
    assert result.mandatory_met == 0
    assert "unrecognized" in result.rules[0].detail
