---
id: short-put
name: Short Put
category: directional
tier: advanced
concept: option-greeks
summary: A single sold put. Premium is kept if the underlying stays above the strike; loss below the strike is bounded only by the underlying reaching zero, and margin is required throughout.
legs:
  - action: SELL
    kind: PE
    strike: ATM-2
    ratio: 1
    expiry: near
net: credit
outlook: neutral-to-bullish
maxProfit: The premium received
maxLoss: Strike minus premium, if the underlying goes to zero
breakeven: Strike minus premium received
greeks:
  delta: positive
  gamma: negative
  theta: positive
  vega: negative
chartNote: >
  The line marks the strike; the premium is kept in full anywhere above it, and
  losses grow the further the underlying falls below it.
---

# Short Put

A short put is one sold put. Premium is received in exchange for the obligation
to buy the underlying at the strike if assigned.

## The structure

One leg: sell a put, typically out of the money, in the near expiry. Margin is
blocked at entry.

Maximum loss is large but finite — the underlying cannot fall below zero, so
the worst case is the strike less the premium received. In an index this bound
is theoretical; in a single stock it is not.

## What it is exposed to

**Delta** positive — the position gains as the underlying rises.

**Gamma** negative. Delta worsens as the underlying falls, so losses accelerate
rather than accrue linearly. As with any short option, gamma magnitude rises
sharply into expiry.

**Theta** positive. Decay accrues to the writer.

**Vega** negative, and this interacts badly with the position's direction.
Falling markets typically raise implied volatility. A short put therefore
tends to lose on delta and vega simultaneously — the loss arrives faster than
the underlying move alone accounts for. This correlation is what makes short
puts behave worse in a drawdown than their payoff diagram suggests.

## Payoff

At or above the strike at expiry, the put expires worthless and the premium is
kept. Below the strike, loss accrues as the underlying falls, offset by the
premium. Breakeven is strike minus premium received.

## The cash-secured variant

If the full strike value is set aside in cash, the structure is a cash-secured
put and the economics change character. Assignment then results in acquiring
the underlying at the strike, with the premium reducing the effective cost. The
risk is unchanged in magnitude — it is the same payoff — but it is funded
rather than levered, and no margin call can force an exit at an unfavourable
moment. See `strategies/directional/cash-secured-put.md`.

The distinction matters more in India than the payoff diagram implies, because
the margin variant and the cash-secured variant have identical diagrams and
entirely different failure modes.

## Indian market specifics

**Skew works against the seller's entry price and for their carry.** Index puts
trade at higher implied volatility than equidistant calls, so a short put
collects more premium than a short call at the same distance. That extra
premium is compensation for a real asymmetry, not an inefficiency — downside
moves in equity indices are faster and larger than upside ones.

**Margin.** SPAN plus exposure, marked through the day, with intraday
position-limit monitoring since April 2025. The 2% expiry-day extreme loss
margin on short options applies here too.

**Physical settlement.** A short stock put finishing in the money obliges
*taking* delivery — the full contract value in cash must be available on E+2.
A position sized against margin rather than against contract value can be
several times larger than the account can actually settle. Delivery margins
begin accruing four trading days before expiry, which is the mechanism that
surfaces the problem before settlement rather than at it.

**Cost.** STT of 0.15% of premium on the sale.

## How it typically fails

Selling puts is profitable in most months, which is precisely the difficulty:
the strategy's own track record encourages size. The loss arrives in the
minority of periods when the underlying falls quickly, and it arrives amplified
by negative gamma, rising implied volatility and, in single stocks, a physical
settlement obligation sized to contract value rather than to margin.

## Related

- `strategies/vertical-spreads/bull-put-spread.md` — the same leg with a lower
  put bought against it, capping the loss at the spread width
- `strategies/directional/cash-secured-put.md` — the funded variant
- `risk/tail-risk.md` — why win rate does not describe this payoff
