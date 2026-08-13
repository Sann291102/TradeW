import pytest

from app.notify.compliance import ComplianceError, assert_compliant
from app.notify.dispatcher import build_payload, instrument_label
from app.watch.evaluator import EvaluationResult
from app.watch.state_machine import WatchState, advance

WATCH = {
    "id": "watch_1",
    "userId": "user_1",
    "strategyId": "strat_1",
    "symbol": "NIFTY",
    "strike": "24300",
    "optionType": "CE",
}


def transition(mandatory_met, mandatory_total):
    ev = EvaluationResult(
        rules=[],
        mandatory_total=mandatory_total,
        mandatory_met=mandatory_met,
        optional_total=0,
        optional_met=0,
        opening_range_high=110,
        opening_range_low=95,
    )
    return advance(WatchState.IDLE, ev, None, None)


def test_instrument_label_names_the_users_own_watch():
    assert instrument_label(WATCH) == "NIFTY 24300 CE"


def test_confirmed_payload_is_compliant_and_identifies_the_watch():
    payload = build_payload(WATCH, transition(2, 2), "15-Min ORB", "2026-08-13")
    assert payload["category"] == "sentinel"
    assert payload["title"] == "Side in Focus"
    assert "NIFTY 24300 CE" in payload["body"]
    assert payload["metadata"]["dedupeKey"] == "sentinel-py:watch_1:CONFIRMED"


def test_forming_payload_says_nothing_is_confirmed():
    payload = build_payload(WATCH, transition(1, 2), "15-Min ORB", "2026-08-13")
    assert payload["title"] == "Wait & Watch"
    assert "Nothing is confirmed yet" in payload["body"]


@pytest.mark.parametrize(
    "title,body",
    [
        ("Side in Focus", "Buy NIFTY now"),
        ("Side in Focus", "Set your stop-loss at 242"),
        ("Side in Focus", "We recommend this trade"),
        ("Side in Focus", "Target 250"),
    ],
)
def test_forbidden_language_is_rejected(title, body):
    with pytest.raises(ComplianceError):
        assert_compliant(title, body, {})


@pytest.mark.parametrize("key", ["entryPrice", "stopLoss", "target", "side"])
def test_forbidden_metadata_keys_are_rejected(key):
    """ARCH-4: a notification arrives stripped of the page that explains it.
    A price to enter at and a price to stop at IS a trade alert."""
    with pytest.raises(ComplianceError):
        assert_compliant("Side in Focus", "Your strategy has met its conditions.", {key: 1})


def test_every_generated_payload_passes_its_own_compliance_gate():
    for met, total in ((1, 2), (2, 2)):
        payload = build_payload(WATCH, transition(met, total), "15-Min ORB", "2026-08-13")
        assert_compliant(payload["title"], payload["body"], payload["metadata"])
