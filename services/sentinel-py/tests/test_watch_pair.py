"""The watch is an option PAIR, end to end through the Python service.

Requirements 6 and 7 of the dual-strike brief: the backend accepts and persists
both instruments, and the sweep engine receives both.

The failure being guarded against is a quiet one. A watch used to name ONE leg
(`strike` + `optionType`), chosen by the CE/PE toggle in the workspace, while
the screen showed a call chart and a put chart side by side. Sentinel's job is
to decide which of the two legs is expressing the underlying's move; it could
never do that, and nothing on screen said so.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.auth import require_service_token
from app.main import app
from app.market.feed import Candle, MarketDataUnavailableError
from app.strategy import store as strategy_store
from app.watch import poller, store as watch_store

STRATEGY = {
    "id": "strat_1",
    "userId": "user_1",
    "name": "15-Min ORB",
    "rules": {"timeframe": "15m", "levels": [], "rules": [], "entry": {}, "riskManagement": {"targets": []}},
    "rawInput": "breakout above high",
    "inputType": "text",
    "status": "active",
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}


def leg(strike: float, option_type: str) -> dict:
    return {
        "strike": strike,
        "optionType": option_type,
        "securityId": f"{option_type}-{int(strike)}",
        "exchangeSegment": "NSE_FNO",
        "tradingSymbol": f"NIFTY 18AUG {int(strike)} {option_type}",
        "dhanInstrument": "OPTIDX",
        "lotSize": 75,
        "tickSize": 0.05,
    }


def pair_request(**over) -> dict:
    body = {
        "strategyId": "strat_1",
        "symbol": "NIFTY",
        "expiry": "2026-08-18",
        "ce": leg(24200, "CE"),
        "pe": leg(24100, "PE"),
        "focusedSide": "CE",
        "watchMode": "option",
        "timeframe": "15m",
    }
    body.update(over)
    return body


@pytest.fixture
def created(monkeypatch):
    """Captures the arguments `create_watch` was called with, so the test can
    assert what would have been PERSISTED without needing Postgres."""
    calls: list[dict] = []

    async def _noop():
        return None

    async def fake_get(user_id, strategy_id):
        return STRATEGY if strategy_id == "strat_1" else None

    async def fake_create(**kwargs):
        calls.append(kwargs)
        # Echo the row back the way `_watch_to_dict` would, so the response
        # shape is asserted too rather than only the write.
        return {
            "id": "watch_1",
            "userId": kwargs["user_id"],
            "strategyId": kwargs["strategy_id"],
            "symbol": kwargs["symbol"],
            "strike": None if kwargs["ce"] is None else str(kwargs["ce"]["strike"]),
            "optionType": kwargs["focused_side"],
            "expiry": kwargs["expiry"],
            "ce": kwargs["ce"],
            "pe": kwargs["pe"],
            "focusedSide": kwargs["focused_side"],
            "watchMode": kwargs["watch_mode"],
            "timeframe": kwargs["timeframe"],
            "state": "IDLE",
        }

    monkeypatch.setattr(strategy_store, "init_pool", _noop)
    monkeypatch.setattr(strategy_store, "close_pool", _noop)
    monkeypatch.setattr(strategy_store, "get_strategy", fake_get)
    monkeypatch.setattr(watch_store, "create_watch", fake_create)

    app.dependency_overrides[require_service_token] = lambda: None
    with TestClient(app) as client:
        yield client, calls
    app.dependency_overrides.clear()


# ── 6. the backend accepts and persists both instruments ────────────────────


def test_accepts_a_pair_and_persists_both_legs(created):
    client, calls = created
    res = client.post("/watch?userId=user_1", json=pair_request())

    assert res.status_code == 201
    assert len(calls) == 1
    written = calls[0]
    assert written["ce"]["strike"] == 24200
    assert written["ce"]["securityId"] == "CE-24200"
    assert written["pe"]["strike"] == 24100
    assert written["pe"]["securityId"] == "PE-24100"
    assert written["focused_side"] == "CE"
    assert written["watch_mode"] == "option"
    assert written["timeframe"] == "15m"


def test_the_response_carries_both_legs_back(created):
    client, _ = created
    body = client.post("/watch?userId=user_1", json=pair_request()).json()
    assert body["ce"]["strike"] == 24200
    assert body["pe"]["strike"] == 24100
    assert body["focusedSide"] == "CE"


def test_persists_the_full_instrument_identity_not_just_the_strike(created):
    client, calls = created
    client.post("/watch?userId=user_1", json=pair_request())
    for side in ("ce", "pe"):
        written = calls[0][side]
        assert written["exchangeSegment"] == "NSE_FNO"
        assert written["dhanInstrument"] == "OPTIDX"
        assert written["lotSize"] == 75
        assert written["tickSize"] == 0.05


def test_rejects_a_half_configured_pair(created):
    """A single-leg watch is the thing this replaced, arriving under a new
    field name. It is refused rather than silently accepted as half a pair."""
    client, calls = created
    for missing in ("ce", "pe"):
        res = client.post("/watch?userId=user_1", json=pair_request(**{missing: None}))
        assert res.status_code == 400
        assert missing in res.json()["detail"]
    assert calls == []


def test_rejects_a_pe_contract_in_the_ce_slot(created):
    """The last of three guards on this property — the UI's ladders are
    separate and the bridge re-checks the side it returns. This refuses a
    payload that got past both, because Sentinel observing a put while every
    screen says call is undetectable from the outside."""
    client, calls = created
    res = client.post("/watch?userId=user_1", json=pair_request(ce=leg(24200, "PE")))
    assert res.status_code == 400
    assert "ce leg must be a CE contract" in res.json()["detail"]
    assert calls == []


def test_rejects_a_ce_contract_in_the_pe_slot(created):
    client, calls = created
    res = client.post("/watch?userId=user_1", json=pair_request(pe=leg(24100, "CE")))
    assert res.status_code == 400
    assert "pe leg must be a PE contract" in res.json()["detail"]
    assert calls == []


def test_rejects_a_leg_with_no_resolved_token(created):
    """A strike number is not an instrument. A leg without a securityId cannot
    be addressed on the feed or the historical API, so it is refused rather
    than stored as a half-identified contract."""
    client, calls = created
    res = client.post("/watch?userId=user_1", json=pair_request(ce=leg(24200, "CE") | {"securityId": ""}))
    assert res.status_code == 400
    assert calls == []


def test_rejects_an_option_watch_with_no_expiry(created):
    client, calls = created
    res = client.post("/watch?userId=user_1", json=pair_request(expiry=None))
    assert res.status_code == 400
    assert calls == []


def test_an_underlying_watch_carries_no_legs(created):
    client, calls = created
    res = client.post(
        "/watch?userId=user_1",
        json=pair_request(ce=None, pe=None, expiry=None, watchMode="underlying"),
    )
    assert res.status_code == 201
    assert calls[0]["ce"] is None and calls[0]["pe"] is None
    assert calls[0]["watch_mode"] == "underlying"


def test_rejects_an_underlying_watch_that_still_names_legs(created):
    client, calls = created
    res = client.post("/watch?userId=user_1", json=pair_request(watchMode="underlying"))
    assert res.status_code == 400
    assert calls == []


# ── the legacy shim ─────────────────────────────────────────────────────────


def test_legs_of_reads_a_pair_row_as_a_pair():
    row = {"ce": leg(24200, "CE"), "pe": leg(24100, "PE"), "focusedSide": "PE"}
    ce, pe, focused = watch_store._legs_of(row)
    assert ce["strike"] == 24200
    assert pe["strike"] == 24100
    assert focused == "PE"


def test_legs_of_reconstructs_a_legacy_row_without_inventing_the_other_half():
    """A pre-2026-08-18 row names one leg. The shim returns that leg and NOTHING
    for the other — a row that says nothing about a put must not be read as a
    complete pair, and the token it never had is empty rather than fabricated."""
    row = {"strike": "24200", "optionType": "CE", "ce": None, "pe": None}
    ce, pe, focused = watch_store._legs_of(row)
    assert ce["strike"] == 24200
    assert ce["securityId"] == ""
    assert pe is None
    assert focused == "CE"


def test_legs_of_reports_no_legs_for_an_underlying_row():
    ce, pe, focused = watch_store._legs_of({"strike": None, "optionType": None, "ce": None, "pe": None})
    assert (ce, pe, focused) == (None, None, None)


# ── 7. Sentinel receives both instruments ───────────────────────────────────


def _candle(close: float) -> Candle:
    return Candle(
        timestamp=datetime(2026, 8, 18, 9, 30, tzinfo=timezone.utc),
        open=close,
        high=close,
        low=close,
        close=close,
        volume=100,
    )


@pytest.fixture
def fetched(monkeypatch):
    """Records every option-candle fetch the sweep makes, so the test can assert
    which contracts Sentinel actually read."""
    calls: list[dict] = []

    async def fake_option_candles(**kwargs):
        calls.append(kwargs)
        return [_candle(120.0 if kwargs["option_type"] == "CE" else 95.0)]

    monkeypatch.setattr(poller, "fetch_option_candles", fake_option_candles)
    return calls


WATCH = {
    "id": "watch_1",
    "symbol": "NIFTY",
    "expiry": "2026-08-18",
    "ce": leg(24200, "CE"),
    "pe": leg(24100, "PE"),
    "focusedSide": "CE",
}


@pytest.mark.asyncio
async def test_the_sweep_reads_both_legs(fetched):
    pair = await poller._read_pair(WATCH, "15m")

    assert {c["option_type"] for c in fetched} == {"CE", "PE"}
    assert pair["ce"]["strike"] == 24200
    assert pair["pe"]["strike"] == 24100
    assert pair["ce"]["close"] == 120.0
    assert pair["pe"]["close"] == 95.0


@pytest.mark.asyncio
async def test_each_leg_is_addressed_by_its_stored_token(fetched):
    """The securityId travels to the bridge, which verifies it against its own
    scrip-master resolution. That is what makes 'the chart and the engine are on
    the same contract' a checked fact rather than two lookups that agree today."""
    await poller._read_pair(WATCH, "15m")

    by_side = {c["option_type"]: c for c in fetched}
    assert by_side["CE"]["security_id"] == "CE-24200"
    assert by_side["PE"]["security_id"] == "PE-24100"


@pytest.mark.asyncio
async def test_the_observation_records_which_contract_each_reading_came_from(fetched):
    pair = await poller._read_pair(WATCH, "15m")

    assert pair["ce"]["securityId"] == "CE-24200"
    assert pair["pe"]["securityId"] == "PE-24100"
    # Stated, not implied: without it a reader cannot tell whether a met
    # condition came from the call or the put.
    assert pair["focusedSide"] == "CE"
    assert pair["timeframe"] == "15m"


@pytest.mark.asyncio
async def test_the_rules_evaluate_on_the_FOCUSED_leg(fetched):
    """Both legs are read; the user's rule set still runs on one series. Which
    one is stated by `focusedSide` rather than left to the order of the fetch."""
    await poller._candles_for(WATCH, "15m")
    assert len(fetched) == 1
    assert fetched[0]["option_type"] == "CE"

    fetched.clear()
    await poller._candles_for({**WATCH, "focusedSide": "PE"}, "15m")
    assert fetched[0]["option_type"] == "PE"
    assert fetched[0]["strike"] == 24100


@pytest.mark.asyncio
async def test_an_unreadable_leg_is_named_not_zeroed(monkeypatch):
    """'Could not be read' and 'did not move' are different facts. Collapsing
    them renders a dead bridge as a calm market."""

    async def half_dead(**kwargs):
        if kwargs["option_type"] == "PE":
            raise MarketDataUnavailableError("15m option candles", "NIFTY")
        return [_candle(120.0)]

    monkeypatch.setattr(poller, "fetch_option_candles", half_dead)
    pair = await poller._read_pair(WATCH, "15m")

    assert pair["ce"]["close"] == 120.0
    assert pair["pe"]["close"] is None
    assert "unreadable" in pair["pe"]
    # The strike is still named, so the panel can say WHICH contract went dark.
    assert pair["pe"]["strike"] == 24100


@pytest.mark.asyncio
async def test_a_dead_leg_does_not_stop_the_sweep(monkeypatch):
    async def all_dead(**kwargs):
        raise MarketDataUnavailableError("15m option candles", "NIFTY")

    monkeypatch.setattr(poller, "fetch_option_candles", all_dead)
    # Context, not the evaluation series: it must degrade rather than raise.
    pair = await poller._read_pair(WATCH, "15m")
    assert pair["ce"]["close"] is None
    assert pair["pe"]["close"] is None


@pytest.mark.asyncio
async def test_a_legacy_single_leg_watch_still_reads_its_one_contract(fetched):
    """The shim keeps pre-existing watches working: one leg named, one read,
    and no invented opposite."""
    legacy = {"id": "w", "symbol": "NIFTY", "expiry": "2026-08-18", "strike": "24200", "optionType": "CE"}
    pair = await poller._read_pair(legacy, "15m")

    assert len(fetched) == 1
    assert pair["ce"]["strike"] == 24200
    assert pair["pe"] is None
    # A legacy row has no token, so the bridge resolves by strike as it always did.
    assert fetched[0]["security_id"] is None


@pytest.mark.asyncio
async def test_an_underlying_watch_reads_no_legs(fetched):
    assert await poller._read_pair({"id": "w", "symbol": "NIFTY", "expiry": None}, "15m") is None
    assert fetched == []


# ── the alert names the pair, in the same words the workspace does ──────────


def test_the_notification_names_BOTH_legs():
    """An alert that printed only the focused leg would tell the user their
    strategy fired on one contract while the watch they created is a pair."""
    from app.notify.dispatcher import instrument_label

    label = instrument_label(
        {"symbol": "NIFTY", "expiry": "2026-08-18", "ce": leg(24200, "CE"), "pe": leg(24100, "PE")}
    )
    assert label == "NIFTY 18 AUG 24200 CE / 24100 PE"


def test_the_notification_label_matches_the_web_one_for_a_legacy_row():
    from app.notify.dispatcher import instrument_label

    assert (
        instrument_label({"symbol": "NIFTY", "expiry": "2026-08-18", "strike": "24200", "optionType": "CE"})
        == "NIFTY 18 AUG 24200 CE"
    )


def test_the_notification_names_the_underlying_when_there_are_no_legs():
    from app.notify.dispatcher import instrument_label

    assert instrument_label({"symbol": "NIFTY", "expiry": None}) == "NIFTY"


def test_the_expiry_tag_is_locale_independent():
    """Formatted by hand rather than with strftime: %b is locale-dependent, and
    a service under a non-English locale would emit a month the web app never
    produces, breaking the shared-vocabulary guarantee."""
    from app.notify.dispatcher import _expiry_tag

    assert _expiry_tag("2026-08-18") == "18 AUG"
    assert _expiry_tag("2026-01-01") == "01 JAN"
    assert _expiry_tag("2026-12-31") == "31 DEC"
    # Malformed input is empty, never a partial or wrong date.
    assert _expiry_tag(None) == ""
    assert _expiry_tag("not-a-date") == ""
    assert _expiry_tag("2026-13-01") == ""
