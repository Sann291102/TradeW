"""The NSE trading calendar, and the clock gate that reads it.

These tests exist for one reason: ``app/market/calendar.py`` is a hand-ported
copy of ``packages/market-data/src/calendar/nse-calendar.ts``, and a port drifts
silently. Pinning the dates here means a half-applied calendar update fails a
test instead of leaving the Python sweep watching on a day the TypeScript
engine considers shut.
"""

from datetime import datetime, timezone

from app.market.calendar import (
    NSE_HOLIDAYS_2026,
    is_holiday,
    is_trading_day,
    is_weekend,
    non_trading_reason,
)
from app.market.clock import is_market_open


def ist(iso: str) -> datetime:
    """A UTC instant for an IST wall clock written as 'YYYY-MM-DD HH:MM'."""
    day, hhmm = iso.split(" ")
    hour, minute = (int(x) for x in hhmm.split(":"))
    base = datetime.fromisoformat(f"{day}T00:00:00+00:00")
    return base.replace(tzinfo=timezone.utc) + _minutes(hour * 60 + minute - 330)


def _minutes(n: int):
    from datetime import timedelta

    return timedelta(minutes=n)


class TestCalendarData:
    def test_the_2026_list_is_the_one_the_typescript_package_carries(self):
        # Full equality, not a spot check: the point of this test is that the
        # two lists are the same list. Update BOTH files or fail here.
        assert NSE_HOLIDAYS_2026 == (
            "2026-01-26",
            "2026-03-03",
            "2026-03-26",
            "2026-03-31",
            "2026-04-03",
            "2026-04-14",
            "2026-05-01",
            "2026-05-27",
            "2026-06-26",
            "2026-08-26",
            "2026-10-02",
            "2026-10-20",
            "2026-11-09",
            "2026-11-10",
            "2026-11-24",
            "2026-12-25",
        )

    def test_the_list_is_sorted_and_free_of_duplicates(self):
        assert list(NSE_HOLIDAYS_2026) == sorted(set(NSE_HOLIDAYS_2026))

    def test_every_listed_holiday_is_a_weekday(self):
        # A weekend entry would imply this list is the reason the market is
        # shut, when the weekend check already closed the day.
        for day in NSE_HOLIDAYS_2026:
            assert not is_weekend(ist(f"{day} 11:00")), day

    def test_an_unknown_year_is_treated_as_all_trading_days(self):
        # Fail-open by design: a stale calendar must not silence the watcher
        # for a whole year. See the docstring on `is_holiday`.
        assert is_holiday(ist("2031-01-26 11:00")) is False
        assert is_trading_day(ist("2031-01-27 11:00")) is True  # a Monday


class TestTradingDay:
    def test_weekends_are_not_trading_days(self):
        assert is_trading_day(ist("2026-08-08 11:00")) is False  # Saturday
        assert is_trading_day(ist("2026-08-09 11:00")) is False  # Sunday

    def test_a_weekday_holiday_is_not_a_trading_day(self):
        # Ganesh Chaturthi 2026 is a Wednesday — the case a weekday check
        # structurally cannot catch, and the whole reason this module exists.
        assert is_weekend(ist("2026-08-26 11:00")) is False
        assert is_trading_day(ist("2026-08-26 11:00")) is False

    def test_a_normal_weekday_is_a_trading_day(self):
        assert is_trading_day(ist("2026-08-25 11:00")) is True  # Tuesday

    def test_the_reason_distinguishes_a_weekend_from_a_holiday(self):
        assert non_trading_reason(ist("2026-08-08 11:00")) == "weekend"
        assert non_trading_reason(ist("2026-08-26 11:00")) == "holiday"
        assert non_trading_reason(ist("2026-08-25 11:00")) is None

    def test_the_ist_day_decides_not_the_utc_day(self):
        # 19:00 UTC on Friday is already 00:30 Saturday in IST. A UTC-hosted
        # sweep must not treat that as a live Friday session.
        friday_late_utc = datetime(2026, 8, 7, 19, 0, tzinfo=timezone.utc)
        assert is_trading_day(friday_late_utc) is False


class TestClockGate:
    def test_the_market_is_shut_all_day_on_a_holiday(self):
        for hhmm in ("09:15", "11:00", "15:30"):
            assert is_market_open(ist(f"2026-08-26 {hhmm}")) is False, hhmm

    def test_the_market_is_shut_all_day_at_the_weekend(self):
        for hhmm in ("09:15", "11:00", "15:30"):
            assert is_market_open(ist(f"2026-08-08 {hhmm}")) is False, hhmm

    def test_session_hours_still_apply_on_a_trading_day(self):
        assert is_market_open(ist("2026-08-25 09:14")) is False
        assert is_market_open(ist("2026-08-25 09:15")) is True
        assert is_market_open(ist("2026-08-25 15:30")) is True
        assert is_market_open(ist("2026-08-25 15:31")) is False
