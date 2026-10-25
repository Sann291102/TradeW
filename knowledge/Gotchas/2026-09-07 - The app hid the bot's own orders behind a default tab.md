---
type: gotcha
date: 2026-09-07
tags: [gotcha, paper-execution, ui, orders]
---

# The app hid the bot's own orders behind a default tab

**Read before investigating "the agent's orders are not showing in the app", and before adding any status-filtered list.**

An autonomous agent's entry is a **MARKET order that fills instantly**, so it is written to the book already `FILLED`. `OrdersSection.tsx` opened on the **`Open`** tab, whose statuses are `['OPEN','TRIGGER_PENDING','PARTIALLY_FILLED']` — `FILLED` is on a *different* tab. So every trade a bot placed in a real user's paper account was **in that user's own order book and invisible on the screen they land on**.

Proven against live rows, not reasoned about: both existing agent orders sit in `vivek.sannidhi29@gmail.com`'s account with `executionIntentId` set and `status=FILLED`, and evaluate to `Open tab: NO (hidden)`.

The read path was **clean at every hop** — `/sim/orders` → `orderBook(userId)` applies no source filter and returns the whole row, exactly as [[Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no order, not a read bug]] found for the admin console. That note pinned the identical failure on `OrdersSection` opening on **Open**; the *admin* copy was fixed and **the web app's was not**, so the same defect survived in the surface the trader actually uses. **When a UI default is found to hide a class of row, grep for every other list with the same default before closing it.**

Two fixes, both structural:

- **An `All` tab, and it is now the default.** It maps to `undefined` rather than to every status spelled out, because `fetchOrders` omits the query parameter entirely for undefined and the server returns the whole book — so a status added to the enum later cannot silently fall outside a hand-maintained array and vanish from the one tab whose entire job is to hide nothing.
- **An `AGENT` badge**, from `executionIntentId` / `exitOfIntentId`. Both are checked, never just the first: an agent **entry** carries `executionIntentId` while the **square-off that closes it** carries `exitOfIntentId` and never the other, so testing one field renders every bot exit as a human's order. The fields were already on the wire (plain scalars on `Order`); they were simply missing from `OrderDto`, so the app had the provenance and no way to show it.

The deeper rule: **a paper order placed by an agent into a user's own account is the same row the user's own order book reads** — there is no sync layer to blame (see [[Decisions/2026-08-18 - Sentinel paper execution bound to real TradeW user accounts]]). So "the bot's orders are missing" is almost never a missing row; it is a filter, a tab, or no order at all — check in that order.
