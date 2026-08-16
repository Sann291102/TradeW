"""The parser must understand the whole strategy, or say what it missed.

The bug these tests exist for: "First 15 min candle high low with breakout
and retest" produced a two-rule strategy containing neither the opening range
nor the breakout, and said nothing about it. The user saw a plausible result
and had no way to know most of their sentence had been discarded.

So the suite is organised around two invariants:

  1. The same strategy, said several ways, parses to the same rules.
  2. Nothing is invented, and whatever was not understood is reported.
"""

from app.strategy.parser import parse_strategy_text
from app.watch.evaluator import evaluate


def _names(text: str) -> set[str]:
    parsed, _ = parse_strategy_text(text)
    return {rule.name for rule in parsed.rules}


def _warnings(text: str) -> str:
    _, warnings = parse_strategy_text(text)
    return " ".join(warnings)


# --- the regression ----------------------------------------------------------


def test_the_sentence_that_used_to_lose_its_own_strategy():
    """Filler words between the number and the level ("15 min CANDLE high")
    used to defeat the match, and the range and breakout vanished silently."""
    parsed, _ = parse_strategy_text(
        "First 15 min candle high low with breakout and retest, confirm with volume"
    )
    assert parsed.timeframe == "15m"
    assert {r.name for r in parsed.rules} == {
        "opening_range",
        "breakout_high",
        "breakout_low",
        "retest",
        "volume_confirm",
    }


# --- one strategy, many phrasings -------------------------------------------


def test_phrasings_of_the_same_strategy_agree():
    """A user should not have to guess the parser's preferred wording."""
    for text in (
        "15 min opening range breakout and retest",
        "first 15 minute high low breakout with retest",
        "15m ORB breakout then retest",
        "first 15 mins range breakout and re-test",
    ):
        assert {"opening_range", "breakout_high", "breakout_low", "retest"} <= _names(text), text


def test_a_named_range_without_a_number_is_still_a_range():
    assert {"opening_range", "breakout_high", "breakout_low", "retest"} <= _names(
        "break the morning range then retest"
    )


def test_the_duration_is_asked_for_rather_than_assumed():
    """15 minutes is the common convention and exactly the kind of guess that
    would have the user watching a range they never specified."""
    parsed, warnings = parse_strategy_text("break the morning range then retest")
    assert parsed.timeframe is None
    assert "without a duration" in " ".join(warnings)


def test_orb_with_volume_confirmation():
    parsed, _ = parse_strategy_text("ORB with volume confirmation")
    names = {r.name for r in parsed.rules}
    assert "opening_range" in names and "volume_confirm" in names


def test_a_directional_breakout_keeps_its_direction():
    parsed, _ = parse_strategy_text("breakout above first 15m high and retest")
    assert parsed.timeframe == "15m"
    assert {r.name for r in parsed.rules} == {"opening_range", "breakout_high", "retest"}
    # ...and only that direction. The user named one side.
    assert parsed.entry.long == "after_retest_bounce_above_15m_high"
    assert parsed.entry.short is None


# --- nothing is invented -----------------------------------------------------


def test_a_directionless_breakout_watches_both_sides_but_picks_neither():
    """A range has two boundaries, so both are watched. Choosing which one the
    user meant to trade would be Sentinel deciding their strategy for them."""
    parsed, warnings = parse_strategy_text("15 minute opening range breakout")
    assert {"breakout_high", "breakout_low"} <= {r.name for r in parsed.rules}
    assert parsed.entry.long is None and parsed.entry.short is None
    assert "no entry direction was assumed" in " ".join(warnings)


def test_no_stop_or_target_is_invented():
    parsed, _ = parse_strategy_text("15 minute opening range breakout and retest")
    assert parsed.riskManagement.stopLoss is None
    assert parsed.riskManagement.targets == []


def test_stops_and_targets_come_from_the_users_own_numbers():
    parsed, _ = parse_strategy_text(
        "First 15 minute high low. Breakout above high or breakout below low, with retest. "
        "Stop loss at 10 points. Target 1:2 risk reward."
    )
    assert parsed.riskManagement.stopLoss == "15m_low_minus_10_points"
    assert parsed.riskManagement.targets == ["1R", "2R"]
    assert parsed.entry.long == "after_retest_bounce_above_15m_high"
    assert parsed.entry.short == "after_retest_bounce_below_15m_low"


def test_volume_is_optional_unless_the_wording_makes_it_a_requirement():
    casual = [r for r in parse_strategy_text("breakout above high with volume")[0].rules if r.name == "volume_confirm"]
    insisted = [
        r
        for r in parse_strategy_text("breakout above high only if volume is above average")[0].rules
        if r.name == "volume_confirm"
    ]
    assert casual and casual[0].mandatory is False
    assert insisted and insisted[0].mandatory is True


# --- what it did not understand ---------------------------------------------


def test_unrecognised_words_are_reported_rather_than_dropped():
    """Understanding half a strategy and saying so is honest. Understanding
    half and presenting it as the whole is not."""
    warnings = _warnings("15 minute opening range breakout with wyckoff accumulation and cpr")
    assert "Not understood" in warnings
    assert "'wyckoff'" in warnings and "'cpr'" in warnings


def test_a_fully_understood_strategy_reports_nothing_left_over():
    assert "Not understood" not in _warnings(
        "First 15 minute high low. Breakout above high or breakout below low, with retest. "
        "Stop loss at 10 points. Target 1:2 risk reward."
    )


def test_text_with_no_strategy_in_it_says_so():
    parsed, warnings = parse_strategy_text("I like trading sometimes.")
    assert parsed.rules == []
    assert "No recognizable rules found" in " ".join(warnings)


def test_a_breakout_of_nothing_asks_what_it_breaks():
    warnings = _warnings("wait for a breakout then buy")
    assert "not of what" in warnings


# --- the rules the parser emits must be evaluable ----------------------------


def test_every_condition_the_parser_emits_is_one_the_evaluator_knows():
    """A rule the evaluator cannot decide would sit permanently unmet, and the
    user could not tell that from a quiet market."""
    for text in (
        "First 15 min candle high low with breakout and retest, confirm with volume",
        "breakout above first 15m high and retest",
        "break the morning range then retest",
        "ORB with volume confirmation",
    ):
        parsed, _ = parse_strategy_text(text)
        result = evaluate([r.model_dump() for r in parsed.rules], [])
        for rule in result.rules:
            assert "unrecognized" not in rule.detail, f"{text}: {rule.condition}"
