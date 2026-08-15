from app.strategy.parser import parse_strategy_text


def test_orb_breakout_retest_long():
    text = (
        "First 15 minute high low. Breakout above high or breakout below low, with retest. "
        "Stop loss at 10 points. Target 1:2 risk reward."
    )
    parsed, warnings = parse_strategy_text(text)

    assert parsed.timeframe == "15m"
    assert parsed.levels == ["15m_high", "15m_low"]
    assert parsed.entry.long == "after_retest_bounce_above_15m_high"
    assert parsed.entry.short == "after_retest_bounce_below_15m_low"
    assert parsed.riskManagement.stopLoss == "15m_low_minus_10_points"
    assert parsed.riskManagement.targets == ["1R", "2R"]

    rule_names = {r.name for r in parsed.rules}
    assert {"breakout_high", "breakout_low", "retest"} <= rule_names
    assert all(r.mandatory for r in parsed.rules)
    assert warnings == []


def test_volume_confirmation_is_optional():
    parsed, _ = parse_strategy_text("Breakout above high with volume confirmation.")
    volume_rules = [r for r in parsed.rules if r.name == "volume_confirm"]
    assert len(volume_rules) == 1
    assert volume_rules[0].mandatory is False


def test_unrecognized_text_produces_warnings():
    parsed, warnings = parse_strategy_text("I like trading sometimes.")
    assert parsed.rules == []
    assert len(warnings) == 2
