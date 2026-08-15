from app.strategy.schemas import ParsedStrategy
from app.strategy.templates import CATALOGUE, get_template, list_templates


def test_catalogue_covers_all_eleven_strategies():
    assert len(CATALOGUE) == 11


def test_available_templates_produce_rules_the_evaluator_understands():
    """A template that parsed into conditions the watch engine cannot decide
    would be adopted and then silently never fire."""
    from app.watch.evaluator import evaluate

    for template in CATALOGUE:
        if not template.available:
            continue
        parsed = ParsedStrategy(**template.rules)
        result = evaluate([r.model_dump() for r in parsed.rules], [])
        for rule in result.rules:
            assert "unrecognized" not in rule.detail, f"{template.id}: {rule.condition}"


def test_unavailable_templates_name_the_missing_primitive():
    vwap = get_template("vwap_bounce")
    assert vwap is not None
    assert vwap.available is False
    assert "vwap" in vwap.missing
    assert "vwap" in vwap.to_dict()["unavailableReason"]


def test_ema7_is_adoptable_now_that_its_primitives_exist():
    ema7 = get_template("ema7_bullish_reclaim")
    assert ema7.available is True
    assert ema7.missing == []


def test_ema7_offers_no_short_side():
    """It is a bullish reclaim. A short entry would misrepresent the setup
    the user adopted."""
    ema7 = get_template("ema7_bullish_reclaim")
    assert ema7.rules["entry"]["short"] is None
    assert ema7.rules["entry"]["long"]


def test_unavailable_templates_expose_no_rules_to_adopt():
    """Better to offer nothing than a rule set that cannot be watched."""
    for template in CATALOGUE:
        if not template.available:
            assert template.to_dict()["rules"] == {}


def test_ema7_is_declared_long_only():
    """It is a bullish reclaim; presenting a short side would misrepresent it."""
    assert get_template("ema7_bullish_reclaim").direction == "long_only"


def test_no_template_is_ranked_or_scored():
    """The catalogue is a menu, not a recommendation."""
    forbidden = {"score", "edgeScore", "rank", "recommended", "primary", "confidence"}
    for entry in list_templates():
        assert not forbidden & set(entry)


def test_orb_templates_are_available_today():
    assert get_template("orb_15m_retest").available
    assert get_template("orb_30m").available


def test_every_template_has_a_stable_id_and_summary():
    ids = [t.id for t in CATALOGUE]
    assert len(ids) == len(set(ids))
    assert all(t.summary and t.name for t in CATALOGUE)
