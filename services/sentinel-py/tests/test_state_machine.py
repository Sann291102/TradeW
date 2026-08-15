from datetime import datetime, timedelta, timezone

from app.watch.evaluator import EvaluationResult
from app.watch.state_machine import Tier, WatchState, advance

NOW = datetime(2026, 8, 10, 5, 0, tzinfo=timezone.utc)


def result(mandatory_met, mandatory_total, optional_met=0, optional_total=0) -> EvaluationResult:
    return EvaluationResult(
        rules=[],
        mandatory_total=mandatory_total,
        mandatory_met=mandatory_met,
        optional_total=optional_total,
        optional_met=optional_met,
        opening_range_high=110,
        opening_range_low=95,
    )


def test_partial_rules_go_to_forming():
    t = advance(WatchState.IDLE, result(1, 2), None, None, now=NOW)
    assert t.current == WatchState.FORMING
    assert t.tier == Tier.WAIT_AND_WATCH
    assert t.should_notify


def test_all_mandatory_met_confirms_with_no_optional_rules():
    """The plan's literal rule (optional_met >= 1) would never confirm here."""
    t = advance(WatchState.FORMING, result(2, 2), None, None, now=NOW)
    assert t.current == WatchState.CONFIRMED
    assert t.tier == Tier.SIDE_IN_FOCUS


def test_optional_rule_is_required_only_when_one_exists():
    unmet = advance(WatchState.FORMING, result(2, 2, optional_met=0, optional_total=1), None, None, now=NOW)
    assert unmet.current == WatchState.FORMING

    met = advance(WatchState.FORMING, result(2, 2, optional_met=1, optional_total=1), None, None, now=NOW)
    assert met.current == WatchState.CONFIRMED


def test_cooldown_suppresses_repeat_of_same_state():
    recent = NOW - timedelta(minutes=3)
    t = advance(WatchState.FORMING, result(1, 2), recent, NOW + timedelta(minutes=12), now=NOW)
    assert t.current == WatchState.FORMING
    assert not t.changed
    assert not t.should_notify


def test_cooldown_does_not_suppress_a_forward_transition():
    """Reaching CONFIRMED is the event the user is waiting for — an active
    Wait & Watch cooldown must not swallow it."""
    recent = NOW - timedelta(minutes=3)
    t = advance(WatchState.FORMING, result(2, 2), recent, NOW + timedelta(minutes=12), now=NOW)
    assert t.current == WatchState.CONFIRMED
    assert t.changed
    assert t.should_notify


def test_repeat_notifies_again_after_cooldown_expires():
    old = NOW - timedelta(minutes=20)
    t = advance(WatchState.FORMING, result(1, 2), old, NOW - timedelta(minutes=5), now=NOW)
    assert t.should_notify


def test_no_rules_met_is_idle_and_silent():
    t = advance(WatchState.IDLE, result(0, 2), None, None, now=NOW)
    assert t.current == WatchState.IDLE
    assert not t.should_notify
