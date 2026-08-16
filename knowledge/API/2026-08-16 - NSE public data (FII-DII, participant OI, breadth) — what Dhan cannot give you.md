---
type: api
date: 2026-08-16
tags: [api, nse, fii, dii, institutional, breadth, market-data, assistant]
source: https://www.nseindia.com/
---

# NSE public data — FII/DII, participant OI, breadth

**Read before adding any institutional-data feature, before assuming the Dhan token covers a market-data gap, and before giving any agent outbound web access.**

## The headline finding: this is not in Dhan, and no token unlocks it

The dashboard's FII/DII gap was assumed to be a Dhan gap — "you can get that feed data from the Dhan token". You cannot. DhanHQ v2's **entire** data surface is `/v2/charts/historical`, `/v2/charts/intraday`, `/v2/optionchain`, `/v2/optionchain/expirylist`, the quote APIs, the scrip masters and `wss://api-feed.dhan.co`. There is no participant-wise endpoint, no cash-flow endpoint, and no FII/DII anything. Full endpoint audit: [[API/2026-08-11 - Dhan Algo Strategies]].

The distinction that resolves it: **a broker publishes what it can execute; an exchange publishes what the market did.** FII/DII is exchange reporting, so it comes from NSE — free, keyless, and verified working 2026-08-16.

## The endpoints (all verified returning real data)

| Dataset | Endpoint | Cadence |
|---|---|---|
| FII/FPI + DII cash buy/sell/net (₹ Cr) | `www.nseindia.com/api/fiidiiTradeReact` | **end of day** |
| Participant-wise OI — Client/DII/FII/Pro, in contracts | `archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv` | **end of day** |
| All indices + **advances/declines/unchanged** | `www.nseindia.com/api/allIndices` | live |
| Per-segment open/closed | `www.nseindia.com/api/marketStatus` | live |
| Upcoming corporate board meetings | `www.nseindia.com/api/event-calendar` | daily |
| Trading holidays | `www.nseindia.com/api/holiday-master?type=trading` | annual |

`allIndices` was the surprise: it carries `advances`/`declines`/`unchanged` per index, which is **real market breadth** — a dimension this platform had been reporting as derived-from-signal-flags because nothing counted constituents.

## The three things that make it work

1. **Cookie priming.** A bare `/api/*` call is refused. Fetch `https://www.nseindia.com/` first and reuse its `Set-Cookie`. **The prime may itself answer 403 while still setting usable cookies** — observed both ways on the same day. Treating the prime's status as success/failure makes the connector look broken while it is one header from working; read the cookies, ignore the status.
2. **A browser-shaped request** — real UA, `Accept`, `Accept-Language`, and a `Referer` matching the page that would normally make the call.
3. **`getSetCookie()`, not `get('set-cookie')`** — multiple Set-Cookie headers cannot be read through `get()` without being joined into one unusable string. Node 20+; keep the single-header fallback.

When NSE refuses, it serves an **HTML challenge page with a 200**, so the symptom is `JSON.parse` failing rather than a status code. Name that in the error or it costs an afternoon.

## The limitation that shapes every UI decision

**FII/DII and participant OI are end-of-day publications. There is no intraday equivalent — the exchange does not compute one and no vendor sells one.** Verified: on Sunday 16 Aug the endpoint returns Friday 14 Aug.

So the reference mock's "FII: Net Buyer (+1,234 Cr)" as a live intraday figure **is not obtainable at any price**. Asked at 11am on a Tuesday, this data describes Monday. Every figure therefore travels with its session and is rendered with it, under its own dated heading rather than beneath the panel's "Live" indicator. An undated institutional-flow row asserts that today's institutions have already acted.

Breadth is the one genuinely live figure of the three.

## Giving an agent "reach into NSE" without giving it a URL

The ask was to let the in-app agent travel across NSE for these details. It is implemented as a **closed named-dataset catalogue** (`services/api/src/nse/nse-datasets.ts`), not a fetcher with a URL parameter, for two independent reasons that were already settled precedent here:

- **A caller-supplied URL fetched from inside the network is an SSRF primitive.** [[Patterns/2026-07-29 - Broker OAuth ownership and third-party content boundaries]] recorded the general form: a `:path*` passthrough is a standing exposure regardless of what is exposed today. `services/api` sits with the database and the internal services.
- **Fetched web content is data, never instruction.** NSE pages carry company-authored text. A parsed number cannot carry an instruction; an HTML page can. This is why `event-calendar` deliberately **drops `bm_desc`** (free-text board-meeting descriptions) and returns only symbol/company/purpose/date — the description is pure injection surface and the structured fields carry the event risk.

The agent action is `{ type: 'marketFlow', ask: 'cash' | 'breadth' | 'positioning' }` — an **ask, never a destination**, asserted by test. Adding a dataset is a reviewed code change; that *is* the control. Same shape as `feed-url.ts` for outbound links and the `/feed` proxy allowlist for the bridge.

## Gotchas worth not re-deriving

- **`toLocaleString('en-IN')` uses lakh grouping**: `202235` → `2,02,235`, not `202,235`. Correct for the product; pinned by test because the two are easy to "fix" into each other.
- **The CSV's headers carry trailing whitespace** (`"Future Stock Short       "`). Match by trimmed name — an untrimmed name-based lookup misses silently and returns null for a column that is present, and an index-based one silently returns the neighbour when NSE adds a column.
- **Archive files are per trading day and land well after the close.** Walk candidates newest-first skipping weekends; a 404 is "not published yet", not a fault.
- **Never coerce a missing value to 0.** NSE emits `"-"` and `""`. Zero means institutions transacted to a dead heat; null means no reading.
- **In the assistant's judgement guard, `buy`/`sell` must NOT be refusal triggers** — unlike `quotes.ts`, where "should I buy" is the whole risk. Here they are the dataset's own vocabulary, and refusing "did DIIs sell yesterday" declines to report a public number because the number is about selling. Cost a test failure to find. `will` must be **unqualified**: `will (?:it|the market|nifty)` misses "will FIIs keep buying".
- **`redirect: 'manual'`** — a redirect means the request is no longer going where the catalogue said, which would move the destination outside the only control this module has.

## Still absent, and still said out loud on screen

No free source exists for **global-market breadth** or a **macro economic calendar** (US CPI, policy decisions). NSE's calendar is *corporate* — which companies report when — not macro. The rail names these as absent rather than dropping the rows, per the rule in [[Patterns/2026-08-16 - Sentinel reference dashboard band (what the mock asked for that the platform cannot know)]].

## Operational risk to accept knowingly

This is an **unofficial, undocumented, unversioned** surface with no SLA, and NSE's terms of use restrict automated access. It can change shape or start refusing a server's IP without notice. Mitigations in place: server-side only (never browser-origin), a single shared connector and cache so the platform makes a handful of requests an hour rather than one per viewer, TTLs set by how often the *source* publishes (30 min for EOD data), one re-prime and retry on 401/403 rather than a loop, and stale-with-timestamp on failure instead of a gap. **A commercial data agreement is the durable answer if this becomes load-bearing** — that is a business call, not an engineering one.

Verified 2026-08-16: 25 API specs, 25 assistant specs, live fetch path, and all four routes end-to-end through the Next proxy.
