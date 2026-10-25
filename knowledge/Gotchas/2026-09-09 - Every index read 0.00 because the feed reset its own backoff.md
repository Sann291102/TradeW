---
type: gotcha
date: 2026-09-09
tags: [gotcha, market-data, dhan, reconnect, observability]
---

# Every index read 0.00 because the feed reset its own backoff

**Read before debugging a dead Dhan feed, and before touching
`DhanMarketFeed`'s reconnect policy.** The instinct — "the 24h token expired" —
was wrong here, and chasing it wastes the session.

## The symptom

NIFTY, BANKNIFTY, FINNIFTY, SENSEX and INDIA VIX all rendered `0.00` on the
home screen through an open market, while a few ticker items (Midcap Select,
NIFTY IT) showed real numbers. `GET /quotes` returned `ltp: 0`, `open/high/low/
close: null`, `source: "dhan"` — and an `updatedAt` frozen at the bridge's boot
time, which is the tell: **not one tick had ever arrived.**

## The cause: one line

`DhanMarketFeed.connect()` did this on open:

```ts
socket.onopen = () => { this.reconnectAttempt = 0; ... }
```

Resetting the backoff on `onopen` is right for a connection that then *works*
and catastrophic for one that opens and dies immediately: every flap reset the
ladder to its 1s floor, so the client never actually backed off. Dhan answered
the resulting ~10 handshakes a minute with **HTTP 429**, and each 429 close fed
straight back into the same 1s retry.

Measured over 13 minutes: **125 opens, 399 reconnects, 75 × HTTP 429, zero
ticks.** Zero `805`s, so it was never the 5-connection limit, and `netstat`
showed one socket at a time, so it was never a leak.

**The loop was self-sustaining, and that is the part that matters.** The token
*had* genuinely expired earlier that morning, which started the storm — but by
the time a fresh token was minted, the storm had Dhan's rate limiter engaged,
so the refresh recovered nothing. A probe with the new token got 429 in 140ms.
This is why it looked intermittent and unfixable across mornings: **the daily
token refresh cannot recover a client that is busy being rate-limited.**

## The fix

Backoff must be cleared by **evidence of health, not by a handshake**:

- `onopen` records `openedAt` and nothing else. `onclose` resets the attempt
  counter only if the socket survived `STABLE_CONNECTION_MS` (30s).
- A 429 is remembered (it arrives on `onerror` as
  `Unexpected server response: 429`, then closes 1006 carrying no code of its
  own) and applies `RATE_LIMIT_COOLDOWN_MS` (60s) as a **floor** the ordinary
  ladder cannot undercut. A stated rate limit is not a transient fault.
- `scheduleReconnect` clears any existing timer first — two closes arriving
  together otherwise leave two live timers, and every cycle thereafter doubles
  the attempts.

Verified live: one 429 → one 60s cooldown → connected, ticking. Compare 125/399/75.

## The observability failure that hid it for weeks

The bridge logged `[dhan] ${status}${reason ? ' — ' + reason : ''}` — **no
timestamp, no close code, no attempt number**. Close events carry an
empty-string reason far more often than an absent one, so nearly every line
printed as a bare `[dhan] reconnecting`. A flap every second and a healthy retry
every thirty looked *identical* in the log, and nothing said why the socket
dropped. **A feed that cannot say why it dropped is a feed nobody can fix.** All
three fields are now printed.

(Related trap when writing that line: use `||`, not `??`, for the reason — an
empty-string reason is not nullish, so `??` prints a dangling dash.)

## Checks that settle this class in a minute

```bash
# Not one tick since boot? updatedAt will equal the process start time.
curl -s "http://127.0.0.1:4600/quotes?symbols=NIFTY" | head -c 300

# Storm signature: opens ≈ reconnects, many 429, ZERO 805.
for p in connected reconnecting 429 805; do echo -n "$p "; grep -c "$p" .logs/market-data.log; done

# Is it really the token? Decode the exp — do not assume.
grep '^DHAN_ACCESS_TOKEN=' .env | cut -d= -f2- | cut -d. -f2   # base64 → {exp}
```

`805` present means a genuine duplicate ingestor. `429` with no `805` means
**we** are the problem, not another instance.

Also fixed in passing: `@tradew/strategy-core` was missing from
`scripts/ensure-fresh-packages.mjs`, so the launcher would not rebuild the
decision core when its `src/` changed — see
[[Decisions/2026-09-08 - Autonomous decision core extracted to strategy-core (Sentinel no longer authorises trades)]].

Related: [[Gotchas/2026-08-17 - A boot-once credential plus fault-shaped-like-absence took Sentinel down]]
(the same feed, the opposite failure: a *stale* credential reported as facts
about the market), [[Gotchas/2026-09-08 - The bot placed zero orders because the laptop slept through market open]].
