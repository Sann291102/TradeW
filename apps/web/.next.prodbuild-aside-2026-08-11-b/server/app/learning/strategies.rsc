2:I[6340,["7657","static/chunks/7657-a7b85edddc6d5b38.js","9230","static/chunks/9230-dd1733219eeff5bf.js","6340","static/chunks/6340-f565b06e4305fa4d.js","5036","static/chunks/5036-47b51494fc61f6dd.js","907","static/chunks/app/(workspace)/learning/strategies/page-9b03c163e89bf0b4.js"],""]
3:I[2866,["7657","static/chunks/7657-a7b85edddc6d5b38.js","9230","static/chunks/9230-dd1733219eeff5bf.js","6340","static/chunks/6340-f565b06e4305fa4d.js","5036","static/chunks/5036-47b51494fc61f6dd.js","907","static/chunks/app/(workspace)/learning/strategies/page-9b03c163e89bf0b4.js"],"StrategyBrowser"]
12:I[5092,[],""]
13:I[2023,[],""]
14:I[7422,["7657","static/chunks/7657-a7b85edddc6d5b38.js","9230","static/chunks/9230-dd1733219eeff5bf.js","6340","static/chunks/6340-f565b06e4305fa4d.js","1837","static/chunks/1837-2f3de9d974b3bba8.js","5036","static/chunks/5036-47b51494fc61f6dd.js","2126","static/chunks/2126-c5859569d5d2f0bd.js","5139","static/chunks/5139-94116db28d190ccb.js","2202","static/chunks/2202-98eaf4f2ce67e811.js","4136","static/chunks/app/(workspace)/layout-afd110958c0bc60e.js"],"AppFrame"]
4:T100d,# Long Call

A long call is one bought call option. It is the simplest bullish option
structure and the one most new participants meet first, which is also why its
failure modes are the most commonly misunderstood.

## The structure

One leg: a long call, usually at or near the money, in the near expiry.

The premium is paid in full at entry. Since October 2024 SEBI requires upfront
collection of option premium, so the debit leaves the account immediately —
there is no intraday leverage on the purchase itself.

## What it is exposed to

The position has four distinct exposures, and confusion about long call
outcomes almost always resolves once they are separated.

**Direction (delta).** An at-the-money call has a delta near 0.5, so it gains
roughly ₹0.50 per ₹1 of underlying move at the outset. Delta rises toward 1.00
as the option moves in the money and falls toward 0 as it moves out.

**Acceleration (gamma).** Delta itself is not fixed. Gamma is highest at the
money and rises sharply as expiry approaches, which is why a near-expiry
at-the-money call behaves so violently — small underlying moves produce large
percentage swings in the premium.

**Time (theta).** Every day that passes removes extrinsic value. Theta is
negative for a long call and accelerates into expiry. This is the exposure that
surprises people: the underlying can move up and the call can still lose money,
because the directional gain was smaller than the time decay over the same
period.

**Volatility (vega).** A long call is long vega. If implied volatility falls
while the position is held, the premium falls with it independently of
direction. Around scheduled events this is the dominant term — see
`volatility/volatility-crush.md`.

## Payoff

Below the strike at expiry, the call expires worthless and the entire premium
is lost. Above the strike, intrinsic value accrues one-for-one with the
underlying. Breakeven at expiry sits at strike plus premium paid, so the
underlying must clear the strike *and* the premium before the position is
positive.

Maximum loss is the premium and nothing more. This defined-risk property is
the structural distinction from a long future, where an adverse move is not
capped.

## Indian market specifics

**Expiry cadence.** On NSE only NIFTY carries a weekly contract, expiring
Tuesday. BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50 lost their weeklies
under SEBI's November 2024 rationalisation and now trade monthly, expiring the
last Tuesday. BSE's SENSEX weekly expires Thursday. A long call held in a
monthly-only index therefore carries a much longer decay horizon than the
weekly NIFTY contract most retail flow concentrates in.

**Cost.** Buying a call attracts no STT on purchase. STT applies at 0.15% of
intrinsic value if the option is exercised, which is the trap in holding a
deep-in-the-money call to expiry rather than squaring off — an in-the-money
option left to exercise pays STT on the whole intrinsic value, not on the
premium.

**Stock options.** A long call on a single stock that finishes in the money
goes to physical settlement, obliging delivery of the full contract value of
shares on E+2. Delivery margins begin accruing four trading days before expiry.
An index call has no such obligation; it is cash settled.

## How it typically fails

The most frequent losing pattern is not being wrong on direction. It is being
right on direction, too late, in a contract with too little time — the
underlying rises, but not before theta has consumed more than the move was
worth. The second most frequent is buying into an event at elevated implied
volatility and holding through the announcement, where the volatility collapse
outweighs the directional gain.

## Related

- `strategies/vertical-spreads/bull-call-spread.md` — same directional view,
  premium reduced by selling a higher strike, gain capped in exchange
- `greeks/theta.md` — the decay term in detail
- `foundations/intrinsic-and-extrinsic-value.md` — what is actually being paid for5:Td8b,# Long Put

A long put is one bought put option — the bearish mirror of the long call, with
one asymmetry that matters.

## The structure

One leg: a long put, usually at or near the money, in the near expiry. Premium
is paid upfront in full.

## What it is exposed to

**Direction (delta).** Negative. An at-the-money put has a delta near −0.5,
gaining roughly ₹0.50 per ₹1 the underlying falls, with delta moving toward
−1.00 as it goes deeper in the money.

**Acceleration (gamma).** Positive, peaking at the money and rising into
expiry, exactly as for a call.

**Time (theta).** Negative. Extrinsic value bleeds away daily.

**Volatility (vega).** Positive. A long put gains if implied volatility rises.

This last exposure is where puts differ from calls in practice. Equity index
implied volatility is persistently skewed — downside strikes trade at higher
implied volatility than equivalent upside strikes, because demand for downside
protection is structural rather than speculative. Two consequences follow. A
put is generally more expensive than the equidistant call. And falling markets
tend to raise implied volatility, so a long put often gains on both delta and
vega at once, which is why puts are convex in a way calls are not.

## Payoff

Above the strike at expiry, the put expires worthless and the premium is lost.
Below the strike, intrinsic value accrues as the underlying falls. Breakeven at
expiry is strike minus premium paid.

Maximum gain is bounded, unlike a long call: an underlying cannot fall below
zero, so the most a put can be worth is the strike itself, less the premium
paid. In practice this bound is theoretical for an index.

## Indian market specifics

**Skew makes entry cost asymmetric.** Because index puts carry a volatility
premium, a long put bought in calm conditions is paying for that skew. The same
put bought after a fall is paying an even larger one, since implied volatility
has already risen — buying protection after the move is materially more
expensive than before it.

**India VIX** is computed from NIFTY option prices and is the standard
reference for whether index implied volatility is historically high or low.
A long put entered when VIX is depressed has a very different vega profile
from one entered when it is elevated.

**Cost and settlement.** No STT on purchase. STT of 0.15% of intrinsic value
on exercise. A stock put finishing in the money obliges *delivery* of shares
on E+2 — the holder must have the stock or buy it. Index puts are cash
settled.

**Expiry cadence.** NIFTY weeklies expire Tuesday; BANKNIFTY and the other
indices are monthly-only, last Tuesday. SENSEX weeklies expire Thursday on BSE.

## How it typically fails

Holding a long put through a drift-upward market is the common loss: theta and
falling volatility compound, and the position bleeds on two exposures at once
even when the underlying barely moves. The second pattern is buying puts as
insurance during a panic, when skew and VIX have already repriced, and then
watching volatility normalise faster than the underlying falls.

## Related

- `strategies/vertical-spreads/bear-put-spread.md` — same view, cheaper, capped
- `strategies/directional/protective-put.md` — the same leg used as a hedge
  against held stock rather than as a directional position
- `volatility/smile-and-skew.md` — why puts cost what they cost6:T104a,# Short Call

A naked short call is one sold call with no offsetting long position. It is the
structure with the least bounded risk profile available to a retail
participant, and it is presented here because understanding it is a
prerequisite for understanding every spread built on top of it — not because
the risk profile is comparable to the others in this section.

## The structure

One leg: a short call, typically out of the money. Premium is credited at entry.
Margin is blocked and marked to market daily.

Unlike a long option, where the maximum loss is known at entry and already
paid, a short call's obligation grows with the underlying. There is no upper
bound on how far an index or a stock can rise.

## What it is exposed to

Every greek reverses relative to a long call.

**Delta** is negative — the position loses as the underlying rises.

**Gamma** is negative, and this is the defining hazard. Negative gamma means
the position's delta worsens as the underlying moves against it: the higher the
underlying goes, the faster the position loses per additional point. Gamma
magnitude peaks at the money and rises steeply into expiry, so a short call
that is comfortably out of the money on Friday can be the dominant risk in an
account by Tuesday afternoon.

**Theta** is positive. This is the source of return — extrinsic value decays
into the seller's favour each day.

**Vega** is negative. A rise in implied volatility increases the option's value
and therefore the loss, independently of direction.

## Payoff

At expiry, anywhere at or below the strike, the call expires worthless and the
full premium is retained. Above the strike, loss accrues one-for-one with the
underlying, offset by the premium received. Breakeven is strike plus premium.

The distribution of outcomes is the point: a high probability of a small gain,
against a low probability of a loss with no defined ceiling. Expectancy is not
determined by win rate. See `risk/expectancy.md`.

## Indian market specifics

**Margin.** SPAN plus exposure margin is blocked at entry and recomputed
through the day. SEBI moved position-limit monitoring to multiple intraday
snapshots from April 2025, so intraday breaches are now caught rather than
netted out by close.

**Expiry-day margin.** An additional 2% extreme loss margin applies to short
option positions on expiry day, in force since November 2024. Separately, the
calendar-spread margin benefit was withdrawn on expiry day from February 2025 —
a short call that was margin-offset by a longer-dated leg loses that offset on
the day it matters most.

**STT.** 0.15% of premium on the sale. If assigned, the exercise-side STT of
0.15% of intrinsic value applies to the counterparty, not the writer.

**Physical settlement.** A short stock call finishing in the money obliges
delivery of shares on E+2. A writer without the stock must buy it, at whatever
price the market offers, on a compressed timeline. Delivery margins begin four
trading days before expiry. This is a materially different risk from an index
short call, which is cash settled.

**Gap risk.** Indian equities and indices can gap on overnight global cues,
policy announcements and results. A short call carries the gap in full: there
is no stop-loss that executes between the previous close and the opening
print.

## How it typically fails

The characteristic loss is not gradual. A short call sold far out of the money
prints many small gains, which raises confidence and usually position size, and
the loss when it arrives arrives at a size calibrated to the enlarged position
rather than the original one. Negative gamma is what converts a modest adverse
move into a disproportionate loss late in the contract's life.

## Related

- `strategies/directional/covered-call.md` — the same leg with stock held
  against it, which bounds the upside loss
- `strategies/vertical-spreads/bear-call-spread.md` — the same leg with a
  further call bought above it, which caps the loss at the spread width
- `greeks/gamma.md` — why the risk accelerates rather than accrues7:Tf51,# Short Put

A short put is one sold put. Premium is received in exchange for the obligation
to take delivery of the underlying at the strike if assigned.

## The structure

One leg: a short put, typically out of the money, in the near expiry. Margin is
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
- `risk/tail-risk.md` — why win rate does not describe this payoff8:Te8c,# Bear Call Spread

Two legs in the same expiry: a sold call and a bought call at a higher strike.
Also called a call credit spread.

## The structure

The lower strike is the short leg, the higher strike the long leg. Net credit.

The bought call converts the naked short call's unbounded obligation into a
defined maximum loss, and reduces margin to a fraction of the naked
requirement. Given that a naked short call is the least bounded structure
available, this conversion is more consequential here than on the put side.

## What it is exposed to

**Delta** negative and modest.

**Theta** positive — the return source, driven mainly by the nearer-the-money
short leg.

**Gamma** negative near the short strike, rising in magnitude into expiry.

**Vega** negative.

Unlike the put-side spreads, the direction and volatility exposures here do not
usually reinforce each other. Rising markets are typically accompanied by
*falling* implied volatility, so a bear call spread losing on delta is often
simultaneously gaining on vega. This partial offset makes the call-side credit
spread's mark-to-market better behaved in an adverse move than the put side's —
the loss tends to accrue closer to what delta alone implies.

The exception is a volatility-expanding rally, which is rare in equity indices
but not unknown around short squeezes and policy surprises.

## Payoff

- At or below the lower strike at expiry: both expire worthless, full credit kept.
- Between the strikes: the short call is in the money, the long is not.
- At or above the higher strike: both in the money, loss fixed at spread width minus credit.

Maximum profit is the net credit. Maximum loss is spread width minus credit.
Breakeven is the lower strike plus the credit.

## Indian market specifics

**Skew works against the credit.** Call-side implied volatility sits below
put-side for the same distance from spot, so a bear call spread collects less
premium than a bull put spread with equivalent strike distance and width. The
smaller credit is the market pricing upside moves as less violent than downside
ones — not an inefficiency to be arbitraged.

**Margin.** Hedged treatment, far below the naked short call. The 2%
expiry-day extreme loss margin applies to the short leg.

**Physical settlement.** On a stock spread settling between the strikes, the
short call is assigned and the long expires worthless — obliging *delivery* of
shares on E+2. A trader without the stock must buy it in the cash market on a
compressed timeline. Delivery margins accrue from four trading days before
expiry. Index spreads are cash settled and carry no delivery leg.

**Corporate actions.** A bear call spread on a single stock spanning a
dividend, bonus or split date is subject to contract adjustment. Strikes and
lot sizes are revised by the exchange, which can change the spread's width and
economics mid-position. See `fundamentals/corporate-actions.md`.

## How it typically fails

The same shape as every credit structure: a high hit rate accumulated over
quiet expiries, size scaled to that hit rate, and the loss arriving at full
width. The call-side variant has one additional failure specific to it — the
short leg being assigned early is rare in the Indian market's European-style
index options, but stock options are American-style and can be assigned before
expiry when a dividend makes early exercise rational.

## Related

- `strategies/directional/short-call.md` — the same short leg, unbounded
- `strategies/vertical-spreads/bear-put-spread.md` — same view, debit
- `strategies/volatility/iron-condor.md` — this spread plus its put-side mirror9:Td0b,# Bear Put Spread

The mirror of the bull call spread. Two legs in the same expiry: a bought put
and a sold put at a lower strike. Also called a put debit spread.

## The structure

The higher strike is the long leg, the lower strike the short leg, same expiry. Net debit, since the
higher put is worth more.

## What it is exposed to

**Delta** negative, smaller in magnitude than an outright long put.

**Gamma and theta** mixed, changing character depending on where the underlying
sits relative to the two strikes — gamma-positive near the long strike,
gamma-negative near the short one, roughly offsetting between them.

**Vega** net negative and small in magnitude.

This last point is where the bear put spread earns its place, and the reason is
specific to puts rather than general to spreads. Index put skew means the lower
strike carries *higher* implied volatility than the higher strike. Selling the
lower strike therefore sells the more expensive volatility and buys the
cheaper. A bear put spread partially monetises skew, which an outright long put
pays for in full.

The practical consequence: in a high-VIX environment, a bear put spread is
substantially cheaper relative to an outright put than the same comparison
would be for calls in a high-volatility environment. The steeper the skew, the
better the spread compares.

## Payoff

- Above the higher strike at expiry: both expire worthless, net debit lost.
- Between the strikes: the long put has intrinsic value, the short does not.
- At or below the lower strike: both in the money, difference fixed at spread width.

Maximum profit is spread width minus net debit. Maximum loss is the net debit.
Breakeven is the higher strike minus the net debit.

## Indian market specifics

**Skew is the reason to prefer this over a long put**, and it is also the
reason the maximum profit looks smaller than expected. Selling the expensive
lower strike brings in more premium, which lowers the debit — but the lower
strike is priced richly precisely because large downside moves happen. The
capped payoff forfeits exactly the scenario the skew is pricing.

**Margin.** Treated as a hedged position, so margin is a fraction of the naked
short put's.

**Physical settlement asymmetry.** On a stock spread settling between the
strikes, the long put is exercised and the short is not — obliging delivery of
shares on E+2. The trader must have or acquire the stock. Index spreads are
cash settled.

**Costs.** Four legs of brokerage across entry and exit, STT of 0.15% of
premium on each sold leg.

## How it typically fails

The same way its bullish counterpart does — it caps the move it was built for.
A bear put spread held through a genuine market break captures only to the
lower strike, while the skew it sold reprices violently against the short leg
on the way down. In a fast decline the spread's mark-to-market can look far
worse than its expiry payoff, because the short leg's implied volatility rises
faster than the long leg's.

## Related

- `strategies/directional/long-put.md` — uncapped, more expensive, long vega
- `strategies/vertical-spreads/bear-call-spread.md` — same view, expressed for a credit
- `volatility/smile-and-skew.md` — why the lower strike is the expensive onea:T11e4,# Bull Call Spread

Two legs in the same expiry: a bought call and a sold call at a higher strike.
Also called a call debit spread.

## The structure

The lower strike is the long leg, the higher strike the short leg, same expiry. The net cost is the
difference between the two premiums — always a debit, since the lower strike is
always worth more.

The trade being made is explicit: give up everything above the short strike, in
exchange for paying materially less at entry. A long call breaks even only
after covering the full premium; a bull call spread breaks even after covering
a reduced one.

## What it is exposed to

**Delta** is positive but smaller than a long call's, because the short leg's
negative delta partially offsets the long leg's.

**Gamma** is mixed and changes sign depending on where the underlying sits. Near
the long strike the position is gamma-positive; near the short strike it is
gamma-negative. Between them the two roughly offset.

**Theta** is mixed for the same reason, and this is the property that makes the
spread behave differently from a long call in a flat market. A long call bleeds
every day. A bull call spread with the underlying between the strikes bleeds far
less, because the short leg is decaying in the position's favour at the same
time the long leg decays against it. If the underlying sits above the short
strike, time decay actually works *for* the position, since it is the short leg
that has extrinsic value left to lose.

**Vega** is net negative when the spread is established with the underlying
below the long strike, and the magnitude is small. The spread is substantially
less volatility-sensitive than a long call — a volatility crush that would
destroy a naked long call leaves a spread comparatively intact, because both
legs reprice together.

That volatility insensitivity is the main structural argument for the spread
over the outright call around scheduled events.

## Payoff

- Below the lower strike at expiry: both legs expire worthless, the net debit is lost.
- Between the strikes: the long call has intrinsic value, the short does not.
- At or above the upper strike: both are in the money, the difference is fixed at the spread width.

Maximum profit is spread width minus net debit. Maximum loss is the net debit.
Breakeven is the lower strike plus the net debit.

The ratio of these two numbers is fixed by the strikes chosen and is worth
computing before entry rather than after. A spread paid for at 40% of its width
risks 40 to make 60.

## Indian market specifics

**Strike step matters.** NIFTY strikes are 50 apart, BANKNIFTY 100. The
`ATM+2` in this lesson's frontmatter means two strike steps, which resolves to a
different width per instrument — the Apply feature substitutes the correct step
from the live scrip master rather than assuming one.

**Margin benefit.** A vertical spread is recognised as a hedged position and
attracts far less margin than the short leg alone. This is the practical reason
spreads dominate retail option selling in India. Note the withdrawal of
calendar-spread benefit on expiry day from February 2025 applies to spreads
across *different* expiries, not to a same-expiry vertical like this one.

**Costs bite twice.** Two legs in, two legs out: four brokerage charges and STT
on both sold legs. On a narrow spread in a liquid weekly contract, costs can be
a meaningful fraction of maximum profit. The narrower the spread, the worse
this ratio.

**Expiry-day assignment.** If the underlying settles between the strikes on a
*stock* spread, the long leg is exercised and the short is not, producing a
physical delivery obligation on one leg only. Index spreads settle in cash and
carry no such asymmetry.

## How it typically fails

The spread rarely produces a catastrophic loss, which is its purpose. It fails
by being chosen for the wrong reason: when a large directional move is what was
expected, the capped payoff forfeits most of the gain, and the position would
have been better expressed as an outright call. It also fails quietly on cost —
a spread entered too narrow, in an illiquid stock contract with a wide bid-ask,
can have negative expectancy before the underlying does anything at all.

## Related

- `strategies/directional/long-call.md` — uncapped version, higher cost, more vega
- `strategies/vertical-spreads/bull-put-spread.md` — same directional view expressed for a credit
- `foundations/payoff-diagrams.md` — reading the kinked lineb:T117a,# Bull Put Spread

Two legs in the same expiry: a sold put and a bought put at a lower strike.
Also called a put credit spread. The same directional view as a bull call
spread, expressed for a credit rather than a debit.

## The structure

The higher strike is the short leg, the lower strike the long leg. Net credit, since the higher put
is worth more.

The long leg is not there to make money. It is there to convert an unbounded
obligation into a defined one, and to collapse the margin requirement. Both
effects are the reason this structure, rather than the naked short put,
dominates retail premium selling in India.

## What it is exposed to

**Delta** positive but modest.

**Theta** positive — the position's primary source of return. Both legs decay,
but the short leg is nearer the money and therefore carries more extrinsic
value to lose, so the net is favourable.

**Gamma** negative in the region that matters. As the underlying approaches the
short strike, the position's delta deteriorates at an accelerating rate. Gamma
magnitude rises into expiry, which is why a credit spread that is safely out of
the money with a week to run can become the account's dominant exposure within
two sessions.

**Vega** negative. Rising implied volatility widens both legs, and the short
leg widens more.

The correlation problem from the naked short put persists here in reduced form:
falling markets raise implied volatility, so delta and vega deteriorate
together. The long leg bounds how bad this gets, but does not prevent the
mark-to-market from moving faster than the underlying alone implies.

## Payoff

- At or above the higher strike at expiry: both expire worthless, full credit retained.
- Between the strikes: the short put is in the money, the long is not; loss accrues.
- At or below the lower strike: both in the money, loss fixed at spread width minus credit.

Maximum profit is the net credit. Maximum loss is the spread width minus the
credit. Breakeven is the higher strike minus the credit.

## The risk-reward is inverted, and that is the point

A credit spread typically risks several rupees to make one. A spread collecting
30% of its width risks 70 to make 30. This is not a defect — it is the
compensation structure for a position that wins most of the time. Expectancy
depends on whether the win rate exceeds the ratio the payoff demands, not on
whether the ratio looks attractive. See `risk/expectancy.md`.

Reading the credit as "income" and the loss as an aberration is the single most
common misreading of this structure.

## Indian market specifics

**Skew helps the entry.** Selling the higher put and buying the lower one means
selling the cheaper implied volatility and buying the more expensive — the
opposite of the bear put spread's skew capture. The credit received is
therefore smaller than a symmetric-volatility model would suggest. This is
mechanical, not a mispricing.

**Margin.** Recognised as hedged, so margin is far below the naked short put.
The 2% expiry-day extreme loss margin on short options still applies to the
short leg.

**Physical settlement.** On a stock spread settling between the strikes, the
short put is assigned and the long expires worthless — obliging the trader to
*take* delivery of the full contract value on E+2. The long leg caps the
economic loss but does not remove the settlement obligation. This is the
mechanism by which a defined-risk position produces an undefined cash
requirement, and it is specific to stock contracts. Index spreads settle in
cash.

**Expiry cadence.** NIFTY weeklies on Tuesday give the most frequent cycle;
BANKNIFTY is monthly-only since the November 2024 rationalisation, so a
BANKNIFTY credit spread carries a full month of gamma exposure rather than a
week.

## How it typically fails

Consistently, until it does not. A run of expiries in which the credit is kept
in full establishes a base rate that the payoff does not support, and size
grows to match the apparent reliability. The loss arrives compressed into one
or two sessions, at the full spread width, on a position sized for the win
rate rather than the loss.

## Related

- `strategies/directional/short-put.md` — the same short leg, unbounded
- `strategies/vertical-spreads/bull-call-spread.md` — same view, debit
- `strategies/volatility/iron-condor.md` — this spread plus its call-side mirrorc:Tf21,# Iron Butterfly

Four legs, one expiry: a short straddle at the centre strike, with a long put
below and a long call above. Equivalently, a bull put spread and a bear call
spread sharing the same short strike.

## The structure

- A long put below the centre
- A short put at the centre
- A short call at the centre
- A long call above the centre

Net credit, and a larger one than an iron condor of the same wing width,
because the short legs are at the money rather than out of it.

## What it is exposed to

**Theta** positive and large — two at-the-money short legs carry the most
extrinsic value available to decay.

**Gamma** negative and sharply so near the centre, bounded by the wings.

**Vega** negative, bounded.

## Against the iron condor

Same four-leg shape, same defined risk, different distribution.

| | Iron butterfly | Iron condor |
|---|---|---|
| Short strikes | Together, at the money | Apart, out of the money |
| Credit | Larger | Smaller |
| Profit zone | Narrow, peaked at the centre | Wide, flat between shorts |
| Probability of max profit | Low | Higher |
| Risk-reward | Better | Worse |

The butterfly pays more and wins less often; the condor pays less and wins more
often. Neither dominates. The butterfly's profit is a peak rather than a
plateau — it is realised in full only if the underlying settles at the centre
strike, and it decays away from there in both directions.

Notably, the butterfly's *breakevens* are often wider than its narrow profit
peak suggests, because the credit received is large. A position can be
profitable across a reasonable range while only achieving maximum profit at one
point.

## Indian market specifics

**Expiry-day pinning.** Underlyings sometimes settle close to strikes with
large open interest, an effect associated with market-maker hedging and with
the max-pain concept — which is contested and carries low confidence in this
repo's own ontology (`knowledge-base/options/max-pain.yaml`). An iron butterfly
placed at a high-open-interest strike is a position whose best outcome depends
on an effect that is not reliably established. It is worth knowing that the
association is debated rather than assumed.

**Weekly NIFTY concentration.** With NIFTY the only NSE index carrying weeklies
since November 2024, expiry-day butterflies concentrate there. Centre-strike
gamma on a Tuesday afternoon is extreme; the wings are what make the structure
survivable, and their width is the only thing standing between the position and
a full-width loss.

**Costs.** Four legs each way. Because a butterfly's wings are typically
narrower than a condor's, cost as a fraction of maximum profit is high, and on
very narrow butterflies it can exceed the theoretical edge entirely.

**Margin.** Defined-risk treatment, well below a naked short straddle. The 2%
expiry-day extreme loss margin applies to both short legs.

**Physical settlement.** On a stock butterfly, an at-the-money short leg
finishing marginally in the money is assigned, creating a full-contract-value
obligation on E+2. With both short legs at the same strike, one of them is
nearly always in the money by some amount at settlement.

## How it typically fails

The underlying drifts away from the centre and stays there. Unlike a condor,
which tolerates drift within a wide band, the butterfly starts losing
immediately as the underlying leaves the centre strike. The second failure is
cost: on a narrow butterfly, eight legs of brokerage and STT against a small
credit leave very little margin for the position to be right.

## Related

- `strategies/volatility/iron-condor.md` — wider shorts, flatter payoff
- `strategies/volatility/short-straddle.md` — the same core without wings
- `foundations/payoff-diagrams.md` — reading a peaked payoffd:T12a1,# Iron Condor

Four legs, one expiry: a bull put spread below the market and a bear call
spread above it. Equivalently, a short strangle with protective wings.

## The structure

- A long put, far out of the money
- A short put, nearer the money
- A short call, nearer the money
- A long call, far out of the money

Net credit. The two bought wings cost less than the two sold inner legs bring
in, since they are further from the money.

The two wings are insurance, not profit centres. They exist to bound the loss
and to collapse the margin requirement.

## What it is exposed to

**Theta** positive, from the two short legs, partially given back to the two
long legs. Net theta is lower than a comparable short strangle's.

**Gamma** negative near the short strikes, but bounded — as the underlying
moves past a short strike toward the corresponding wing, the long leg's
positive gamma progressively offsets the short leg's negative gamma. Beyond
the wing, the position's delta is flat. This is the structural difference from
a strangle, where delta deterioration never stops.

**Vega** negative but bounded, for the same reason.

## Payoff

- Between the short strikes: both spreads expire worthless, full credit retained.
- Between a short strike and its wing: that spread is partially in the money, loss accrues.
- Beyond a wing: loss fixed at wing width minus net credit.

Maximum profit is the net credit, realised across the whole range between the
short strikes. Maximum loss is the width of one wing minus the credit — only
one side can lose, since the underlying cannot finish both above the call
strike and below the put strike.

That last point is frequently miscounted. Margin and risk are computed on one
side, not both.

## The trade-off against a short strangle

The comparison is the real content of this lesson.

| | Short strangle | Iron condor |
|---|---|---|
| Credit | Higher | Lower |
| Maximum loss | Unbounded | Wing width minus credit |
| Margin | Large | Substantially smaller |
| Return on margin | Can be higher in quiet periods | More stable |
| Behaviour in a tail move | Loss unbounded | Loss stops at the wing |

The condor collects less and cannot be destroyed by a single move. Whether the
forfeited credit is worth the bounded tail is the allocation decision; the
structures are not interchangeable and the diagrams do not make the difference
obvious.

## Indian market specifics

**Margin efficiency is the main practical driver.** A four-leg defined-risk
position attracts a fraction of the strangle's margin, which is why condors are
common in Indian retail books despite the smaller credit.

**Costs are four legs in and four legs out.** Eight brokerage charges plus STT
on every sold leg. On a narrow condor in a weekly contract, total cost can
consume a large share of the credit. This is the most cost-sensitive structure
in this folder, and narrow wings make the ratio worse, not better.

**Strike steps.** NIFTY 50 points, BANKNIFTY 100. The `ATM±2` / `ATM±4` in the
frontmatter are strike *steps*, so the same lesson produces a 100-point-wide
wing in NIFTY and a 200-point one in BANKNIFTY. Live steps come from the scrip
master.

**Expiry-day treatment.** The 2% extreme loss margin on short options applies
to both short legs. The February 2025 withdrawal of calendar-spread benefit
does not affect a single-expiry condor.

**Weekly versus monthly.** With BANKNIFTY, FINNIFTY and MIDCPNIFTY monthly-only
since November 2024, a condor in those indices is held for weeks. Theta accrues
more slowly and there is far more time for the underlying to reach a short
strike.

**Physical settlement.** On a stock condor settling between a short strike and
its wing, the short leg is assigned and the long is not — creating a
full-contract-value delivery obligation on E+2 despite the position being
defined-risk. Index condors settle in cash.

## How it typically fails

Two ways, and they are opposite.

Held to expiry, the condor's high hit rate is real and the occasional full-width
loss is the payoff working as designed — problematic only if size was calibrated
to the hit rate.

Managed actively, the more common failure is adjusting a threatened side into a
larger position, converting a defined loss into a rolling one. The wings bound
the original position, not its successors.

## Related

- `strategies/volatility/short-strangle.md` — the undefined-risk version
- `strategies/volatility/iron-butterfly.md` — same idea, short strikes together
- `strategies/vertical-spreads/bull-put-spread.md` — this position's lower half
- `strategies/vertical-spreads/bear-call-spread.md` — its upper halfe:T103b,# Long Straddle

A long call and a long put at the same strike, same expiry — almost always at the
money. The position has no directional view; it has a view about magnitude.

## The structure

Two long legs, one strike. Total premium is the sum of both, and that total
is the maximum loss.

Delta is roughly zero at entry because the call's positive delta and the put's
negative delta offset. The position is not betting on direction. It is betting
that realised movement will exceed what implied volatility has priced in.

## What it is exposed to

**Gamma** strongly positive. This is the engine. As the underlying moves in
either direction, the position acquires delta in the direction of the move —
it gets longer as price rises and shorter as price falls. That self-correcting
property is what produces gain from movement alone.

**Theta** strongly negative, and it is paid twice. Two long options both decay,
and both are at the money where extrinsic value is greatest. An at-the-money
straddle in the final days of a weekly contract loses value at a rate that
surprises people who have only held single options.

**Vega** strongly positive. The position gains if implied volatility rises even
without the underlying moving.

The tension between gamma and theta is the whole trade. Gamma pays when the
underlying moves; theta charges rent for the privilege of holding gamma. The
position is profitable when realised volatility exceeds implied volatility over
the holding period — that is the actual condition, stated precisely.

## Payoff

At expiry the position is worth the distance between the underlying and the
strike, in either direction. It is profitable beyond strike ± total premium.
Maximum loss occurs at exactly the strike, where both legs expire worthless.

The breakevens are wide. Both legs' premiums must be recovered by movement in
*one* direction, since only one leg can finish in the money. This is why a
straddle needs a genuinely large move, not merely a directional one.

## Indian market specifics

**The event problem.** Straddles are most often bought before scheduled events
— results, RBI policy, budget, election counting. Implied volatility rises into
those events precisely because everyone anticipates movement. The straddle
bought the day before is paying an inflated premium, and when the event passes,
implied volatility collapses regardless of outcome. The underlying can move
substantially and the straddle can still lose, because the vega loss exceeds
the gamma gain.

This is the most reliable way to lose money on a correct forecast, and it is
covered in `volatility/volatility-crush.md`.

**Weekly decay.** With only NIFTY carrying weekly contracts on NSE since the
November 2024 rationalisation, weekly straddles concentrate in one instrument.
A NIFTY weekly straddle held from Wednesday into Tuesday expiry faces
near-vertical theta in its final sessions.

**India VIX** is the reference for whether the straddle is being bought cheap
or dear. An at-the-money straddle's price is approximately the market's
expected move over the contract's life — comparing that implied move against
the underlying's recent realised range is the comparison the position depends
on.

**Cost.** Two legs in, two out, plus STT on both sold legs at exit. On a weekly
NIFTY straddle these costs are small relative to premium, but on an illiquid
stock straddle the bid-ask on two legs can consume a meaningful share of the
expected move.

## How it typically fails

Buying before an event and holding through it, as above. Second: holding
through a quiet period and paying theta on both legs for days while the
underlying oscillates within the breakevens — being right that a move is coming
but wrong about when, which for a decaying position is the same as being wrong.

## Related

- `strategies/volatility/long-strangle.md` — cheaper, wider breakevens, same idea
- `strategies/volatility/short-straddle.md` — the other side of this trade
- `volatility/historical-vs-implied.md` — the comparison that determines the outcomef:Te06,# Long Strangle

A long out-of-the-money call and a long out-of-the-money put, same expiry. The
lower-cost relative of the long straddle.

## The structure

Two long legs at different strikes, both out of the money, usually placed
symmetrically around spot. Total premium is lower than the equivalent straddle
because neither leg has intrinsic value and both are further from the money.

## What it is exposed to

The same four exposures as a long straddle, all attenuated.

**Gamma** positive but lower at entry than a straddle's, since gamma peaks at
the money and both legs are away from it. Gamma rises as the underlying
approaches either strike.

**Theta** negative but smaller in absolute terms — out-of-the-money options
carry less extrinsic value to lose per day.

**Vega** positive. Note that out-of-the-money options carry proportionally more
vega relative to their price than at-the-money options do, so a strangle is
more *percentage*-sensitive to a volatility change than a straddle, even though
its absolute vega is lower.

## Payoff versus the straddle

The comparison is the reason to choose between them, and it is not simply
"cheaper".

A straddle loses its maximum only at exactly one price. A strangle loses its
maximum across the entire range between the strikes — a much larger set of
outcomes. In exchange, the maximum is a smaller number.

A strangle's breakevens are further apart than a straddle's on the same
underlying, so it needs a larger move to profit, but it needs less money at
risk to get there. Which is preferable depends on the shape of the expected
move rather than on cost alone: a strangle suits a scenario where a very large
move is plausible, a straddle where a moderate one is.

## Indian market specifics

**Skew makes the strangle asymmetric.** The out-of-the-money put trades at
higher implied volatility than the equidistant out-of-the-money call. A
symmetric-strike strangle is therefore not a symmetric-cost position — more of
the premium is spent on the put side. Choosing strikes by equal premium rather
than equal distance produces a differently shaped position, with the call
strike closer to spot than the put.

**Event pricing.** As with straddles, implied volatility rises into scheduled
events and collapses after. A strangle bought into an event faces the same
volatility crush, and because out-of-the-money options are proportionally more
vega-sensitive, the percentage damage from the crush is worse.

**Liquidity.** Strikes two or three steps out in NIFTY weeklies are liquid.
The equivalent strikes in a monthly-only index like BANKNIFTY, or in a single
stock, may not be — and a strangle's economics are sensitive to paying the
spread on two legs at entry and two at exit.

**Expiry cadence.** NIFTY weekly on Tuesday, BANKNIFTY and the other indices
monthly on the last Tuesday, SENSEX weekly on Thursday. A monthly-only strangle
holds gamma for weeks rather than days, changing the theta burden
substantially.

## How it typically fails

The underlying moves, but not far enough. A strangle rewards magnitude, and a
move that would have paid a straddle handsomely can leave a strangle at a total
loss because it never cleared the further strike. The second pattern is the
event trade described above.

## Related

- `strategies/volatility/long-straddle.md` — narrower breakevens, higher cost
- `strategies/volatility/short-strangle.md` — the other side
- `volatility/smile-and-skew.md` — why the two legs are not priced symmetrically10:Tfbc,# Short Straddle

A short call and a short put at the same strike, same expiry. The mirror of the long
straddle, and the structure with the most concentrated risk profile in common
retail use in the Indian market.

## The structure

Two short legs at one strike, usually at the money. Premium from both is
credited at entry. Margin is blocked on both.

Delta is near zero at entry. The position is short movement.

## What it is exposed to

**Theta** strongly positive, collected on two at-the-money legs — the largest
theta available from any two-leg structure. This is the attraction.

**Gamma** strongly negative, and this is the entire risk. The position acquires
delta *against* the direction of movement: it becomes short as the underlying
rises and long as it falls. Every point of movement makes the next point more
expensive. Gamma magnitude peaks at the money and rises steeply into expiry,
so the position is most dangerous exactly where and when it earns the most
theta.

There is no way to separate these. The theta is compensation for the gamma.

**Vega** strongly negative. A volatility expansion damages the position
independently of direction.

## Payoff

Maximum profit is the full premium, achieved only if the underlying settles
exactly at the strike. Losses accrue in both directions beyond strike ± total
premium — unbounded above, bounded only by zero below.

The distribution is extreme: a high probability of a moderate gain against a
low probability of a loss with no defined ceiling. This is the payoff shape
that win-rate statistics describe worst.

## Indian market specifics

This structure interacts with Indian market rules more than any other in this
folder, and every interaction runs the same direction.

**Expiry-day margin.** An additional 2% extreme loss margin on short option
positions applies on expiry day, in force since November 2024 — precisely when
a short straddle's gamma is at its maximum.

**Calendar-spread benefit withdrawn.** From February 2025, margin offset from
positions in other expiries is not available on expiry day. A short straddle
partially hedged by longer-dated longs loses that margin relief on the day it
is most needed.

**Intraday position monitoring.** Since April 2025 position limits are checked
at multiple points during the day rather than at close, so an intraday
expansion cannot be quietly netted out before the snapshot.

**Gap risk.** The position is held overnight against global cues, results and
policy. A gap opens beyond the breakeven with no opportunity to exit in
between. No stop-loss executes across a gap.

**Physical settlement.** On a stock straddle, whichever leg finishes in the
money is assigned, producing a delivery or receipt obligation for the full
contract value on E+2 — a cash requirement unrelated to the margin the position
was sized against.

**Weekly concentration.** Since only NIFTY carries an NSE weekly, short-dated
straddle flow concentrates there, which is also where gamma is sharpest.

## How it typically fails

It works, repeatedly, and that is the mechanism of failure. A short straddle
retains premium in most expiries, which builds a track record that justifies
larger size, which is then in place when a gap or a volatility expansion
arrives. The loss is not proportional to the gains that preceded it and is not
bounded by them.

Every element of SEBI's post-2024 derivatives framework — the margin additions,
the expiry-day treatment, the contract-value floor — is a response to the
aggregate of these positions, which is itself informative about the risk
profile.

## Related

- `strategies/volatility/iron-butterfly.md` — the same structure with wings
  bought, converting unbounded loss to a defined one
- `strategies/volatility/short-strangle.md` — wider strikes, less theta, more room
- `greeks/gamma.md` — why the loss accelerates
- `risk/tail-risk.md` — why win rate does not describe this11:Tecc,# Short Strangle

A short out-of-the-money call and a short out-of-the-money put, same expiry. The
most widely used undefined-risk premium-selling structure in the Indian retail
market.

## The structure

Two short legs, both out of the money. Premium from both is credited. Margin is
blocked on both legs, though exchanges grant some offset for the opposing
directional exposure.

## What it is exposed to

**Theta** positive across a wide price range — the structural attraction. Unlike
a short straddle, which realises maximum profit at exactly one price, a short
strangle realises maximum profit anywhere between its strikes. That wide
profit plateau is what makes it feel safer than it is.

**Gamma** negative, low while the underlying sits mid-range, rising sharply as
price approaches either strike. The risk is not uniform across the position's
life: it is negligible for most of the holding period and then concentrated.

**Vega** negative. A volatility expansion damages both legs at once.

## Why the wide plateau is misleading

The payoff diagram's flat top spans a wide range, which reads as a large margin
of safety. What the diagram does not show is that the position's risk is not
distributed across that range — it is entirely in the tails, and the tails are
where the position has no defined loss.

A short strangle's profit is capped and known. Its loss is neither. The wide
plateau increases the probability of the capped outcome without changing the
magnitude of the uncapped one.

## Indian market specifics

Every structural rule that applies to the short straddle applies here.

**Expiry-day extreme loss margin** of 2% on short options, since November 2024.

**Calendar-spread margin benefit withdrawn on expiry day**, February 2025 — a
strangle margin-offset by longer-dated positions loses that offset on expiry
day.

**Intraday position-limit monitoring** at multiple snapshots since April 2025.

**Contract-value floor.** SEBI's November 2024 increase of minimum index
contract value to ₹15–20 lakh means a single strangle's notional exposure is
substantial. The margin blocked is a fraction of that notional; the loss in a
tail move is not.

**Gap risk** is the dominant hazard. Both legs are exposed overnight. An
opening gap beyond a strike converts a comfortable position into a large loss
with no intervening opportunity to act.

**Skew.** The put leg collects more premium than the equidistant call leg.
Selecting strikes by equal premium rather than equal distance places the put
strike further from spot than the call — a materially different risk
distribution from the symmetric version, and generally the more considered
construction.

**Physical settlement** on stock strangles: whichever leg finishes in the money
creates a full-contract-value obligation on E+2.

## The defined-risk equivalent

An iron condor is a short strangle with further-out wings bought on both sides.
It collects less premium, caps the loss at the wing width, and reduces margin
substantially. The comparison between the two is the central capital-allocation
question in premium selling, and is set out in
`strategies/volatility/iron-condor.md`.

## How it typically fails

Long sequences of full-premium expiries, size scaled to that experience, and a
single gap or volatility expansion that removes more than the sequence
contributed. The structure's reliability is real; it is the loss distribution
that is misread, not the win rate.

## Related

- `strategies/volatility/iron-condor.md` — the defined-risk version
- `strategies/volatility/short-straddle.md` — narrower, more theta, more gamma
- `risk/position-sizing.md` — sizing against notional rather than margin15:{"fontFamily":"system-ui,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\"","height":"100vh","textAlign":"center","display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center"}
16:{"display":"inline-block","margin":"0 20px 0 0","padding":"0 23px 0 0","fontSize":24,"fontWeight":500,"verticalAlign":"top","lineHeight":"49px"}
17:{"display":"inline-block"}
18:{"fontSize":14,"fontWeight":400,"lineHeight":"49px","margin":0}
0:["y07uMnhZvjRDJDyCaG9hS",[[["",{"children":["(workspace)",{"children":["learning",{"children":["strategies",{"children":["__PAGE__",{}]}]}]}]},"$undefined","$undefined",true],["",{"children":["(workspace)",{"children":["learning",{"children":["strategies",{"children":["__PAGE__",{},[["$L1",["$","div",null,{"className":"mx-auto max-w-[1200px] space-y-4 p-4","children":[["$","$L2",null,{"href":"/learning","className":"text-[12px] text-teal hover:underline","children":"← Learning"}],["$","div",null,{"className":"rounded-card border px-[18px] py-4 transition-colors duration-panel ease-standard bg-card border-border shadow-card","children":[["$","div",null,{"className":"mb-3 flex items-center gap-2","children":["$undefined",["$","h2",null,{"className":"text-base font-semibold leading-tight","children":["Continue learning",["$","small",null,{"className":"ml-2 text-xs font-normal text-faint","children":"· your paths"}]]}],false]}],["$","div",null,{"className":"grid gap-3 sm:grid-cols-3","children":[["$","div","New Trader Foundations",{"className":"rounded-lg border border-border bg-bg p-3","children":[["$","div",null,{"className":"text-sm font-semibold text-text","children":"New Trader Foundations"}],["$","div",null,{"className":"mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border2","children":["$","div",null,{"className":"h-full rounded-full bg-teal","style":{"width":"35%"}}]}],["$","div",null,{"className":"mt-1 text-[11px] text-faint","children":"35% complete"}]]}],["$","div","Options Essentials",{"className":"rounded-lg border border-border bg-bg p-3","children":[["$","div",null,{"className":"text-sm font-semibold text-text","children":"Options Essentials"}],["$","div",null,{"className":"mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border2","children":["$","div",null,{"className":"h-full rounded-full bg-teal","style":{"width":"0%"}}]}],["$","div",null,{"className":"mt-1 text-[11px] text-faint","children":"Not started"}]]}],["$","div","Disciplined Execution",{"className":"rounded-lg border border-border bg-bg p-3","children":[["$","div",null,{"className":"text-sm font-semibold text-text","children":"Disciplined Execution"}],["$","div",null,{"className":"mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border2","children":["$","div",null,{"className":"h-full rounded-full bg-teal","style":{"width":"12%"}}]}],["$","div",null,{"className":"mt-1 text-[11px] text-faint","children":"12% complete"}]]}]]}]]}],["$","div",null,{"children":[["$","div",null,{"className":"mb-2 flex items-baseline justify-between","children":[["$","h2",null,{"className":"text-sm font-bold text-text","children":"Strategies"}],["$","span",null,{"className":"text-[11px] text-faint","children":[14," explained · each one can be drawn against live prices"]}]]}],["$","div",null,{"className":"space-y-3","children":["$","$L3",null,{"strategies":[{"id":"long-call","name":"Long Call","category":"directional","tier":"beginner","summary":"A single bought call. Loss is capped at the premium paid; gain is uncapped above the strike, but time decay works against the position every day it is held.","concept":"option-greeks","path":"docs/learning/strategies/directional/long-call.md","body":"$4","legs":[{"action":"BUY","kind":"CE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"}],"net":"debit","outlook":"bullish","maxProfit":"Unlimited above the strike","maxLoss":"The premium paid","breakeven":"Strike plus premium paid","greeks":{"delta":"positive","gamma":"positive","theta":"negative","vega":"positive"},"chartNote":"The line marks the strike; the position only starts making money above the strike plus the premium paid, and everything below that line is the loss of premium."},{"id":"long-put","name":"Long Put","category":"directional","tier":"beginner","summary":"A single bought put. Loss is capped at the premium paid; gain accrues as the underlying falls below the strike, bounded only by the underlying reaching zero.","concept":"option-greeks","path":"docs/learning/strategies/directional/long-put.md","body":"$5","legs":[{"action":"BUY","kind":"PE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"}],"net":"debit","outlook":"bearish","maxProfit":"Strike minus premium, reached if the underlying goes to zero","maxLoss":"The premium paid","breakeven":"Strike minus premium paid","greeks":{"delta":"negative","gamma":"positive","theta":"negative","vega":"positive"},"chartNote":"The line marks the strike; the position only starts making money below the strike minus the premium paid, and everything above that line is the loss of premium."},{"id":"short-call","name":"Short Call","category":"directional","tier":"advanced","summary":"A single sold call. Premium is received upfront and kept if the underlying stays below the strike, but loss above the strike is unbounded and margin is required throughout.","concept":"option-greeks","path":"docs/learning/strategies/directional/short-call.md","body":"$6","legs":[{"action":"SELL","kind":"CE","strike":"ATM+2","strikeOffset":2,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"neutral-to-bearish","maxProfit":"The premium received","maxLoss":"Unlimited above the strike","breakeven":"Strike plus premium received","greeks":{"delta":"negative","gamma":"negative","theta":"positive","vega":"negative"},"chartNote":"The line marks the strike; the premium is kept in full anywhere below it, and losses grow without limit the further the underlying rises above it."},{"id":"short-put","name":"Short Put","category":"directional","tier":"advanced","summary":"A single sold put. Premium is kept if the underlying stays above the strike; loss below the strike is bounded only by the underlying reaching zero, and margin is required throughout.","concept":"option-greeks","path":"docs/learning/strategies/directional/short-put.md","body":"$7","legs":[{"action":"SELL","kind":"PE","strike":"ATM-2","strikeOffset":-2,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"neutral-to-bullish","maxProfit":"The premium received","maxLoss":"Strike minus premium, if the underlying goes to zero","breakeven":"Strike minus premium received","greeks":{"delta":"positive","gamma":"negative","theta":"positive","vega":"negative"},"chartNote":"The line marks the strike; the premium is kept in full anywhere above it, and losses grow the further the underlying falls below it."},{"id":"bear-call-spread","name":"Bear Call Spread","category":"vertical-spread","tier":"intermediate","summary":"A short call with a long call above it in the same expiry. Premium is received upfront and the long leg caps the loss at the spread width.","concept":"option-greeks","path":"docs/learning/strategies/vertical-spreads/bear-call-spread.md","body":"$8","legs":[{"action":"SELL","kind":"CE","strike":"ATM+1","strikeOffset":1,"ratio":1,"expiry":"near"},{"action":"BUY","kind":"CE","strike":"ATM+3","strikeOffset":3,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"neutral-to-bearish","maxProfit":"Net credit received","maxLoss":"Spread width minus net credit","breakeven":"Lower strike plus net credit","greeks":{"delta":"negative","gamma":"mixed","theta":"positive","vega":"negative"},"chartNote":"The credit is kept in full below the lower line; the upper line is where the loss stops growing, which is what the bought call is paying for."},{"id":"bear-put-spread","name":"Bear Put Spread","category":"vertical-spread","tier":"intermediate","summary":"A long put with a short put below it in the same expiry. The sale reduces the cost and caps the gain at the lower strike.","concept":"option-greeks","path":"docs/learning/strategies/vertical-spreads/bear-put-spread.md","body":"$9","legs":[{"action":"BUY","kind":"PE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"PE","strike":"ATM-2","strikeOffset":-2,"ratio":1,"expiry":"near"}],"net":"debit","outlook":"moderately-bearish","maxProfit":"Spread width minus net debit","maxLoss":"Net debit paid","breakeven":"Higher strike minus net debit","greeks":{"delta":"negative","gamma":"mixed","theta":"mixed","vega":"negative"},"chartNote":"The two lines are the strikes; profit builds as price falls between them and stops growing at the lower line."},{"id":"bull-call-spread","name":"Bull Call Spread","category":"vertical-spread","tier":"intermediate","summary":"A long call with a short call above it in the same expiry. The sale funds part of the purchase, which lowers breakeven and caps the gain at the short strike.","concept":"option-greeks","path":"docs/learning/strategies/vertical-spreads/bull-call-spread.md","body":"$a","legs":[{"action":"BUY","kind":"CE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"CE","strike":"ATM+2","strikeOffset":2,"ratio":1,"expiry":"near"}],"net":"debit","outlook":"moderately-bullish","maxProfit":"Spread width minus net debit","maxLoss":"Net debit paid","breakeven":"Lower strike plus net debit","greeks":{"delta":"positive","gamma":"mixed","theta":"mixed","vega":"negative"},"chartNote":"The two lines are the strikes; profit builds between them and stops growing at the upper line, which is the price of having paid less to enter."},{"id":"bull-put-spread","name":"Bull Put Spread","category":"vertical-spread","tier":"intermediate","summary":"A short put with a long put below it in the same expiry. Premium is received upfront and the long leg caps the loss at the spread width.","concept":"option-greeks","path":"docs/learning/strategies/vertical-spreads/bull-put-spread.md","body":"$b","legs":[{"action":"SELL","kind":"PE","strike":"ATM-1","strikeOffset":-1,"ratio":1,"expiry":"near"},{"action":"BUY","kind":"PE","strike":"ATM-3","strikeOffset":-3,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"neutral-to-bullish","maxProfit":"Net credit received","maxLoss":"Spread width minus net credit","breakeven":"Higher strike minus net credit","greeks":{"delta":"positive","gamma":"mixed","theta":"positive","vega":"negative"},"chartNote":"The credit is kept in full above the upper line; the lower line is where the loss stops growing, which is what the bought put is paying for."},{"id":"iron-butterfly","name":"Iron Butterfly","category":"volatility","tier":"advanced","summary":"A short straddle with protective wings bought on both sides. Four legs, one expiry — maximum profit at the centre strike, loss capped at the wing width.","concept":"implied-volatility","path":"docs/learning/strategies/volatility/iron-butterfly.md","body":"$c","legs":[{"action":"BUY","kind":"PE","strike":"ATM-2","strikeOffset":-2,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"PE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"CE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"},{"action":"BUY","kind":"CE","strike":"ATM+2","strikeOffset":2,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"direction-neutral, expecting price to settle near the centre strike","maxProfit":"Net credit received, at the centre strike","maxLoss":"Wing width minus net credit","breakeven":"Centre strike minus credit, and centre strike plus credit","greeks":{"delta":"neutral","gamma":"negative","theta":"positive","vega":"negative"},"chartNote":"The middle line is where the position pays most and the outer two are where the loss stops growing — it wants price pinned to the centre."},{"id":"iron-condor","name":"Iron Condor","category":"volatility","tier":"advanced","summary":"A short strangle with protective wings bought outside both strikes. Four legs, one expiry — premium is kept between the short strikes and loss is capped at the wing width.","concept":"implied-volatility","path":"docs/learning/strategies/volatility/iron-condor.md","body":"$d","legs":[{"action":"BUY","kind":"PE","strike":"ATM-4","strikeOffset":-4,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"PE","strike":"ATM-2","strikeOffset":-2,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"CE","strike":"ATM+2","strikeOffset":2,"ratio":1,"expiry":"near"},{"action":"BUY","kind":"CE","strike":"ATM+4","strikeOffset":4,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"direction-neutral, expecting little movement","maxProfit":"Net credit received, anywhere between the short strikes","maxLoss":"Wing width minus net credit","breakeven":"Short put strike minus credit, and short call strike plus credit","greeks":{"delta":"neutral","gamma":"negative","theta":"positive","vega":"negative"},"chartNote":"The inner two lines are where the premium is kept and the outer two are where the loss stops growing — the position wants price to finish between the inner pair."},{"id":"long-straddle","name":"Long Straddle","category":"volatility","tier":"intermediate","summary":"A long call and a long put at the same strike and expiry. The position gains on a large move in either direction and loses if the underlying stays still.","concept":"implied-volatility","path":"docs/learning/strategies/volatility/long-straddle.md","body":"$e","legs":[{"action":"BUY","kind":"CE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"},{"action":"BUY","kind":"PE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"}],"net":"debit","outlook":"direction-neutral, expecting a large move","maxProfit":"Unlimited on the upside, bounded by zero on the downside","maxLoss":"Total premium paid, if the underlying settles exactly at the strike","breakeven":"Strike plus total premium, and strike minus total premium","greeks":{"delta":"neutral","gamma":"positive","theta":"negative","vega":"positive"},"chartNote":"The single line is the strike; the position needs price to finish outside either breakeven marker, and loses most if it finishes right on the line."},{"id":"long-strangle","name":"Long Strangle","category":"volatility","tier":"intermediate","summary":"A long out-of-the-money call paired with a long out-of-the-money put in the same expiry. Cheaper than a straddle, with wider breakevens and a flat loss zone between the strikes.","concept":"implied-volatility","path":"docs/learning/strategies/volatility/long-strangle.md","body":"$f","legs":[{"action":"BUY","kind":"PE","strike":"ATM-2","strikeOffset":-2,"ratio":1,"expiry":"near"},{"action":"BUY","kind":"CE","strike":"ATM+2","strikeOffset":2,"ratio":1,"expiry":"near"}],"net":"debit","outlook":"direction-neutral, expecting a large move","maxProfit":"Unlimited on the upside, bounded by zero on the downside","maxLoss":"Total premium paid, anywhere between the two strikes","breakeven":"Upper strike plus total premium, and lower strike minus total premium","greeks":{"delta":"neutral","gamma":"positive","theta":"negative","vega":"positive"},"chartNote":"The two lines are the strikes; the full premium is lost anywhere between them, and the position only pays beyond the breakeven markers outside them."},{"id":"short-straddle","name":"Short Straddle","category":"volatility","tier":"advanced","summary":"A short call and a short put at the same strike and expiry. Premium is kept if the underlying stays near the strike; loss grows without limit as it moves away in either direction.","concept":"implied-volatility","path":"docs/learning/strategies/volatility/short-straddle.md","body":"$10","legs":[{"action":"SELL","kind":"CE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"PE","strike":"ATM","strikeOffset":0,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"direction-neutral, expecting little movement","maxProfit":"Total premium received, if the underlying settles exactly at the strike","maxLoss":"Unlimited on the upside, very large on the downside","breakeven":"Strike plus total premium, and strike minus total premium","greeks":{"delta":"neutral","gamma":"negative","theta":"positive","vega":"negative"},"chartNote":"The single line is the strike; the full premium is kept only if price finishes near it, and losses grow in both directions beyond the breakeven markers."},{"id":"short-strangle","name":"Short Strangle","category":"volatility","tier":"advanced","summary":"A short out-of-the-money call paired with a short out-of-the-money put in the same expiry. Full premium is kept anywhere between the strikes; loss beyond them is unbounded.","concept":"implied-volatility","path":"docs/learning/strategies/volatility/short-strangle.md","body":"$11","legs":[{"action":"SELL","kind":"PE","strike":"ATM-2","strikeOffset":-2,"ratio":1,"expiry":"near"},{"action":"SELL","kind":"CE","strike":"ATM+2","strikeOffset":2,"ratio":1,"expiry":"near"}],"net":"credit","outlook":"direction-neutral, expecting little movement","maxProfit":"Total premium received, anywhere between the two strikes","maxLoss":"Unlimited on the upside, very large on the downside","breakeven":"Upper strike plus total premium, and lower strike minus total premium","greeks":{"delta":"neutral","gamma":"negative","theta":"positive","vega":"negative"},"chartNote":"The two lines are the strikes; the full premium is kept anywhere between them, and losses grow without limit beyond the breakeven markers outside them."}]}]}]]}],["$","div",null,{"children":[["$","h2",null,{"className":"mb-2 text-sm font-bold text-text","children":"Market structure & concepts"}],["$","div",null,{"className":"grid gap-2 sm:grid-cols-2","children":[["$","$L2","contract-value-and-lot-size",{"href":"/learning/strategy/contract-value-and-lot-size","className":"rounded-lg border border-border bg-card p-3 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","div",null,{"className":"flex items-center gap-1.5","children":[["$","span",null,{"className":"text-sm font-semibold text-text","children":"Contract Value and Why Lot Sizes Change"}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"beginner"}]]}],["$","p",null,{"className":"mt-1 text-[11.5px] leading-relaxed text-muted","children":"SEBI fixes a notional contract-value band, not a lot size. Lot size is the dependent variable, recalculated as index levels drift — which is why every hardcoded lot size eventually goes stale."}]]}],["$","$L2","expiry-architecture",{"href":"/learning/strategy/expiry-architecture","className":"rounded-lg border border-border bg-card p-3 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","div",null,{"className":"flex items-center gap-1.5","children":[["$","span",null,{"className":"text-sm font-semibold text-text","children":"NSE and BSE Expiry Architecture"}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"beginner"}]]}],["$","p",null,{"className":"mt-1 text-[11.5px] leading-relaxed text-muted","children":"Which contracts expire on which day, why only two indices still carry weekly expiries, and how the holiday rule shifts settlement."}]]}],["$","$L2","physical-settlement",{"href":"/learning/strategy/physical-settlement","className":"rounded-lg border border-border bg-card p-3 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","div",null,{"className":"flex items-center gap-1.5","children":[["$","span",null,{"className":"text-sm font-semibold text-text","children":"Physical Settlement of Stock F&O"}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"intermediate"}]]}],["$","p",null,{"className":"mt-1 text-[11.5px] leading-relaxed text-muted","children":"Stock derivatives settle in shares, not cash. What that obliges, when delivery margins begin, and why it turns defined-risk positions into undefined cash requirements."}]]}],["$","$L2","sebi-derivatives-framework",{"href":"/learning/strategy/sebi-derivatives-framework","className":"rounded-lg border border-border bg-card p-3 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","div",null,{"className":"flex items-center gap-1.5","children":[["$","span",null,{"className":"text-sm font-semibold text-text","children":"SEBI's Index Derivatives Framework"}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"intermediate"}]]}],["$","p",null,{"className":"mt-1 text-[11.5px] leading-relaxed text-muted","children":"The six measures SEBI introduced from October 2024 onward, what each one changed, and how they interact with short option positions."}]]}],["$","$L2","transaction-costs",{"href":"/learning/strategy/transaction-costs","className":"rounded-lg border border-border bg-card p-3 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","div",null,{"className":"flex items-center gap-1.5","children":[["$","span",null,{"className":"text-sm font-semibold text-text","children":"Transaction Costs in Indian F&O"}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"beginner"}]]}],["$","p",null,{"className":"mt-1 text-[11.5px] leading-relaxed text-muted","children":"STT, exchange charges, stamp duty, GST and brokerage — what each is levied on, which side pays, and why exercised options are the expensive case."}]]}]]}]]}],["$","div",null,{"children":[["$","h2",null,{"className":"mb-2 text-sm font-bold text-text","children":"Explore by topic"}],["$","div",null,{"className":"grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4","children":[["$","div","Trading Basics",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Trading Basics"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[12," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"Beginner"}]]}]]}],["$","div","Price Action",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Price Action"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[9," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"Intermediate"}]]}]]}],["$","div","Indicators",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Indicators"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[14," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"Intermediate"}]]}]]}],["$","div","Market Structure",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Market Structure"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[8," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"Intermediate"}]]}]]}],["$","div","Risk Management",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Risk Management"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[7," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"All levels"}]]}]]}],["$","div","Psychology",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Psychology"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[6," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"All levels"}]]}]]}],["$","div","Backtesting",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Backtesting"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[5," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"Advanced"}]]}]]}],["$","div","Historical Case Studies",{"className":"flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal","children":[["$","span",null,{"className":"text-teal","children":["$","svg",null,{"viewBox":"0 0 24 24","width":18,"height":18,"fill":"none","stroke":"currentColor","strokeWidth":1.7,"strokeLinecap":"round","strokeLinejoin":"round","className":"h-5 w-5","children":[["$","path",null,{"d":"M3 7l9-4 9 4-9 4-9-4z"}],["$","path",null,{"d":"M7 9v5c0 1.1 2.2 2 5 2s5-.9 5-2V9"}]]}]}],["$","div",null,{"className":"text-sm font-semibold text-text","children":"Historical Case Studies"}],["$","div",null,{"className":"mt-auto flex items-center justify-between","children":[["$","span",null,{"className":"text-[11px] text-faint","children":[11," lessons"]}],["$","span",null,{"className":"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold leading-tight whitespace-nowrap bg-hover text-muted border border-border2 px-1.5 py-0 text-[9px]","children":"Advanced"}]]}]]}]]}]]}]]}],null],null],null]},[null,["$","$L12",null,{"parallelRouterKey":"children","segmentPath":["children","(workspace)","children","learning","children","strategies","children"],"error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L13",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":"$undefined","notFoundStyles":"$undefined"}]],null]},[null,["$","$L12",null,{"parallelRouterKey":"children","segmentPath":["children","(workspace)","children","learning","children"],"error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L13",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":"$undefined","notFoundStyles":"$undefined"}]],null]},[[null,["$","$L14",null,{"children":["$","$L12",null,{"parallelRouterKey":"children","segmentPath":["children","(workspace)","children"],"error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L13",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":[["$","title",null,{"children":"404: This page could not be found."}],["$","div",null,{"style":{"fontFamily":"system-ui,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\"","height":"100vh","textAlign":"center","display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center"},"children":["$","div",null,{"children":[["$","style",null,{"dangerouslySetInnerHTML":{"__html":"body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}"}}],["$","h1",null,{"className":"next-error-h1","style":{"display":"inline-block","margin":"0 20px 0 0","padding":"0 23px 0 0","fontSize":24,"fontWeight":500,"verticalAlign":"top","lineHeight":"49px"},"children":"404"}],["$","div",null,{"style":{"display":"inline-block"},"children":["$","h2",null,{"style":{"fontSize":14,"fontWeight":400,"lineHeight":"49px","margin":0},"children":"This page could not be found."}]}]]}]}]],"notFoundStyles":[]}]}]],null],null]},[[[["$","link","0",{"rel":"stylesheet","href":"/_next/static/css/78bdfd9ce22bf526.css","precedence":"next","crossOrigin":"$undefined"}]],["$","html",null,{"lang":"en","data-theme":"dark","suppressHydrationWarning":true,"children":[["$","head",null,{"children":["$","script",null,{"dangerouslySetInnerHTML":{"__html":"(function(){try{var r=localStorage.getItem('tradew-workspace-v1');var t='dark';if(r){var p=JSON.parse(r);if(p&&p.state&&p.state.theme)t=p.state.theme;}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();"}}]}],["$","body",null,{"children":["$","$L12",null,{"parallelRouterKey":"children","segmentPath":["children"],"error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$L13",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":[["$","title",null,{"children":"404: This page could not be found."}],["$","div",null,{"style":"$15","children":["$","div",null,{"children":[["$","style",null,{"dangerouslySetInnerHTML":{"__html":"body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}"}}],["$","h1",null,{"className":"next-error-h1","style":"$16","children":"404"}],["$","div",null,{"style":"$17","children":["$","h2",null,{"style":"$18","children":"This page could not be found."}]}]]}]}]],"notFoundStyles":[]}]}]]}]],null],null],["$L19",null]]]]
19:[["$","meta","0",{"name":"viewport","content":"width=device-width, initial-scale=1"}],["$","meta","1",{"charSet":"utf-8"}],["$","title","2",{"children":"Strategies — TradeW Learning"}],["$","meta","3",{"name":"description","content":"Institutional AI trading workspace. Observations only — never investment advice."}]]
1:null
