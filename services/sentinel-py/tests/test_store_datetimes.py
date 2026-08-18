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


# ---------------------------------------------------------------------------
# The SERIALISATION half of the same boundary.
#
# `_aware` above re-labels a row for in-process comparison. These cover the
# other exit: JSON on the wire. A bare `.isoformat()` on a naive column emits
# no offset, ECMAScript parses an offset-less string as LOCAL time, and the
# Strategy Feed rendered a 12:34 pm IST event as "07:04 am" — every timestamp
# short by exactly the UTC offset, on a feed that only fires inside market
# hours, which read as the feed running outside the session.
# ---------------------------------------------------------------------------

from app.core.timefmt import iso_utc


def test_iso_utc_always_carries_an_explicit_offset():
    # The property that actually matters: a consumer never has to guess.
    assert iso_utc(datetime(2026, 8, 18, 7, 4, 29, 531000)).endswith("+00:00")


def test_iso_utc_assumes_naive_is_utc_and_does_not_move_the_instant():
    # ASSUMED, not converted. `.astimezone()` on a naive value interprets it in
    # the SERVER's local zone, which would shift the instant on any host not set
    # to UTC — reintroducing the bug in a way that only shows up in deployment.
    assert iso_utc(datetime(2026, 8, 18, 7, 4, 29)) == "2026-08-18T07:04:29+00:00"


def test_iso_utc_normalises_an_aware_value_to_utc():
    ist = timezone(timedelta(hours=5, minutes=30))
    assert iso_utc(datetime(2026, 8, 18, 12, 34, 29, tzinfo=ist)) == "2026-08-18T07:04:29+00:00"


def test_iso_utc_passes_none_through():
    # `candleTime` is nullable; the call site must not need a ternary.
    assert iso_utc(None) is None


def test_iso_utc_output_survives_a_javascript_style_parse():
    # Pins the actual failure. Parsing the emitted string as an aware instant
    # must recover the SAME wall clock in IST that a trader saw on screen.
    ist = timezone(timedelta(hours=5, minutes=30))
    emitted = iso_utc(datetime(2026, 8, 18, 7, 4, 29))       # what the API sends
    recovered = datetime.fromisoformat(emitted).astimezone(ist)
    assert (recovered.hour, recovered.minute) == (12, 34)     # not (7, 4)
