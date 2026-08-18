"""Serialising database datetimes for the wire.

## The bug this exists to prevent

Prisma maps `DateTime` to Postgres `timestamp WITHOUT time zone`, so asyncpg
hands back **naive** datetimes. They are UTC — the write side is careful about
that (see `_now`/`_naive` in the stores) — but the label is gone, and
`datetime.isoformat()` on a naive value emits no offset:

    2026-08-18T07:04:29.531000        <- no 'Z', no '+00:00'

ECMAScript parses a date-time string with no offset as **local time**. So a
browser in IST reads that as 07:04 IST and shifts the instant back 5h30m. The
Strategy Feed rendered a 12:34 pm event as "07:04 am" — every timestamp wrong
by exactly the UTC offset, on a feed that only ever fires inside market hours,
which made it look like the feed was running outside the session.

Nothing errors. The value is a valid ISO string and the frontend formatter was
already correctly asking for `timeZone: 'Asia/Kolkata'` — it was being handed an
instant that had already moved.

## The rule

Any datetime that leaves this service as JSON goes through `iso_utc`. It stamps
UTC on a naive value and normalises an aware one, so the string always carries
`+00:00` and no consumer has to guess.

This is the serialisation counterpart to the store-level `_aware()`, which
solves the same problem for in-process comparisons. Both exist because the
"database columns are naive" detail has to be re-labelled at every boundary it
crosses.
"""

from datetime import datetime, timezone


def iso_utc(value: datetime | None) -> str | None:
    """ISO-8601 with an explicit UTC offset, or None.

    A naive value is ASSUMED UTC rather than converted, because that is what the
    columns actually hold — see the module docstring. Converting instead (e.g.
    `.astimezone()`) would interpret it in the server's local zone and move the
    instant, reintroducing the bug on any host not set to UTC.
    """
    if value is None:
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return aware.isoformat()
