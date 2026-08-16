"""IST market clock — one place that knows NSE session boundaries.

Mirrors services/sentinel/src/market-clock.ts. Kept as a straight port rather
than shared over the wire: session boundaries are two integers and a
timezone, and a network hop to learn "is the market open" would be a worse
trade than the duplication.

Session HOURS live here; which days the exchange trades lives in
``calendar.py`` (the port of ``@tradew/market-data``'s ``nse-calendar.ts``),
mirroring the same split on the TypeScript side. ``is_market_open`` was already
weekday-aware but holiday-blind, so the sweep loop ran all through an NSE
holiday and found nothing — fixed 2026-08-16 by reading the calendar.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.market.calendar import IST as _CALENDAR_IST
from app.market.calendar import is_trading_day, non_trading_reason

IST = ZoneInfo("Asia/Kolkata")

# The calendar and the clock must never disagree about what "today" is.
assert IST.key == _CALENDAR_IST.key

__all__ = [
    "IST",
    "MARKET_OPEN_MIN",
    "MARKET_CLOSE_MIN",
    "to_ist",
    "session_key",
    "minutes_since_midnight",
    "minutes_to_close",
    "is_market_open",
    "is_trading_day",
    "non_trading_reason",
]

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


def minutes_to_close(at: datetime) -> int:
    """Minutes remaining in the session. Negative after the close, and large
    before the open — callers asking "are we late in the day?" get a number
    that is honest outside market hours instead of a clamped zero."""
    return MARKET_CLOSE_MIN - minutes_since_midnight(at)


def is_market_open(at: datetime) -> bool:
    """True inside NSE regular hours ON A TRADING DAY.

    The calendar check is first and non-negotiable: a weekend or holiday is
    closed at every hour, so no caller can reach the time-of-day comparison and
    conclude the market is open on a day the exchange never opened. This is the
    single gate the sweep loop in ``app/watch/poller.py`` runs on.
    """
    if not is_trading_day(at):
        return False
    mins = minutes_since_midnight(at)
    return MARKET_OPEN_MIN <= mins <= MARKET_CLOSE_MIN
