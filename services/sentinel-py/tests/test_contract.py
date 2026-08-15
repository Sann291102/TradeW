"""The generic strategy contract.

These tests exist to stop P7 becoming ten bespoke dashboards. The shape must
not vary by evaluator, the configuration form must be derived from the
strategy's own rules rather than hardcoded per template, and analytics must
be absent — not empty — when there is nothing behind them.
"""

from datetime import datetime, timedelta, timezone

from app.strategy.contract import build_contract
from app.strategy.segments import available_dimensions, compute_segment
from app.strategy.templates import get_template

NOW = datetime(2026, 8, 10, 10, 0, tzinfo=timezone.utc)


def _strategy(template_id: str = "ema7_bullish_reclaim", strategy_id: str = "strat_1") -> dict:
    template = get_template(template_id)
    return {
        "id": strategy_id,
        "name": f"My {template.name}",
        "status": "active",
        "rules": template.rules,
        "rawInput": f"Adopted template: {template_id}",
    }


def _watch(watch_id: str = "w1", state: str = "FORMING") -> dict:
    return {
        "id": watch_id,
        "strategyId": "strat_1",
        "symbol": "NIFTY",
        "state": state,
        "status": "active",
    }


def _observation(
    index: int,
    met: int = 2,
    total: int = 4,
    metadata: dict | None = None,
    observation_id: str | None = None,
) -> dict:
    return {
        "id": observation_id or f"obs_{index}",
        "createdAt": NOW - timedelta(minutes=index),
        "candleTime": NOW - timedelta(minutes=index),
        "agent": "watch-engine",
        "state": "FORMING",
        "ruleEvaluations": [
            {
                "ruleId": f"rule_{i}",
                "name": f"rule_{i}",
                "mandatory": True,
                "met": i < met,
                "detail": "detail",
            }
            for i in range(total)
        ],
        "metadata": {"mandatoryMet": met, "mandatoryTotal": total, **(metadata or {})},
    }


# --- shape -------------------------------------------------------------------


def test_the_contract_shape_is_the_same_for_every_evaluator():
    """The whole point: the UI must not branch on which strategy this is."""
    expected = {
        "id",
        "name",
        "status",
        "template",
        "configuration",
        "watches",
        "focusedWatchId",
        "currentState",
        "conditions",
        "latestObservation",
        "lifecycle",
        "performance",
        "availableAnalytics",
        "segments",
    }
    for template_id in (
        "ema7_bullish_reclaim",
        "ema_9_21_pullback",
        "vwap_bounce",
        "vwap_reversion_eod",
        "sr_flip",
        "flag_pennant",
        "supply_demand_zone",
        "liquidity_sweep_fvg",
        "orb_15m_retest",
    ):
        contract = build_contract(_strategy(template_id), [_watch()], {"w1": [_observation(1)]})
        assert set(contract) == expected, template_id


def test_a_strategy_with_no_watches_still_returns_a_complete_payload():
    """Empty panels the UI has to fill with a second request are how these
    screens start diverging."""
    contract = build_contract(_strategy(), [], {})
    assert contract["watches"] == []
    assert contract["focusedWatchId"] is None
    assert contract["currentState"] is None
    assert contract["latestObservation"] is None
    assert contract["segments"] == []


# --- configuration -----------------------------------------------------------


def test_configuration_is_derived_from_the_strategy_rules():
    contract = build_contract(_strategy(), [], {})
    parameters = contract["configuration"]["parameters"]
    keys = [p["key"] for p in parameters]
    assert "timeframe" in keys
    # One toggle per rule the user actually has — not a fixed form.
    rule_keys = [k for k in keys if k.startswith("rule.")]
    assert len(rule_keys) == len(get_template("ema7_bullish_reclaim").rules["rules"])


def test_a_strategy_with_more_rules_gets_more_controls():
    """Proof the form is generated. A hardcoded form would produce the same
    number of controls for both."""
    seven = build_contract(_strategy("liquidity_sweep_fvg"), [], {})
    five = build_contract(_strategy("ema_9_21_pullback"), [], {})
    count = lambda c: len([p for p in c["configuration"]["parameters"] if p["key"].startswith("rule.")])
    assert count(seven) > count(five)


def test_mandatory_rules_are_locked_rather_than_switchable():
    """Turning one off leaves a strategy that shares its name with the one the
    user adopted and none of its meaning."""
    contract = build_contract(_strategy(), [], {})
    mandatory = [p for p in contract["configuration"]["parameters"] if p.get("group") == "mandatory"]
    assert mandatory and all(p["locked"] for p in mandatory)


def test_a_long_only_strategy_reports_no_short_side():
    contract = build_contract(_strategy("ema7_bullish_reclaim"), [], {})
    direction = next(p for p in contract["configuration"]["parameters"] if p["key"] == "direction")
    assert direction["value"] == "Long only"


def test_a_two_sided_strategy_says_so():
    contract = build_contract(_strategy("sr_flip"), [], {})
    direction = next(p for p in contract["configuration"]["parameters"] if p["key"] == "direction")
    assert direction["value"] == "Both directions"


# --- template identity -------------------------------------------------------


def test_an_adopted_strategy_reports_the_template_it_came_from():
    contract = build_contract(_strategy("vwap_bounce"), [], {})
    assert contract["template"]["id"] == "vwap_bounce"


def test_a_typed_strategy_is_not_attributed_to_a_template():
    """Reporting one would misattribute the user's own work."""
    typed = _strategy()
    typed["rawInput"] = "buy when the 7 EMA is reclaimed"
    contract = build_contract(typed, [], {})
    assert contract["template"]["id"] is None
    assert contract["template"]["available"] is True


# --- watches and focus -------------------------------------------------------


def test_active_watches_carry_their_own_lifecycle_checklist():
    contract = build_contract(_strategy(), [_watch()], {"w1": [_observation(1, met=3, total=4)]})
    watch = contract["watches"][0]
    assert watch["total"] == 4 and watch["met"] == 3
    assert len(watch["conditions"]) == 4


def test_the_card_and_the_focus_panel_show_the_same_conditions():
    """They come from one timeline call, so they cannot disagree."""
    contract = build_contract(_strategy(), [_watch()], {"w1": [_observation(1)]})
    assert contract["watches"][0]["conditions"] == contract["conditions"]


def test_a_specific_watch_can_be_focused():
    watches = [_watch("w1"), _watch("w2", state="CONFIRMED")]
    observations = {"w1": [_observation(1)], "w2": [_observation(2)]}
    contract = build_contract(_strategy(), watches, observations, focused_watch_id="w2")
    assert contract["focusedWatchId"] == "w2"
    assert contract["currentState"] == "CONFIRMED"


def test_an_unknown_focus_falls_back_rather_than_emptying_the_panel():
    contract = build_contract(_strategy(), [_watch()], {"w1": [_observation(1)]}, focused_watch_id="nope")
    assert contract["focusedWatchId"] == "w1"


def test_the_latest_observation_skips_sweeps_that_could_not_read_the_market():
    """A skipped sweep is why the user saw nothing; it is not what the market
    looked like."""
    skipped = _observation(0, metadata={"skipped": "market_data_unavailable"})
    contract = build_contract(_strategy(), [_watch()], {"w1": [skipped, _observation(1)]})
    assert contract["latestObservation"]["at"] == _observation(1)["createdAt"]


def test_observed_context_is_passed_through_untouched():
    """The backend does not decide what is interesting about a strategy it
    does not know the shape of."""
    metadata = {"pullback": {"classification": "normal", "depthAtr": 1.4}}
    contract = build_contract(_strategy(), [_watch()], {"w1": [_observation(1, metadata=metadata)]})
    assert contract["latestObservation"]["context"]["pullback"]["depthAtr"] == 1.4


# --- analytics ---------------------------------------------------------------


def test_no_analytics_are_offered_without_observations_to_support_them():
    """Three empty bars read as three findings. A dashboard that is mostly
    zeroes teaches people to ignore it."""
    contract = build_contract(_strategy(), [_watch()], {"w1": [_observation(1)]})
    assert contract["availableAnalytics"] == []
    assert contract["segments"] == []


def test_a_dimension_appears_once_its_measurement_is_recorded():
    observations = [
        _observation(i, metadata={"pullback": {"classification": "normal"}}) for i in range(3)
    ]
    contract = build_contract(_strategy("ema_9_21_pullback"), [_watch()], {"w1": observations})
    assert "pullbackDepth" in contract["availableAnalytics"]
    segment = next(s for s in contract["segments"] if s["id"] == "pullbackDepth")
    assert segment["samples"] == 3


def test_buckets_keep_their_declared_order():
    observations = [
        _observation(1, metadata={"pullback": {"classification": "deep"}}),
        _observation(2, metadata={"pullback": {"classification": "shallow"}}),
    ]
    segment = compute_segment("pullbackDepth", observations)
    assert [b["label"] for b in segment.to_dict()["buckets"]] == ["shallow", "normal", "deep"]


def test_liquidity_stage_buckets_by_how_far_the_sequence_got():
    observations = [
        _observation(1, metadata={"liquidity": {"stage": 7}}),
        _observation(2, metadata={"liquidity": {"stage": 2}}),
    ]
    segment = compute_segment("liquidityStage", observations)
    labels = {b["label"]: b["observations"] for b in segment.to_dict()["buckets"]}
    assert labels["continuation"] == 1
    assert labels["sweep"] == 1


def test_level_age_buckets_in_bars_not_minutes():
    observations = [
        _observation(1, metadata={"flip": {"ageBars": 5}}),
        _observation(2, metadata={"flip": {"ageBars": 80}}),
    ]
    segment = compute_segment("levelAge", observations)
    labels = {b["label"]: b["observations"] for b in segment.to_dict()["buckets"]}
    assert labels["fresh"] == 1 and labels["old"] == 1


def test_a_malformed_measurement_is_dropped_not_guessed_into_a_bucket():
    """An uncounted sample is honest; a miscounted one is not."""
    observations = [_observation(1, metadata={"liquidity": {"stage": "nonsense"}})]
    assert compute_segment("liquidityStage", observations) is None


def test_available_dimensions_reads_history_not_the_template():
    """A strategy adopted this morning that has not run yet has no analytics,
    whatever it is capable of measuring."""
    assert available_dimensions([]) == []


def test_confirmations_are_counted_per_bucket():
    observations = [
        _observation(1, met=4, total=4, metadata={"vwap": {"testOrdinal": "first"}}),
        _observation(2, met=1, total=4, metadata={"vwap": {"testOrdinal": "first"}}),
    ]
    segment = compute_segment("vwapTest", observations)
    first = next(b for b in segment.to_dict()["buckets"] if b["label"] == "first")
    assert first["observations"] == 2 and first["confirmations"] == 1


# --- performance -------------------------------------------------------------


def test_performance_is_included_and_says_when_the_sample_is_too_small():
    contract = build_contract(_strategy(), [_watch()], {"w1": [_observation(1)]})
    assert contract["performance"]["funnel"]["watches"] == 1
    assert contract["performance"]["sufficient"] is False
    assert "too few" in contract["performance"]["note"]
