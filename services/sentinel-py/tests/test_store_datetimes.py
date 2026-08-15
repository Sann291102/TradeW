"""Regression tests for the naive/aware datetime boundary.

Prisma maps DateTime to Postgres TIMESTAMP(3) — *without* time zone — and
asyncpg rejects an aware datetime for such a column. Every store write hit
this in the first end-to-end run; none of the mocked unit tests could see it
because they all replace the store. These test the conversion helpers
directly so the boundary rule is pinned without needing a database.
"""

from datetime import datetime, timedelta, timezone

from app.strategy.store import _aware, _naive, _now


def test_now_is_naive_but_still_utc():
    now = _now()
    assert now.tzinfo is None
    assert abs((now - datetime.utcnow()).total_seconds()) < 5


def test_naive_converts_aware_to_utc_without_moving_the_instant():
    ist = timezone(timedelta(hours=5, minutes=30))
    aware = datetime(2026, 8, 13, 15, 0, tzinfo=ist)  # 09:30 UTC
    converted = _naive(aware)
    assert converted.tzinfo is None
    assert converted == datetime(2026, 8, 13, 9, 30)


def test_naive_passes_through_already_naive_and_none():
    naive = datetime(2026, 8, 13, 9, 30)
    assert _naive(naive) is naive
    assert _naive(None) is None


def test_aware_reattaches_utc_so_state_machine_comparisons_work():
    """The state machine compares stored timestamps against
    datetime.now(timezone.utc); a naive row value would raise TypeError."""
    restored = _aware(datetime(2026, 8, 13, 9, 30))
    assert restored.tzinfo is timezone.utc
    # The comparison that used to explode.
    assert (datetime.now(timezone.utc) - restored).total_seconds() != 0


def test_aware_leaves_none_and_already_aware_alone():
    assert _aware(None) is None
    already = datetime(2026, 8, 13, 9, 30, tzinfo=timezone.utc)
    assert _aware(already) is already
