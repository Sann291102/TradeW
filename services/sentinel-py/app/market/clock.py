"""IST market clock — one place that knows NSE session boundaries.

Mirrors services/sentinel/src/market-clock.ts. Kept as a straight port rather
than shared over the wire: session boundaries are two integers and a
timezone, and a network hop to learn "is the market open" would be a worse
trade than the duplication.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

MARKET_OPEN_MIN = 9 * 60 + 15  # 09:15 IST
MARKET_CLOSE_MIN = 15 * 60 + 30  # 15:30 IST


def to_ist(at: datetime) -> datetime:
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return at.astimezone(IST)


def session_key(at: datetime) -> str:
    """'YYYY-MM-DD' in IST — the trading-day key used for dedup/cooldown."""
    return to_ist(at).strftime("%Y-%m-%d")


def minutes_since_midnight(at: datetime) -> int:
    ist = to_ist(at)
    return ist.hour * 60 + ist.minute


def is_market_open(at: datetime) -> bool:
    mins = minutes_since_midnight(at)
    return MARKET_OPEN_MIN <= mins <= MARKET_CLOSE_MIN and to_ist(at).weekday() < 5
