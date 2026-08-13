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


# --- in-trade templates (P4) ------------------------------------------------

from app.notify.dispatcher import INTRADE_TITLES, build_intrade_payload  # noqa: E402

IN_TRADE_WATCH = {**WATCH, "state": "IN_TRADE"}


@pytest.mark.parametrize("event", sorted(INTRADE_TITLES))
def test_every_intrade_template_passes_its_own_compliance_gate(event):
    """The in-trade phase is where forbidden wording is most tempting — the
    underlying numbers really are entries and stops. The surface still must
    not say so."""
    payload = build_intrade_payload(
        watch=IN_TRADE_WATCH,
        event=event,
        detail="price reached the invalidation level you set (242.0)",
        strategy_name="15-Min ORB",
        trading_day="2026-08-13",
        r_multiple=1.5,
        dedupe_suffix=event,
    )
    assert_compliant(payload["title"], payload["body"], payload["metadata"])
    assert payload["metadata"]["rMultiple"] == 1.5


def test_no_intrade_title_uses_forbidden_words():
    for title in INTRADE_TITLES.values():
        assert_compliant(title, "placeholder body", {})


def test_intrade_payload_carries_no_price_levels():
    """rMultiple is a measurement of what happened; entry/stop/target prices
    are levels to act on and stay off the notification."""
    payload = build_intrade_payload(
        watch=IN_TRADE_WATCH,
        event="milestone",
        detail="your position has moved 2:1 relative to the risk you defined",
        strategy_name="15-Min ORB",
        trading_day="2026-08-13",
        r_multiple=2.0,
        dedupe_suffix="milestone:2R",
    )
    keys = {k.lower() for k in payload["metadata"]}
    assert not keys & {"entryprice", "stoploss", "stopprice", "target", "targetprice"}
