from datetime import datetime, timedelta

from app.market.clock import IST
from app.market.feed import Candle


def candle(minute_offset: int, open_: float, high: float, low: float, close: float, volume: float = 1000) -> Candle:
    """A candle at 09:15 IST + offset minutes on a fixed weekday (Mon 2026-08-10)."""
    base = datetime(2026, 8, 10, 9, 15, tzinfo=IST)
    return Candle(
        timestamp=base + timedelta(minutes=minute_offset),
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


def forming_tail(candles: list[Candle]) -> list[Candle]:
    """Append a still-forming candle, as the live bridge does during market
    hours. The evaluator must ignore it."""
    last = candles[-1]
    return candles + [Candle(last.timestamp + timedelta(minutes=15), last.close, last.close, last.close, last.close, 0)]
