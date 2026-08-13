"""End-to-end sweep: a strategy + a watch + a breakout-and-retest candle
sequence should land the watch in CONFIRMED and emit one notification."""

import pytest

from app.strategy.parser import parse_strategy_text
from app.watch import poller, store
from tests.conftest import candle, forming_tail

CONFIRMING_CANDLES = forming_tail(
    [
        candle(0, 100, 110, 95, 105),
        candle(15, 105, 115, 104, 114),  # break above OR high
        candle(30, 114, 115, 109, 111),  # retest
        candle(45, 111, 118, 110, 117),  # reclaim
    ]
)

FLAT_CANDLES = forming_tail([candle(0, 100, 110, 95, 105), candle(15, 105, 108, 100, 103)])


def watch_row(rules: dict, state: str = "IDLE") -> dict:
    return {
        "id": "watch_1",
        "userId": "user_1",
        "strategyId": "strat_1",
        "symbol": "NIFTY",
        "strike": None,
        "optionType": None,
        "expiry": None,
        "state": state,
        "lastNotifiedAt": None,
        "cooldownUntil": None,
        "strategyRules": rules,
    }


def parsed_rules() -> dict:
    parsed, _ = parse_strategy_text(
        "First 15 minute high low. Breakout above high, with retest. Stop loss at 10 points."
    )
    return parsed.model_dump()


@pytest.fixture
def captured(monkeypatch):
    bag = {"updates": [], "observations": [], "emitted": []}

    async def fake_update(**kwargs):
        bag["updates"].append((kwargs["watch_id"], kwargs["state"]))

    async def fake_observe(**kwargs):
        bag["observations"].append(kwargs)

    monkeypatch.setattr(store, "update_watch_state", fake_update)
    monkeypatch.setattr(store, "record_observation", fake_observe)
    async def fake_emit(watch, transition):
        bag["emitted"].append(transition)

    monkeypatch.setattr(poller, "_emit", fake_emit)
    return bag


@pytest.mark.asyncio
async def test_sweep_confirms_on_breakout_retest(monkeypatch, captured):
    async def fake_list():
        return [watch_row(parsed_rules())]

    async def fake_candles(symbol, interval="15m", days=1):
        return CONFIRMING_CANDLES

    monkeypatch.setattr(store, "list_active_watches", fake_list)
    monkeypatch.setattr(poller, "fetch_index_candles", fake_candles)

    evaluated = await poller.sweep_once()

    assert evaluated == 1
    assert captured["updates"] == [("watch_1", "CONFIRMED")]
    assert len(captured["emitted"]) == 1
    assert captured["emitted"][0].current.value == "CONFIRMED"


@pytest.mark.asyncio
async def test_sweep_stays_idle_and_silent_without_a_breakout(monkeypatch, captured):
    async def fake_list():
        return [watch_row(parsed_rules())]

    async def fake_candles(symbol, interval="15m", days=1):
        return FLAT_CANDLES

    monkeypatch.setattr(store, "list_active_watches", fake_list)
    monkeypatch.setattr(poller, "fetch_index_candles", fake_candles)

    await poller.sweep_once()

    assert captured["updates"] == [("watch_1", "IDLE")]
    assert captured["emitted"] == []
    # Silence is still recorded — the audit trail answers "why no alert?"
    assert len(captured["observations"]) == 1


@pytest.mark.asyncio
async def test_one_failing_watch_does_not_stop_the_others(monkeypatch, captured):
    async def fake_list():
        return [watch_row(parsed_rules()) | {"id": "bad"}, watch_row(parsed_rules())]

    calls = {"n": 0}

    async def fake_candles(symbol, interval="15m", days=1):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("bridge exploded")
        return CONFIRMING_CANDLES

    monkeypatch.setattr(store, "list_active_watches", fake_list)
    monkeypatch.setattr(poller, "fetch_index_candles", fake_candles)

    evaluated = await poller.sweep_once()

    assert evaluated == 1
    assert captured["updates"] == [("watch_1", "CONFIRMED")]


@pytest.mark.asyncio
async def test_unavailable_market_data_records_a_skip(monkeypatch, captured):
    from app.market.feed import MarketDataUnavailableError

    async def fake_list():
        return [watch_row(parsed_rules())]

    async def fake_candles(symbol, interval="15m", days=1):
        raise MarketDataUnavailableError("15m candles", "NIFTY")

    monkeypatch.setattr(store, "list_active_watches", fake_list)
    monkeypatch.setattr(poller, "fetch_index_candles", fake_candles)

    await poller.sweep_once()

    assert captured["emitted"] == []
    assert captured["observations"][0]["metadata"]["skipped"] == "market_data_unavailable"
