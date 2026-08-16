"""NSE trading-day calendar — which days the exchange is open.

Mirrors ``packages/market-data/src/calendar/nse-calendar.ts``, which is the
SOURCE OF TRUTH. Python cannot import the TypeScript package, so this is a
deliberate port in the same spirit as ``clock.py`` mirroring
``services/sentinel/src/market-clock.ts``.

**When NSE publishes next year's circular, edit the TypeScript file first and
then this one.** ``test_calendar.py`` pins the dates that are in this list so a
half-applied update fails a test rather than making one engine observe on a day
the other one considers shut.

Why the duplication is accepted here and rejected between the two TypeScript
services: ``services/api`` and ``services/sentinel`` share a runtime and could
import one module, so a copy there would be avoidable drift. Across the
language boundary the alternative is a network call to learn "is today a
trading day" — a dependency for two integers and a date list, on the exact code
path that decides whether to observe at all.

This module owns DAYS only. Session hours (09:15-15:30 IST) stay in
``clock.py``, matching the TypeScript split.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

# NSE trading holidays, IST calendar days as 'YYYY-MM-DD'. Full-day
# equity-segment closures only; Muhurat / special live sessions are trading
# days and are deliberately absent. Weekday closures only — holidays falling on
# a Saturday or Sunday are already closed by the weekend check, and listing
# them would imply this file is the reason.
#
# !! UNVERIFIED AGAINST THE OFFICIAL CIRCULAR !! Several of these are lunar and
# move year to year. Reconcile against NSE's published circular before launch.
NSE_HOLIDAYS_2026 = (
    "2026-01-26",  # Republic Day (Mon)
    "2026-03-03",  # Holi (Tue)
    "2026-03-26",  # Shri Ram Navami (Thu)
    "2026-03-31",  # Mahavir Jayanti (Tue)
    "2026-04-03",  # Good Friday (Fri)
    "2026-04-14",  # Dr. Baba Saheb Ambedkar Jayanti (Tue)
    "2026-05-01",  # Maharashtra Day (Fri)
    "2026-05-27",  # Bakri Id (Wed)
    "2026-06-26",  # Muharram (Fri)
    "2026-08-26",  # Ganesh Chaturthi (Wed)
    "2026-10-02",  # Mahatma Gandhi Jayanti (Fri)
    "2026-10-20",  # Dussehra (Tue)
    "2026-11-09",  # Diwali Laxmi Pujan (Mon)
    "2026-11-10",  # Diwali Balipratipada (Tue)
    "2026-11-24",  # Guru Nanak Jayanti (Tue)
    "2026-12-25",  # Christmas (Fri)
)

# Keyed by year so adding 2027 is one entry and every caller picks it up.
HOLIDAYS_BY_YEAR: dict[str, tuple[str, ...]] = {
    "2026": NSE_HOLIDAYS_2026,
}


def _to_ist(at: datetime) -> datetime:
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return at.astimezone(IST)


def date_key(at: datetime) -> str:
    """'YYYY-MM-DD' in IST — the trading-day key."""
    return _to_ist(at).strftime("%Y-%m-%d")


def is_weekend(at: datetime) -> bool:
    return _to_ist(at).weekday() >= 5


def is_holiday(at: datetime) -> bool:
    """True when `at` falls on a published NSE holiday.

    A year with no entry returns False — unknown is treated as a trading day.
    That is the safe direction: the worst case is sweeping a market that was
    shut, which costs cached calls. The opposite default would silently stop
    the watcher for a whole year the moment the calendar went stale, and a
    system that has gone quiet looks identical to one with nothing to say.
    """
    return date_key(at) in HOLIDAYS_BY_YEAR.get(date_key(at)[:4], ())


def is_trading_day(at: datetime) -> bool:
    """True on an NSE equity trading day — a weekday that is not a holiday."""
    return not is_weekend(at) and not is_holiday(at)


def non_trading_reason(at: datetime) -> str | None:
    """'weekend' | 'holiday' | None — why a watch is not being swept today.

    Exists because "Sentinel is not watching" needs a reason a user can read,
    and the two are different sentences: one is obvious to the trader looking
    at the screen, the other is the one they may have forgotten.
    """
    if is_weekend(at):
        return "weekend"
    if is_holiday(at):
        return "holiday"
    return None
