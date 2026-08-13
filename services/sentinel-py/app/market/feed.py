"""Candle fetcher — the Dhan live-feed bridge (services/market-data's
live-feed-server.ts, default port 4600).

REAL data only. When the bridge returns no candles, or `source != 'dhan'`,
this raises MarketDataUnavailableError rather than returning something
plausible. That mirrors the deliberate choice in
services/sentinel/src/market-data/candle-market-data.provider.ts: a watcher
that emits "your strategy conditions are met" off fabricated candles is
worse than one that says it is disconnected.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx


class MarketDataUnavailableError(Exception):
    def __init__(self, what: str, symbol: str | None = None):
        super().__init__(
            f"No real market data available{f' for {symbol}' if symbol else ''} ({what}). "
            "The Dhan live-feed bridge is unreachable or returned nothing. "
            "Sentinel does not substitute simulated data."
        )


@dataclass(frozen=True)
class Candle:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    open_interest: float | None = None


def _feed_url() -> str:
    return (os.environ.get("SENTINEL_LIVE_FEED_URL") or "http://localhost:4600").rstrip("/")


def _timeout() -> float:
    return float(os.environ.get("SENTINEL_LIVE_FEED_TIMEOUT_MS", "4000")) / 1000


def _to_candles(payload: dict, what: str, symbol: str) -> list[Candle]:
    if payload.get("source") != "dhan" or not payload.get("candles"):
        raise MarketDataUnavailableError(what, symbol)
    return [
        Candle(
            timestamp=datetime.fromtimestamp(c["timestamp"] / 1000, tz=timezone.utc),
            open=float(c["open"]),
            high=float(c["high"]),
            low=float(c["low"]),
            close=float(c["close"]),
            volume=float(c.get("volume") or 0),
            open_interest=c.get("openInterest"),
        )
        for c in payload["candles"]
    ]


async def fetch_index_candles(symbol: str, interval: str = "15m", days: int = 1) -> list[Candle]:
    """Spot/index candles — GET /candles on the bridge."""
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        try:
            resp = await client.get(
                f"{_feed_url()}/candles",
                params={"symbol": symbol, "interval": interval, "days": days},
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise MarketDataUnavailableError(f"{interval} candles", symbol) from exc
    return _to_candles(resp.json(), f"{interval} candles", symbol)


async def fetch_option_candles(
    symbol: str, expiry: str, strike: float, option_type: str, interval: str = "15m", days: int = 1
) -> list[Candle]:
    """Strike-level candles — GET /candles/option on the bridge. This is what
    a watch on (symbol, strike, CE/PE, expiry) actually reads."""
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        try:
            resp = await client.get(
                f"{_feed_url()}/candles/option",
                params={
                    "symbol": symbol,
                    "expiry": expiry,
                    "strike": strike,
                    "type": option_type,
                    "interval": interval,
                    "days": days,
                },
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise MarketDataUnavailableError(f"{interval} option candles", symbol) from exc
    return _to_candles(resp.json(), f"{interval} option candles", symbol)
