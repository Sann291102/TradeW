"""The INDEX is the market instrument, and the only source of direction.

The state these tests lock in, and the state they replaced:

    BEFORE  an option watch read its focused leg and both legs, and NEVER the
            index. `fetch_index_candles` was reachable only from a watch with
            no legs at all. Whatever directional sense the engine had came out
            of an option premium series.

    AFTER   every sweep reads the underlying as well, the direction is computed
            from it, and the leg the move points at is recorded beside the
            focused leg — without either leg ever being dropped.

The compliance boundary is asserted here too (Rule 2 / ARCH-4): `alignedSide`
is an observation-record field and must never reach a notification payload,
where `app/notify/compliance.py` rejects a `side`/`bias` key outright.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.market.feed import Candle, MarketDataUnavailableError
from app.notify import compliance
from app.watch import direction, poller


def series(*closes: float) -> list[Candle]:
    """Candles whose FIRST open and LAST close bracket the move under test."""
    base = datetime(2026, 8, 29, 9, 15, tzinfo=timezone.utc)
    return [
        Candle(
            timestamp=base + timedelta(minutes=15 * i),
            open=c,
            high=c,
            low=c,
            close=c,
            volume=1000,
        )
        for i, c in enumerate(closes)
    ]


def leg(strike: float, option_type: str) -> dict:
    return {
        "strike": strike,
        "optionType": option_type,
        "securityId": f"{option_type}-{int(strike)}",
        "exchangeSegment": "NSE_FNO",
        "tradingSymbol": f"NIFTY 01SEP {int(strike)} {option_type}",
        "dhanInstrument": "OPTIDX",
        "lotSize": 75,
        "tickSize": 0.05,
    }


WATCH = {
    "id": "watch_1",
    "symbol": "NIFTY",
    "expiry": "2026-09-01",
    "ce": leg(24200, "CE"),
    "pe": leg(24200, "PE"),
    "focusedSide": "CE",
}

UNDERLYING_WATCH = {
    "id": "watch_2",
    "symbol": "NIFTY",
    "expiry": None,
    "ce": None,
    "pe": None,
    "focusedSide": None,
    "strike": None,
    "optionType": None,
}


# ── 5 & 6. the mapping, from the index and from nothing else ────────────────


def test_a_rising_index_is_read_as_rising():
    read = direction.read_index(series(24_000, 24_100, 24_200))
    assert read.direction == "rising"
    assert read.change_pct == pytest.approx(0.8333, abs=1e-3)


def test_a_falling_index_is_read_as_falling():
    read = direction.read_index(series(24_200, 24_100, 24_000))
    assert read.direction == "falling"


def test_a_bullish_index_names_CE_as_the_aligned_leg():
    read = direction.read_index(series(24_000, 24_200))
    assert direction.aligned_side(read.direction) == "CE"


def test_a_bearish_index_names_PE_as_the_aligned_leg():
    read = direction.read_index(series(24_200, 24_000))
    assert direction.aligned_side(read.direction) == "PE"


def test_a_move_inside_the_band_is_flat_and_aligns_with_NEITHER_leg():
    """A default to CE here would assert an alignment the tape did not show,
    on exactly the reading that is weakest."""
    read = direction.read_index(series(24_200.0, 24_203.0))  # +0.012%, inside 0.05%
    assert read.direction == "flat"
    assert direction.aligned_side(read.direction) is None


def test_an_unreadable_index_aligns_with_neither_leg_rather_than_defaulting():
    assert direction.read_index([]) is None
    assert direction.read_index(None) is None
    assert direction.aligned_side(None) is None


def test_the_flat_band_matches_the_typescript_engine():
    """services/sentinel reads the same instrument. Two engines disagreeing
    about what counts as a move would make their readings uncomparable."""
    assert direction.INDEX_FLAT_BAND_PCT == 0.05


# ── the record: what the direction was read FROM ────────────────────────────


def test_the_context_states_that_the_direction_came_from_the_index():
    ctx = direction.market_context("NIFTY", series(24_000, 24_200), None, "15m", "PE")
    assert ctx["basis"] == "index"
    assert ctx["direction"] == "rising"
    assert ctx["alignedSide"] == "CE"
    # Recorded side by side, so a later reader can see when the operator's
    # chosen side and the index's move disagreed.
    assert ctx["focusedSide"] == "PE"
    assert ctx["index"]["bars"] == 2


def test_an_unreadable_index_is_named_not_zeroed():
    ctx = direction.market_context("NIFTY", None, "bridge refused", "15m", "CE")
    assert ctx["index"] is None
    assert ctx["unreadable"] == "bridge refused"
    assert ctx["direction"] is None
    assert ctx["alignedSide"] is None


def test_every_note_is_past_tense_and_carries_no_directive_language():
    """The one place this module produces prose. It goes nowhere near a
    notification, but a template that could not survive the compliance gate is
    a template that will eventually be pasted into one."""
    for candles in (series(24_000, 24_200), series(24_200, 24_000), series(24_200, 24_201), None):
        note = direction.describe("NIFTY", direction.read_index(candles), "15m")
        compliance.assert_clean_text(note)


def test_the_aligned_side_never_becomes_a_notification_field():
    """Rule 2 / ARCH-4: `side` and `bias` are forbidden notification metadata.
    The alignment lives on the observation record, where the evidence sits
    beside it."""
    with pytest.raises(compliance.ComplianceError):
        compliance.assert_clean_metadata({"side": "CE"})
    with pytest.raises(compliance.ComplianceError):
        compliance.assert_clean_metadata({"bias": "bullish"})
    # The observation record is not a notification and is not gated by it.
    ctx = direction.market_context("NIFTY", series(24_000, 24_200), None, "15m", "CE")
    assert ctx["alignedSide"] == "CE"


# ── 4. the watcher actually reads the index ─────────────────────────────────


@pytest.fixture
def bridge(monkeypatch):
    """Records every bridge call the sweep makes, by instrument."""
    calls: list[dict] = []

    async def fake_index(**kwargs):
        calls.append({"kind": "index", **kwargs})
        return series(24_000, 24_200)

    async def fake_option(**kwargs):
        calls.append({"kind": "option", **kwargs})
        return series(100.0, 120.0)

    monkeypatch.setattr(poller, "fetch_index_candles", fake_index)
    monkeypatch.setattr(poller, "fetch_option_candles", fake_option)
    return calls


@pytest.mark.asyncio
async def test_an_option_watch_reads_the_INDEX_as_well_as_both_legs(bridge):
    """The whole point. Three instruments, one sweep."""
    await poller._candles_for(WATCH, "15m")
    await poller._read_index(WATCH, "15m", None)
    await poller._read_pair(WATCH, "15m")

    assert any(c["kind"] == "index" and c["symbol"] == "NIFTY" for c in bridge)
    option_sides = {c["option_type"] for c in bridge if c["kind"] == "option"}
    assert option_sides == {"CE", "PE"}


@pytest.mark.asyncio
async def test_the_index_is_read_on_the_bars_the_engine_evaluates(bridge):
    await poller._read_index(WATCH, "5m", None)
    index = [c for c in bridge if c["kind"] == "index"]
    assert index[0]["interval"] == "5m"


@pytest.mark.asyncio
async def test_an_underlying_watch_does_not_read_the_index_twice(bridge):
    """It already evaluates on the index. Re-fetching would double the bridge
    call for the watches that were reading it correctly all along."""
    already = series(24_000, 24_200)
    candles, error = await poller._read_index(UNDERLYING_WATCH, "15m", already)
    assert candles is already
    assert error is None
    assert [c for c in bridge if c["kind"] == "index"] == []


@pytest.mark.asyncio
async def test_a_dead_index_is_named_and_does_not_stop_the_sweep(monkeypatch):
    async def dead(**kwargs):
        raise MarketDataUnavailableError("15m candles", "NIFTY")

    monkeypatch.setattr(poller, "fetch_index_candles", dead)
    candles, error = await poller._read_index(WATCH, "15m", None)
    assert candles is None
    assert "NIFTY" in error


@pytest.mark.asyncio
async def test_an_unexpected_index_failure_is_swallowed_too(monkeypatch):
    async def broken(**kwargs):
        raise RuntimeError("socket hang up")

    monkeypatch.setattr(poller, "fetch_index_candles", broken)
    candles, error = await poller._read_index(WATCH, "15m", None)
    assert candles is None
    assert "socket hang up" in error


# ── 7 & 8. focus never removes a contract from the watch ────────────────────


@pytest.mark.asyncio
async def test_both_legs_are_read_whichever_side_is_in_focus(bridge):
    for focused in ("CE", "PE"):
        bridge.clear()
        pair = await poller._read_pair({**WATCH, "focusedSide": focused}, "15m")
        assert pair["ce"]["strike"] == 24_200
        assert pair["pe"]["strike"] == 24_200
        assert {c["option_type"] for c in bridge if c["kind"] == "option"} == {"CE", "PE"}


@pytest.mark.asyncio
async def test_the_index_is_read_whichever_side_is_in_focus(bridge):
    for focused in ("CE", "PE"):
        bridge.clear()
        await poller._read_index({**WATCH, "focusedSide": focused}, "15m", None)
        assert [c for c in bridge if c["kind"] == "index"]


@pytest.mark.asyncio
async def test_the_direction_is_the_same_whichever_side_is_in_focus(bridge):
    """Focus is the operator's preferred trade side. It is not an input to the
    market's direction, and a reading that moved with it would be a reading of
    the operator rather than of the tape."""
    contexts = []
    for focused in ("CE", "PE"):
        candles, error = await poller._read_index({**WATCH, "focusedSide": focused}, "15m", None)
        contexts.append(
            direction.market_context("NIFTY", candles, error, "15m", focused)
        )
    assert contexts[0]["direction"] == contexts[1]["direction"] == "rising"
    assert contexts[0]["alignedSide"] == contexts[1]["alignedSide"] == "CE"
    # Only the record of WHO was focused differs.
    assert (contexts[0]["focusedSide"], contexts[1]["focusedSide"]) == ("CE", "PE")


# ── end to end: one sweep, three instruments, one record ────────────────────


@pytest.fixture
def swept(monkeypatch):
    """A full `sweep_once` over ONE option watch, with the store faked out.

    Asserts against what the sweep actually did rather than against the helpers
    in isolation — the failure this guards is a helper that reads the index
    correctly while `sweep_once` never calls it.
    """
    from app.watch import store

    bag = {"observations": [], "index_calls": [], "option_calls": []}

    row = {
        "id": "watch_1",
        "userId": "user_1",
        "strategyId": "strat_1",
        "symbol": "NIFTY",
        "strike": "24200",
        "optionType": "CE",
        "expiry": "2026-09-01",
        "ce": leg(24200, "CE"),
        "pe": leg(24200, "PE"),
        "focusedSide": "CE",
        "watchMode": "option",
        "state": "IDLE",
        "lastNotifiedAt": None,
        "cooldownUntil": None,
        "strategyRules": {"timeframe": "15m", "rules": []},
    }

    async def fake_list():
        return [row]

    async def fake_index(**kwargs):
        bag["index_calls"].append(kwargs)
        return series(24_000, 24_100, 24_200)  # +0.83%, rising

    async def fake_option(**kwargs):
        bag["option_calls"].append(kwargs)
        return series(100.0, 120.0)

    async def fake_update(**kwargs):
        pass

    async def fake_observe(**kwargs):
        bag["observations"].append(kwargs)

    monkeypatch.setattr(store, "list_active_watches", fake_list)
    monkeypatch.setattr(store, "update_watch_state", fake_update)
    monkeypatch.setattr(store, "record_observation", fake_observe)
    monkeypatch.setattr(poller, "fetch_index_candles", fake_index)
    monkeypatch.setattr(poller, "fetch_option_candles", fake_option)
    bag["row"] = row
    return bag


@pytest.mark.asyncio
async def test_one_sweep_reads_the_index_and_BOTH_legs(swept):
    evaluated = await poller.sweep_once()

    assert evaluated == 1
    assert [c["symbol"] for c in swept["index_calls"]] == ["NIFTY"]
    # The focused leg for the evaluation, then both legs for the pair.
    assert [c["option_type"] for c in swept["option_calls"]] == ["CE", "CE", "PE"]


@pytest.mark.asyncio
async def test_the_observation_records_the_index_as_the_basis_of_direction(swept):
    await poller.sweep_once()

    market = swept["observations"][0]["metadata"]["marketContext"]
    assert market["basis"] == "index"
    assert market["symbol"] == "NIFTY"
    assert market["direction"] == "rising"
    assert market["alignedSide"] == "CE"
    assert market["index"]["bars"] == 3


@pytest.mark.asyncio
async def test_a_bearish_index_records_PE_as_the_aligned_leg(swept, monkeypatch):
    async def falling(**kwargs):
        swept["index_calls"].append(kwargs)
        return series(24_200, 24_100, 24_000)

    monkeypatch.setattr(poller, "fetch_index_candles", falling)
    await poller.sweep_once()

    market = swept["observations"][0]["metadata"]["marketContext"]
    assert market["direction"] == "falling"
    assert market["alignedSide"] == "PE"


@pytest.mark.asyncio
async def test_the_pair_survives_the_index_read(swept):
    """Adding the index must not have cost a leg."""
    await poller.sweep_once()

    pair = swept["observations"][0]["metadata"]["optionPair"]
    assert pair["ce"]["securityId"] == "CE-24200"
    assert pair["pe"]["securityId"] == "PE-24200"


@pytest.mark.asyncio
async def test_a_sweep_survives_an_unreadable_index(swept, monkeypatch):
    """The legs read fine. A dead index costs the directional context and
    nothing else — it must not skip the watch."""

    async def dead(**kwargs):
        raise MarketDataUnavailableError("15m candles", "NIFTY")

    monkeypatch.setattr(poller, "fetch_index_candles", dead)
    evaluated = await poller.sweep_once()

    assert evaluated == 1
    market = swept["observations"][0]["metadata"]["marketContext"]
    assert market["index"] is None
    assert market["alignedSide"] is None
    assert "NIFTY" in market["unreadable"]
    # The legs are still there.
    assert swept["observations"][0]["metadata"]["optionPair"]["pe"]["close"] == 120.0


@pytest.mark.asyncio
async def test_a_legacy_single_leg_watch_still_gets_its_index(bridge):
    """A pre-2026-08-18 row names one leg through the shim. It is still an
    option watch, so it still needs the index its direction is read from."""
    legacy = {
        "id": "watch_3",
        "symbol": "NIFTY",
        "expiry": "2026-09-01",
        "strike": "24200",
        "optionType": "CE",
        "ce": None,
        "pe": None,
    }
    candles, error = await poller._read_index(legacy, "15m", None)
    assert error is None
    assert direction.read_index(candles).direction == "rising"
    assert [c for c in bridge if c["kind"] == "index"]


@pytest.mark.asyncio
async def test_an_option_row_with_no_expiry_reuses_the_evaluation_series(bridge):
    """`_candles_for` falls back to the index when a leg cannot be addressed
    for want of an expiry. Re-fetching it here would be the same call twice."""
    already = series(24_000, 24_200)
    unaddressable = {**WATCH, "expiry": None}
    candles, error = await poller._read_index(unaddressable, "15m", already)
    assert candles is already
    assert error is None
    assert [c for c in bridge if c["kind"] == "index"] == []
