"""Directional context, read from the INDEX and from nothing else.

── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────

Until 2026-08-29 a sentinel-py option watch never read its index. The sweep
fetched the FOCUSED leg (to evaluate the user's rules on) and both legs (for
the observation record), and `fetch_index_candles` was reached only by a watch
that had no legs at all. So the workspace drew three charts, the watch stored
three instruments, and the engine read two — with whatever directional sense
the rules produced coming out of an option PREMIUM series.

That is the wrong series to ask. A call premium can fall on a rising index (IV
collapsing faster than delta pays, or theta into the afternoon) and both legs
can rise together when the market is bidding volatility ahead of an event. A
premium series answers "what did this contract do", never "which way is the
market going". Only the underlying answers the second question, so the
underlying is what is read here.

The index is the MARKET instrument. CE and PE are the TRADABLE contracts, and
their behaviour is read in the context this module establishes — never the
other way round.

── WHAT THIS IS NOT, AND THE RULE THAT MAKES THE DISTINCTION ───────────────

`aligned_side` is a MECHANICAL statement of fact: the index rose, and the call
is the leg whose direction agrees with a rising index. It is arithmetic on one
series, in the past tense.

It is not a ranking, not a score, and not a preference between strikes. Nothing
here reads premium, liquidity or volatility, nothing compares one strike to
another, and nothing here reaches a notification: `app/notify/compliance.py`
rejects a notification payload carrying a `side` or `bias` key outright, and
`tests/test_direction.py` asserts that this metadata stays on the observation
record where the evidence sits beside it. Ranking a ladder of strikes by
attractiveness would be a recommendation wearing a table (Rule 2); saying which
leg points the same way as the index is a description of the tape.
"""

from dataclasses import dataclass
from typing import Literal

from app.market.feed import Candle

Direction = Literal["rising", "falling", "flat"]
Side = Literal["CE", "PE"]

# How far the index must travel before the move is called directional.
#
# Mirrors INDEX_FLAT_BAND_PCT in
# services/sentinel/src/intelligence/contract-alignment.ts, deliberately: the
# two engines read the same instrument and disagreeing about what counts as a
# move would make their readings uncomparable. 0.05% is ~12 points on a 24,350
# NIFTY — a real drift rather than a quote flicker.
INDEX_FLAT_BAND_PCT = 0.05


@dataclass(frozen=True)
class IndexRead:
    """What the index did over the bars the engine actually read."""

    bars: int
    open: float
    last: float
    change_pct: float
    direction: Direction


def read_index(candles: list[Candle] | None) -> IndexRead | None:
    """The index's direction over `candles`, or None when there is nothing to
    read.

    None means "could not be read" and is never collapsed with 'flat'. A dead
    bridge and a still market are different facts, and reporting the first as
    the second renders an outage as calm conditions — the same distinction
    `_leg_summary` enforces on the legs.
    """
    if not candles:
        return None
    first, last = candles[0], candles[-1]
    if first.open == 0:
        return None
    change_pct = ((last.close - first.open) / first.open) * 100
    if change_pct > INDEX_FLAT_BAND_PCT:
        direction: Direction = "rising"
    elif change_pct < -INDEX_FLAT_BAND_PCT:
        direction = "falling"
    else:
        direction = "flat"
    return IndexRead(
        bars=len(candles),
        open=first.open,
        last=last.close,
        change_pct=round(change_pct, 4),
        direction=direction,
    )


def aligned_side(direction: Direction | None) -> Side | None:
    """The leg whose direction agrees with the index's.

    Rising index → the CALL is the aligned leg. Falling index → the PUT is.
    Flat, or an index that could not be read, aligns with NEITHER, and that is
    returned as None rather than defaulted to CE: a default would assert an
    alignment the tape did not show, on exactly the reading that is weakest.

    Both legs remain watched in every one of these cases. This names which one
    the index's move points at; it removes nothing.
    """
    if direction == "rising":
        return "CE"
    if direction == "falling":
        return "PE"
    return None


def describe(symbol: str, read: IndexRead | None, timeframe: str) -> str:
    """One past-tense sentence about what the index did. No imperative mood,
    no second person, no price to act on — see the module docstring."""
    if read is None:
        return f"{symbol} could not be read, so no directional context was established."
    if read.direction == "flat":
        return (
            f"{symbol} moved {read.change_pct:+.2f}% over {read.bars} {timeframe} bars — "
            f"inside the {INDEX_FLAT_BAND_PCT}% band, so neither leg was aligned with it."
        )
    verb = "rose" if read.direction == "rising" else "fell"
    side = aligned_side(read.direction)
    return (
        f"{symbol} {verb} {abs(read.change_pct):.2f}% over {read.bars} {timeframe} bars; "
        f"the {side} leg is the side aligned with that move."
    )


def _index_json(read: IndexRead | None) -> dict | None:
    """camelCase on the wire, snake_case in Python. The observation metadata is
    read by the TypeScript timeline and the admin portal, and a lone snake_case
    island in an otherwise camelCase record is a bug waiting to be typo'd."""
    if read is None:
        return None
    return {
        "bars": read.bars,
        "open": read.open,
        "last": read.last,
        "changePct": read.change_pct,
        "direction": read.direction,
    }


def market_context(
    symbol: str,
    candles: list[Candle] | None,
    unreadable: str | None,
    timeframe: str,
    focused_side: str | None,
) -> dict:
    """The directional record written onto every observation.

    `basis` is stated rather than implied. A later reader must be able to tell
    that the direction came from the INDEX and not from whichever premium
    series happened to be evaluated — that ambiguity is precisely what this
    module was written to end.
    """
    read = read_index(candles)
    side = aligned_side(read.direction if read else None)
    return {
        "symbol": symbol,
        "basis": "index",
        "timeframe": timeframe,
        "index": _index_json(read),
        "unreadable": unreadable if read is None else None,
        "direction": read.direction if read else None,
        # The leg the index's move points at. Compare it with `focusedSide` to
        # see whether the operator's chosen side and the index agreed on this
        # sweep — a question the pre-2026-08-29 record could not be asked.
        "alignedSide": side,
        "focusedSide": focused_side,
        "note": describe(symbol, read, timeframe),
    }
