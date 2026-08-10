#!/usr/bin/env python3
"""Reference implementation of Dhan's algo-strategy API surface.

Companion code to `knowledge/API/2026-08-11 - Dhan Algo Strategies.md`. Read that
note first — it explains *why* this file is shaped the way it is. The short
version:

  Dhan has no endpoint that returns algo trading strategies. The marketplace at
  algos.dhan.co is UI-only. What the API exposes is (a) one server-side rule
  engine, Conditional Trigger Orders, with a fixed 21-indicator vocabulary, and
  (b) execution primitives you compose your own strategies out of. This module
  implements both, and turns the expressible half of (a) into a named catalog.

Scope and boundaries
--------------------
* This lives in `scripts/` for the same reason `requirements.txt` does: Dhan API
  exploration and verification. It is **not** the trading-engine's code, and it
  is not in any request path. `services/trading-engine` remains un-migrated
  pending explicit approval (ARCHITECTURE.md §2, ADR-045).
* Per CLAUDE.md Rule 2, **AI services never place trades**. Nothing here may be
  imported by `services/sentinel` or TradeW-AI. Conditional Triggers are exactly
  the tempting wire-up that rule forbids: a Sentinel detection may inform a
  human, it may not create an alert-order.
* **Dry-run is the default.** Every state-changing call is a no-op that returns
  the payload it *would* have sent, unless you both construct the client with
  `dry_run=False` and set `DHAN_ALLOW_LIVE_ORDERS=1` in the environment. Two
  independent switches, on purpose — a stray kwarg should not be able to place
  an order.

Zero third-party dependencies (stdlib `urllib` only). The official `dhanhq`
SDK is pinned in `scripts/requirements.txt` at 2.3.0rc1, which predates
Conditional Triggers (shipped in API v2.5, Feb 2026) and does not cover them.

Usage
-----
    export DHAN_ACCESS_TOKEN=... DHAN_CLIENT_ID=...

    python scripts/dhan_algo_strategies.py list-strategies
    python scripts/dhan_algo_strategies.py describe golden-cross
    python scripts/dhan_algo_strategies.py preview rsi-oversold --security-id 1333 --qty 10
    python scripts/dhan_algo_strategies.py triggers
    python scripts/dhan_algo_strategies.py backtest --security-id 1333 --days 365

Retrieved/verified against the docs on 2026-08-11. Dhan ships breaking changes
with release versions — re-check /docs/v2/releases/ before trusting an enum.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, Iterable, Literal, Sequence

BASE_URL = "https://api.dhan.co/v2"
AUTH_URL = "https://auth.dhan.co/app"


# ---------------------------------------------------------------------------
# Enums — mirrored from the DhanHQ Annexure, not invented here.
# ---------------------------------------------------------------------------
# Kept as plain string constants rather than enum.Enum so payloads serialize
# with no `.value` ceremony and a typo is a NameError at import time.

class ExchangeSegment:
    IDX_I = "IDX_I"              # 0
    NSE_EQ = "NSE_EQ"            # 1
    NSE_FNO = "NSE_FNO"          # 2
    NSE_CURRENCY = "NSE_CURRENCY"  # 3
    BSE_EQ = "BSE_EQ"            # 4
    MCX_COMM = "MCX_COMM"        # 5
    BSE_CURRENCY = "BSE_CURRENCY"  # 7
    BSE_FNO = "BSE_FNO"          # 8


#: Conditional Triggers are supported for equities and indices ONLY. This is the
#: single most consequential limit in the whole surface — every F&O strategy has
#: to run its rule loop on our side. See the note's "hard constraint" section.
CONDITIONAL_TRIGGER_SEGMENTS = frozenset(
    {ExchangeSegment.NSE_EQ, ExchangeSegment.BSE_EQ, ExchangeSegment.IDX_I}
)


class TransactionType:
    BUY = "BUY"
    SELL = "SELL"


class ProductType:
    CNC = "CNC"
    INTRADAY = "INTRADAY"
    MARGIN = "MARGIN"
    MTF = "MTF"
    CO = "CO"
    BO = "BO"


class OrderType:
    LIMIT = "LIMIT"
    MARKET = "MARKET"
    STOP_LOSS = "STOP_LOSS"
    STOP_LOSS_MARKET = "STOP_LOSS_MARKET"


class Validity:
    DAY = "DAY"
    IOC = "IOC"


class AmoTime:
    PRE_OPEN = "PRE_OPEN"
    OPEN = "OPEN"
    OPEN_30 = "OPEN_30"
    OPEN_60 = "OPEN_60"


class LegName:
    ENTRY = "ENTRY_LEG"
    TARGET = "TARGET_LEG"
    STOP_LOSS = "STOP_LOSS_LEG"


class ComparisonType:
    """How the left-hand side of a trigger condition is formed.

    NOTE: the Annexure and the Conditional Trigger endpoint page disagree — the
    endpoint page shows TECHNICAL_WITH_TECHNICAL where the Annexure shows
    TECHNICAL_WITH_INDICATOR. The Annexure is treated as authoritative here.
    Verify against a live 400 response before shipping. Tracked as open question
    #3 in the companion note.
    """

    TECHNICAL_WITH_VALUE = "TECHNICAL_WITH_VALUE"        # indicator vs number
    TECHNICAL_WITH_INDICATOR = "TECHNICAL_WITH_INDICATOR"  # indicator vs indicator
    TECHNICAL_WITH_CLOSE = "TECHNICAL_WITH_CLOSE"        # close vs indicator
    PRICE_WITH_VALUE = "PRICE_WITH_VALUE"                # price vs number


class Indicator:
    """The complete indicator vocabulary. Periods are fixed — there is no EMA_9,
    no RSI_2, and no configurable Bollinger sigma. 21 values, that is the lot."""

    SMA_5, SMA_10, SMA_20 = "SMA_5", "SMA_10", "SMA_20"
    SMA_50, SMA_100, SMA_200 = "SMA_50", "SMA_100", "SMA_200"
    EMA_5, EMA_10, EMA_20 = "EMA_5", "EMA_10", "EMA_20"
    EMA_50, EMA_100, EMA_200 = "EMA_50", "EMA_100", "EMA_200"
    BB_UPPER, BB_LOWER = "BB_UPPER", "BB_LOWER"
    RSI_14 = "RSI_14"
    ATR_14 = "ATR_14"
    STOCHASTIC = "STOCHASTIC"
    STOCHRSI_14 = "STOCHRSI_14"
    MACD_12, MACD_26, MACD_HIST = "MACD_12", "MACD_26", "MACD_HIST"


ALL_INDICATORS = frozenset(
    v for k, v in vars(Indicator).items() if not k.startswith("_") and isinstance(v, str)
)


class Operator:
    CROSSING_UP = "CROSSING_UP"
    CROSSING_DOWN = "CROSSING_DOWN"
    CROSSING_ANY_SIDE = "CROSSING_ANY_SIDE"
    GREATER_THAN = "GREATER_THAN"
    LESS_THAN = "LESS_THAN"
    GREATER_THAN_EQUAL = "GREATER_THAN_EQUAL"
    LESS_THAN_EQUAL = "LESS_THAN_EQUAL"
    EQUAL = "EQUAL"
    NOT_EQUAL = "NOT_EQUAL"


class TimeFrame:
    DATE = "DATE"
    ONE_MIN = "ONE_MIN"
    FIVE_MIN = "FIVE_MIN"
    FIFTEEN_MIN = "FIFTEEN_MIN"


#: Intraday chart intervals, in minutes. No 3m, no 30m, no 4h.
CHART_INTERVALS = (1, 5, 15, 25, 60)


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Limit:
    per_second: int
    per_minute: int | None = None
    per_hour: int | None = None
    per_day: int | None = None


#: Published limits. Order APIs are the binding constraint for an algo; the
#: 1 req/sec Quote cap is the one that forced services/market-data to become the
#: sole quote writer in this repo.
RATE_LIMITS: dict[str, _Limit] = {
    "order": _Limit(per_second=10, per_minute=250, per_hour=1_000, per_day=7_000),
    "data": _Limit(per_second=5, per_day=100_000),
    "quote": _Limit(per_second=1),
    "non_trading": _Limit(per_second=20),
}

#: Hard exchange/broker cap. A trailing-stop loop that re-modifies on every tick
#: will exhaust this on a single position — budget modifications, don't stream
#: them.
MAX_MODIFICATIONS_PER_ORDER = 25


class RateLimiter:
    """Sliding-window limiter, one bucket per API category.

    Blocks rather than raising: an algo that gets a 429 mid-sequence is in a
    worse state than one that waited 80ms. Thread-safe because the order-update
    socket and the strategy loop will share a client.
    """

    def __init__(self, limits: dict[str, _Limit] | None = None) -> None:
        self._limits = limits or RATE_LIMITS
        self._hits: dict[str, deque[float]] = {k: deque() for k in self._limits}
        self._lock = threading.Lock()

    def acquire(self, category: str) -> None:
        limit = self._limits.get(category)
        if limit is None:
            return
        windows = [(1.0, limit.per_second), (60.0, limit.per_minute),
                   (3600.0, limit.per_hour), (86_400.0, limit.per_day)]
        while True:
            with self._lock:
                now = time.monotonic()
                hits = self._hits[category]
                # Evict anything older than the widest window we care about.
                widest = max(w for w, cap in windows if cap is not None)
                while hits and now - hits[0] > widest:
                    hits.popleft()

                wait = 0.0
                for window, cap in windows:
                    if cap is None:
                        continue
                    in_window = sum(1 for t in hits if now - t <= window)
                    if in_window >= cap:
                        oldest = next(t for t in hits if now - t <= window)
                        wait = max(wait, window - (now - oldest) + 0.001)
                if wait <= 0:
                    hits.append(now)
                    return
            time.sleep(min(wait, 1.0))


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class DhanError(RuntimeError):
    """A non-2xx from Dhan, with the body attached — Dhan's error detail lives
    in the response body, which urllib buries inside the exception."""

    def __init__(self, status: int, body: str, path: str) -> None:
        super().__init__(f"Dhan {status} on {path}: {body}")
        self.status = status
        self.body = body
        self.path = path


class DryRun(dict):
    """What a state-changing call returns when the client is in dry-run mode.

    A dict subclass so callers can treat it like a response, but truthy-checkable
    as `isinstance(resp, DryRun)` when a test needs to assert nothing was sent.
    """


@dataclass
class DhanClient:
    access_token: str = field(default_factory=lambda: os.environ.get("DHAN_ACCESS_TOKEN", ""))
    client_id: str = field(default_factory=lambda: os.environ.get("DHAN_CLIENT_ID", ""))
    base_url: str = BASE_URL
    dry_run: bool = True
    timeout: float = 15.0
    limiter: RateLimiter = field(default_factory=RateLimiter)

    def __post_init__(self) -> None:
        if not self.dry_run and os.environ.get("DHAN_ALLOW_LIVE_ORDERS") != "1":
            raise RuntimeError(
                "Refusing to leave dry-run: set DHAN_ALLOW_LIVE_ORDERS=1 as well as "
                "dry_run=False. Two switches, deliberately — see the module docstring."
            )
        if not self.dry_run and not (self.access_token and self.client_id):
            raise RuntimeError("DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID are required for live calls.")

    # -- transport ---------------------------------------------------------

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "access-token": self.access_token,
            "client-id": self.client_id,
        }

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | list[Any] | None = None,
        category: str = "non_trading",
        mutating: bool = False,
    ) -> Any:
        """One HTTP call. `mutating` marks calls that dry-run must intercept."""
        if mutating and self.dry_run:
            return DryRun({"dryRun": True, "method": method, "path": path, "body": body})

        self.limiter.acquire(category)
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            raise DhanError(exc.code, exc.read().decode("utf-8", "replace"), path) from None
        except urllib.error.URLError as exc:
            raise DhanError(0, str(exc.reason), path) from None

    # -- auth --------------------------------------------------------------

    @staticmethod
    def generate_access_token(client_id: str, pin: str, totp: str) -> dict[str, Any]:
        """Programmatic 24h token. Requires TOTP enabled on the Dhan account.

        Tokens have been capped at 24 hours since API v2.4 (Sep 2025), a SEBI
        algo-regulation consequence. An unattended algo cannot run on a
        hand-pasted token — this is the renewal path it needs.
        """
        payload = json.dumps({"client_id": client_id, "pin": pin, "totp": totp}).encode()
        req = urllib.request.Request(
            f"{AUTH_URL}/generateAccessToken",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            raise DhanError(exc.code, exc.read().decode("utf-8", "replace"), "/generateAccessToken")

    def renew_token(self) -> Any:
        return self.request("POST", "/RenewToken", category="non_trading")

    def set_static_ip(self, primary: str, secondary: str | None = None) -> Any:
        """Static IP whitelisting — MANDATORY for every order API since v2.4.

        Once set, an IP cannot be changed for 7 days. That lock means this
        cannot be sorted out at deploy time: ephemeral container IPs and
        autoscaling groups will break order placement. Resolve against
        infra/terraform/ (NAT gateway + Elastic IP, or an egress proxy) first.
        """
        body: dict[str, Any] = {"dhanClientId": self.client_id, "primaryIP": primary}
        if secondary:
            body["secondaryIP"] = secondary
        return self.request("POST", "/ip/setIP", body=body, mutating=True)


# ---------------------------------------------------------------------------
# Tier 2 — Conditional Trigger Orders (the one native rule engine)
# ---------------------------------------------------------------------------

@dataclass
class Condition:
    """The left/operator/right of a Conditional Trigger.

    Exactly ONE comparison. There is no AND/OR in this API — "RSI < 30 and price
    > EMA_200" is not expressible. That is a structural wall, not a gap to work
    around; compound logic means Tier 3.
    """

    comparison_type: str
    exchange_segment: str
    security_id: str
    operator: str
    time_frame: str = TimeFrame.DATE
    indicator_name: str | None = None
    comparing_indicator_name: str | None = None
    comparing_value: float | None = None
    frequency: str = "ONCE"
    exp_date: str | None = None
    user_note: str | None = None

    def validate(self) -> None:
        if self.exchange_segment not in CONDITIONAL_TRIGGER_SEGMENTS:
            raise ValueError(
                f"Conditional Triggers support {sorted(CONDITIONAL_TRIGGER_SEGMENTS)} only; "
                f"got {self.exchange_segment!r}. F&O strategies must run their rule loop "
                f"client-side against /orders."
            )
        if self.indicator_name and self.indicator_name not in ALL_INDICATORS:
            raise ValueError(f"Unknown indicator {self.indicator_name!r}")
        if self.comparing_indicator_name and self.comparing_indicator_name not in ALL_INDICATORS:
            raise ValueError(f"Unknown indicator {self.comparing_indicator_name!r}")
        if self.comparison_type == ComparisonType.TECHNICAL_WITH_INDICATOR:
            if not (self.indicator_name and self.comparing_indicator_name):
                raise ValueError("indicator-vs-indicator needs both indicator names")
        elif self.comparison_type in (
            ComparisonType.TECHNICAL_WITH_VALUE,
            ComparisonType.PRICE_WITH_VALUE,
        ):
            if self.comparing_value is None:
                raise ValueError(f"{self.comparison_type} needs comparingValue")

    def to_payload(self) -> dict[str, Any]:
        self.validate()
        body: dict[str, Any] = {
            "comparisonType": self.comparison_type,
            "exchangeSegment": self.exchange_segment,
            "securityId": self.security_id,
            "operator": self.operator,
            "timeFrame": self.time_frame,
            "frequency": self.frequency,
        }
        optional = {
            "indicatorName": self.indicator_name,
            "comparingIndicatorName": self.comparing_indicator_name,
            "comparingValue": self.comparing_value,
            "expDate": self.exp_date or (datetime.now() + timedelta(days=365)).strftime("%Y-%m-%d"),
            "userNote": self.user_note,
        }
        body.update({k: v for k, v in optional.items() if v is not None})
        return body


@dataclass
class TriggerOrder:
    """One order in a trigger's `orders` array. A single condition may fire
    several — that is what makes a trigger a strategy rather than an alert."""

    transaction_type: str
    order_type: str
    product_type: str
    quantity: int
    price: float = 0.0
    validity: str = Validity.DAY
    trigger_price: float | None = None
    disc_quantity: int | None = None

    def to_payload(self) -> dict[str, Any]:
        if self.order_type in (OrderType.STOP_LOSS, OrderType.STOP_LOSS_MARKET):
            if self.trigger_price is None:
                raise ValueError(f"{self.order_type} requires triggerPrice")
        if self.disc_quantity is not None and self.disc_quantity < self.quantity * 0.3:
            raise ValueError("disclosed quantity must be at least 30% of quantity")
        body: dict[str, Any] = {
            "transactionType": self.transaction_type,
            "orderType": self.order_type,
            "productType": self.product_type,
            "quantity": self.quantity,
            "validity": self.validity,
            "price": str(self.price),  # Dhan documents price as a string here
        }
        if self.trigger_price is not None:
            body["triggerPrice"] = self.trigger_price
        if self.disc_quantity is not None:
            body["discQuantity"] = self.disc_quantity
        return body


class ConditionalTriggers:
    """CRUD over /alerts/orders. Shipped in API v2.5 (Feb 09, 2026)."""

    def __init__(self, client: DhanClient) -> None:
        self.c = client

    def create(self, condition: Condition, orders: Sequence[TriggerOrder]) -> Any:
        if not orders:
            raise ValueError("a trigger with no orders is an alert, not a strategy")
        body = {
            "dhanClientId": self.c.client_id,
            "condition": condition.to_payload(),
            "orders": [o.to_payload() for o in orders],
        }
        return self.c.request("POST", "/alerts/orders", body=body, category="order", mutating=True)

    def modify(self, alert_id: str, condition: Condition, orders: Sequence[TriggerOrder]) -> Any:
        body = {
            "dhanClientId": self.c.client_id,
            "condition": condition.to_payload(),
            "orders": [o.to_payload() for o in orders],
        }
        return self.c.request(
            "PUT", f"/alerts/orders/{alert_id}", body=body, category="order", mutating=True
        )

    def cancel(self, alert_id: str) -> Any:
        return self.c.request(
            "DELETE", f"/alerts/orders/{alert_id}", category="order", mutating=True
        )

    def get(self, alert_id: str) -> Any:
        return self.c.request("GET", f"/alerts/orders/{alert_id}", category="non_trading")

    def list(self) -> Any:
        return self.c.request("GET", "/alerts/orders", category="non_trading")


# ---------------------------------------------------------------------------
# The strategy catalog — every archetype this vocabulary can express
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StrategySpec:
    key: str
    title: str
    summary: str
    build: Callable[..., Condition]
    default_side: str = TransactionType.BUY
    caveat: str = ""


def _cond(**kw: Any) -> Condition:
    return Condition(**kw)


def golden_cross(security_id: str, segment: str = ExchangeSegment.NSE_EQ, **kw: Any) -> Condition:
    """SMA_50 crossing up SMA_200, daily. The textbook long-term trend flip."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_INDICATOR,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.SMA_50, comparing_indicator_name=Indicator.SMA_200,
        operator=Operator.CROSSING_UP, time_frame=TimeFrame.DATE, **kw)


def death_cross(security_id: str, segment: str = ExchangeSegment.NSE_EQ, **kw: Any) -> Condition:
    """SMA_50 crossing down SMA_200, daily. The bearish mirror of the above."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_INDICATOR,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.SMA_50, comparing_indicator_name=Indicator.SMA_200,
        operator=Operator.CROSSING_DOWN, time_frame=TimeFrame.DATE, **kw)


def ema_cross(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
              fast: str = Indicator.EMA_20, slow: str = Indicator.EMA_50,
              time_frame: str = TimeFrame.DATE, **kw: Any) -> Condition:
    """Fast EMA crossing up slow EMA.

    The ONE archetype in this catalog we have our own evidence on: see
    `services/sentinel/scripts/backtest-ema-cross.ts` and the vault note
    "2026-07-24 - EMA-cross backtest engine". The bare rule was
    breakeven-to-losing on real Dhan candles; a fresh-cross filter flipped
    indices positive but not stocks. Dhan hosting the rule does not make it
    profitable — the marketplace's existence is not evidence, our backtest is.
    """
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_INDICATOR,
        exchange_segment=segment, security_id=security_id,
        indicator_name=fast, comparing_indicator_name=slow,
        operator=Operator.CROSSING_UP, time_frame=time_frame, **kw)


def price_reclaims_ma(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                      ma: str = Indicator.EMA_200, **kw: Any) -> Condition:
    """Close crossing up a moving average — the classic regime filter."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_CLOSE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=ma, operator=Operator.CROSSING_UP,
        time_frame=TimeFrame.DATE, **kw)


def rsi_oversold(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                 level: float = 30.0, time_frame: str = TimeFrame.FIFTEEN_MIN,
                 **kw: Any) -> Condition:
    """RSI_14 crossing up an oversold level. Mean-reversion entry."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_VALUE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.RSI_14, operator=Operator.CROSSING_UP,
        comparing_value=level, time_frame=time_frame, **kw)


def rsi_overbought(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                   level: float = 70.0, time_frame: str = TimeFrame.FIFTEEN_MIN,
                   **kw: Any) -> Condition:
    """RSI_14 crossing down an overbought level. Pairs with rsi_oversold as an exit."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_VALUE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.RSI_14, operator=Operator.CROSSING_DOWN,
        comparing_value=level, time_frame=time_frame, **kw)


def bollinger_breakout(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                       time_frame: str = TimeFrame.FIFTEEN_MIN, **kw: Any) -> Condition:
    """Close crossing up BB_UPPER — volatility expansion."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_CLOSE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.BB_UPPER, operator=Operator.CROSSING_UP,
        time_frame=time_frame, **kw)


def bollinger_reversion(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                        time_frame: str = TimeFrame.FIFTEEN_MIN, **kw: Any) -> Condition:
    """Close crossing down BB_LOWER — band fade."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_CLOSE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.BB_LOWER, operator=Operator.CROSSING_DOWN,
        time_frame=time_frame, **kw)


def macd_signal_cross(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                      time_frame: str = TimeFrame.DATE, **kw: Any) -> Condition:
    """MACD_12 crossing up MACD_26 — momentum turn."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_INDICATOR,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.MACD_12, comparing_indicator_name=Indicator.MACD_26,
        operator=Operator.CROSSING_UP, time_frame=time_frame, **kw)


def macd_histogram_flip(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                        time_frame: str = TimeFrame.DATE, **kw: Any) -> Condition:
    """MACD_HIST crossing up zero — the same turn, one bar earlier."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_VALUE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.MACD_HIST, operator=Operator.CROSSING_UP,
        comparing_value=0.0, time_frame=time_frame, **kw)


def stochrsi_turn(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                  level: float = 20.0, time_frame: str = TimeFrame.FIVE_MIN,
                  **kw: Any) -> Condition:
    """STOCHRSI_14 crossing up an oversold level — faster oscillator variant."""
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_VALUE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.STOCHRSI_14, operator=Operator.CROSSING_UP,
        comparing_value=level, time_frame=time_frame, **kw)


def volatility_gate(security_id: str, segment: str = ExchangeSegment.NSE_EQ,
                    atr_above: float = 0.0, time_frame: str = TimeFrame.DATE,
                    **kw: Any) -> Condition:
    """ATR_14 above a threshold.

    CAVEAT: with one comparison per trigger and no AND, this fires on volatility
    ALONE — it cannot gate a directional entry, which is the only thing you'd
    actually want it for. Included for completeness; in practice this archetype
    needs Tier 3.
    """
    return _cond(
        comparison_type=ComparisonType.TECHNICAL_WITH_VALUE,
        exchange_segment=segment, security_id=security_id,
        indicator_name=Indicator.ATR_14, operator=Operator.GREATER_THAN,
        comparing_value=atr_above, time_frame=time_frame, **kw)


def price_breakout(security_id: str, level: float, segment: str = ExchangeSegment.NSE_EQ,
                   time_frame: str = TimeFrame.FIVE_MIN, **kw: Any) -> Condition:
    """Price crossing up a hand-supplied level.

    The escape hatch: any level YOUR analysis produced — prior-day high, an ORB
    boundary, a supply zone — becomes a server-side trigger. Dhan does not
    compute the level; you do, then park it here.
    """
    return _cond(
        comparison_type=ComparisonType.PRICE_WITH_VALUE,
        exchange_segment=segment, security_id=security_id,
        operator=Operator.CROSSING_UP, comparing_value=level,
        time_frame=time_frame, **kw)


def index_driven_basket(index_security_id: str, level: float,
                        time_frame: str = TimeFrame.FIVE_MIN, **kw: Any) -> Condition:
    """Condition on an index, orders on equities.

    The condition instrument and the order instrument need not match — watch
    NIFTY, buy a basket of constituents. Underused and genuinely powerful.
    """
    return _cond(
        comparison_type=ComparisonType.PRICE_WITH_VALUE,
        exchange_segment=ExchangeSegment.IDX_I, security_id=index_security_id,
        operator=Operator.CROSSING_UP, comparing_value=level,
        time_frame=time_frame, **kw)


STRATEGY_CATALOG: dict[str, StrategySpec] = {
    s.key: s for s in [
        StrategySpec("golden-cross", "Golden Cross",
                     "SMA_50 crosses up SMA_200 (daily)", golden_cross),
        StrategySpec("death-cross", "Death Cross",
                     "SMA_50 crosses down SMA_200 (daily)", death_cross,
                     default_side=TransactionType.SELL),
        StrategySpec("ema-cross", "EMA Crossover",
                     "EMA_20 crosses up EMA_50", ema_cross,
                     caveat="Our own backtest rates the bare rule breakeven-to-losing."),
        StrategySpec("ma-reclaim", "Price Reclaims MA",
                     "Close crosses up EMA_200 (regime filter)", price_reclaims_ma),
        StrategySpec("rsi-oversold", "RSI Oversold Reversal",
                     "RSI_14 crosses up 30", rsi_oversold),
        StrategySpec("rsi-overbought", "RSI Overbought Exit",
                     "RSI_14 crosses down 70", rsi_overbought,
                     default_side=TransactionType.SELL),
        StrategySpec("bb-breakout", "Bollinger Breakout",
                     "Close crosses up BB_UPPER", bollinger_breakout),
        StrategySpec("bb-reversion", "Bollinger Mean Reversion",
                     "Close crosses down BB_LOWER", bollinger_reversion),
        StrategySpec("macd-cross", "MACD Signal Cross",
                     "MACD_12 crosses up MACD_26", macd_signal_cross),
        StrategySpec("macd-hist", "MACD Histogram Flip",
                     "MACD_HIST crosses up zero", macd_histogram_flip),
        StrategySpec("stochrsi-turn", "StochRSI Turn",
                     "STOCHRSI_14 crosses up 20", stochrsi_turn),
        StrategySpec("volatility-gate", "Volatility Gate",
                     "ATR_14 above a threshold", volatility_gate,
                     caveat="Fires on volatility alone - cannot gate direction (no AND)."),
        StrategySpec("price-breakout", "Price Breakout",
                     "Price crosses up a supplied level", price_breakout),
        StrategySpec("index-basket", "Index-Driven Basket",
                     "Index condition, equity orders", index_driven_basket),
    ]
}


# ---------------------------------------------------------------------------
# Tier 3 — execution primitives
# ---------------------------------------------------------------------------

class Orders:
    """Base order API. Where every F&O strategy has to live."""

    def __init__(self, client: DhanClient) -> None:
        self.c = client

    def place(
        self, *, transaction_type: str, exchange_segment: str, product_type: str,
        order_type: str, security_id: str, quantity: int, price: float = 0.0,
        validity: str = Validity.DAY, trigger_price: float | None = None,
        disclosed_quantity: int | None = None, correlation_id: str | None = None,
        after_market_order: bool | None = None, amo_time: str | None = None,
        bo_profit_value: float | None = None, bo_stop_loss_value: float | None = None,
    ) -> Any:
        body: dict[str, Any] = {
            "dhanClientId": self.c.client_id,
            "transactionType": transaction_type,
            "exchangeSegment": exchange_segment,
            "productType": product_type,
            "orderType": order_type,
            "validity": validity,
            "securityId": security_id,
            "quantity": quantity,
            "price": price,
        }
        # correlationId is your idempotency/tracing handle (max 30 chars). Use it
        # to tie a fill back to the strategy instance that caused it — it is
        # queryable via /orders/external/{correlation-id}.
        optional = {
            "correlationId": correlation_id[:30] if correlation_id else None,
            "triggerPrice": trigger_price,
            "disclosedQuantity": disclosed_quantity,
            "afterMarketOrder": after_market_order,
            "amoTime": amo_time,
            "boProfitValue": bo_profit_value,
            "boStopLossValue": bo_stop_loss_value,
        }
        body.update({k: v for k, v in optional.items() if v is not None})
        return self.c.request("POST", "/orders", body=body, category="order", mutating=True)

    def slice(self, **kwargs: Any) -> Any:
        """Split an order over the exchange freeze limit into legs.

        Non-optional for any index-options algo trading meaningful size — a
        single order past the freeze quantity is simply rejected.
        """
        body = {"dhanClientId": self.c.client_id, **kwargs}
        return self.c.request("POST", "/orders/slicing", body=body, category="order", mutating=True)

    def modify(self, order_id: str, *, order_type: str, validity: str = Validity.DAY,
               quantity: int | None = None, price: float | None = None,
               trigger_price: float | None = None, leg_name: str | None = None,
               disclosed_quantity: int | None = None) -> Any:
        body: dict[str, Any] = {
            "dhanClientId": self.c.client_id, "orderId": order_id,
            "orderType": order_type, "validity": validity,
        }
        optional = {"quantity": quantity, "price": price, "triggerPrice": trigger_price,
                    "legName": leg_name, "disclosedQuantity": disclosed_quantity}
        body.update({k: v for k, v in optional.items() if v is not None})
        return self.c.request(
            "PUT", f"/orders/{order_id}", body=body, category="order", mutating=True
        )

    def cancel(self, order_id: str) -> Any:
        return self.c.request("DELETE", f"/orders/{order_id}", category="order", mutating=True)

    def book(self) -> Any:
        """All orders for the day. Responses carry `algoId` — Dhan's read-only
        exchange algo attribution, NOT a strategy id you supply."""
        return self.c.request("GET", "/orders", category="non_trading")

    def by_id(self, order_id: str) -> Any:
        return self.c.request("GET", f"/orders/{order_id}", category="non_trading")

    def by_correlation(self, correlation_id: str) -> Any:
        return self.c.request(
            "GET", f"/orders/external/{correlation_id}", category="non_trading"
        )

    def trades(self, order_id: str | None = None) -> Any:
        path = f"/trades/{order_id}" if order_id else "/trades"
        return self.c.request("GET", path, category="non_trading")


class SuperOrders:
    """Entry + target + stop + trailing in one call.

    The most useful primitive for an algo, because exit management runs on
    Dhan's side after your process has moved on — a crashed strategy loop does
    not leave a naked position.
    """

    def __init__(self, client: DhanClient) -> None:
        self.c = client

    def place(self, *, transaction_type: str, exchange_segment: str, product_type: str,
              order_type: str, security_id: str, quantity: int, price: float,
              target_price: float, stop_loss_price: float, trailing_jump: float,
              correlation_id: str | None = None) -> Any:
        if order_type not in (OrderType.LIMIT, OrderType.MARKET):
            raise ValueError("Super Orders accept LIMIT or MARKET only")
        if product_type not in (ProductType.CNC, ProductType.INTRADAY,
                                ProductType.MARGIN, ProductType.MTF):
            raise ValueError("Super Orders accept CNC/INTRADAY/MARGIN/MTF only")
        body: dict[str, Any] = {
            "dhanClientId": self.c.client_id,
            "transactionType": transaction_type,
            "exchangeSegment": exchange_segment,
            "productType": product_type,
            "orderType": order_type,
            "securityId": security_id,
            "quantity": quantity,
            "price": price,
            "targetPrice": target_price,
            "stopLossPrice": stop_loss_price,
            "trailingJump": trailing_jump,
        }
        if correlation_id:
            body["correlationId"] = correlation_id[:30]
        return self.c.request("POST", "/super/orders", body=body, category="order", mutating=True)

    def modify(self, order_id: str, leg_name: str, **fields: Any) -> Any:
        """Modify one leg.

        Two rules that bite:
          * ENTRY_LEG is modifiable only while PENDING or PART_TRADED. Once
            TRADED, only targetPrice / stopLossPrice / trailingJump move.
          * trailingJump=0 CANCELS the trail. Omitting it is not "leave it
            alone" — a round-trip modify that drops the field silently disarms
            trailing. This helper therefore never invents a default for it.
        """
        if leg_name == LegName.STOP_LOSS and fields.get("trailingJump") == 0:
            print("[warn] trailingJump=0 cancels the trailing stop", file=sys.stderr)
        body = {"dhanClientId": self.c.client_id, "orderId": order_id,
                "legName": leg_name, **fields}
        return self.c.request(
            "PUT", f"/super/orders/{order_id}", body=body, category="order", mutating=True
        )

    def cancel_leg(self, order_id: str, leg_name: str) -> Any:
        """Cancelling the parent cancels all legs; a cancelled leg cannot be
        re-added. There is no undo here."""
        return self.c.request(
            "DELETE", f"/super/orders/{order_id}/{leg_name}", category="order", mutating=True
        )

    def book(self) -> Any:
        return self.c.request("GET", "/super/orders", category="non_trading")


class ForeverOrders:
    """GTT / OCO. The positional primitive: arm a level today, let it sit for
    weeks with no process running. CNC or MTF only — no intraday."""

    def __init__(self, client: DhanClient) -> None:
        self.c = client

    def place(self, *, order_flag: Literal["SINGLE", "OCO"], transaction_type: str,
              exchange_segment: str, product_type: str, order_type: str,
              security_id: str, quantity: int, price: float, trigger_price: float,
              validity: str = Validity.DAY, price1: float | None = None,
              trigger_price1: float | None = None, quantity1: int | None = None,
              disclosed_quantity: int | None = None,
              correlation_id: str | None = None) -> Any:
        if product_type not in (ProductType.CNC, ProductType.MTF):
            raise ValueError("Forever Orders accept CNC or MTF only (no intraday)")
        if order_flag == "OCO" and None in (price1, trigger_price1, quantity1):
            raise ValueError("OCO needs price1, triggerPrice1 and quantity1 for the second leg")
        body: dict[str, Any] = {
            "dhanClientId": self.c.client_id,
            "orderFlag": order_flag,
            "transactionType": transaction_type,
            "exchangeSegment": exchange_segment,
            "productType": product_type,
            "orderType": order_type,
            "validity": validity,
            "securityId": security_id,
            "quantity": quantity,
            "price": price,
            "triggerPrice": trigger_price,
        }
        optional = {"price1": price1, "triggerPrice1": trigger_price1,
                    "quantity1": quantity1, "disclosedQuantity": disclosed_quantity,
                    "correlationId": correlation_id[:30] if correlation_id else None}
        body.update({k: v for k, v in optional.items() if v is not None})
        return self.c.request("POST", "/forever/orders", body=body, category="order", mutating=True)

    def cancel(self, order_id: str) -> Any:
        return self.c.request(
            "DELETE", f"/forever/orders/{order_id}", category="order", mutating=True
        )

    def book(self) -> Any:
        return self.c.request("GET", "/forever/orders", category="non_trading")


class TradersControl:
    """Broker-side risk. Not optional for an unattended algo — this is the one
    circuit breaker that survives our process dying, which no in-app risk check
    can give you. Arm it before any live-capital run."""

    def __init__(self, client: DhanClient) -> None:
        self.c = client

    def kill_switch(self, activate: bool) -> Any:
        """Requires all positions closed and no pending orders before it will
        activate — it is a "stop starting", not a "flatten everything"."""
        status = "ACTIVATE" if activate else "DEACTIVATE"
        return self.c.request(
            "POST", f"/killswitch?killSwitchStatus={status}", category="order", mutating=True
        )

    def kill_switch_status(self) -> Any:
        return self.c.request("GET", "/killswitch", category="non_trading")

    def set_pnl_exit(self, *, profit_value: float, loss_value: float,
                     product_types: Iterable[str] = ("INTRADAY",),
                     enable_kill_switch: bool = True) -> Any:
        body = {
            "profitValue": profit_value,
            "lossValue": loss_value,
            "productType": list(product_types),
            "enableKillSwitch": enable_kill_switch,
        }
        return self.c.request("POST", "/pnlExit", body=body, category="order", mutating=True)

    def get_pnl_exit(self) -> Any:
        return self.c.request("GET", "/pnlExit", category="non_trading")

    def disable_pnl_exit(self) -> Any:
        return self.c.request("DELETE", "/pnlExit", category="order", mutating=True)


# ---------------------------------------------------------------------------
# Data — candles for building and validating strategies
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Candle:
    timestamp: int  # epoch SECONDS, UTC
    open: float
    high: float
    low: float
    close: float
    volume: int
    open_interest: int | None = None


class Charts:
    def __init__(self, client: DhanClient) -> None:
        self.c = client

    def candles(self, *, security_id: str, exchange_segment: str, instrument: str,
                from_date: str, to_date: str, interval: int | None = None,
                expiry_code: int | None = None, oi: bool = False) -> list[Candle]:
        """Daily when `interval` is None, intraday otherwise.

        Two gotchas worth more than the docs admit:
          * `toDate` is NON-INCLUSIVE.
          * The response is PARALLEL ARRAYS, not row objects — open[], high[],
            low[], close[], volume[], timestamp[], index-aligned. This method
            transposes them so callers never have to think about it.

        Documented lookback is generous; observed behaviour is not. Measured in
        this repo on 2026-07-27 (see services/market-data/scripts/
        live-feed-server.ts): /charts/historical returns roughly the same ~1 year
        for a 730- or 1825-day range, and /charts/intraday HTTP-errors past its
        window. Budget for the observed limits, not the published ones.
        """
        if interval is not None and interval not in CHART_INTERVALS:
            raise ValueError(f"interval must be one of {CHART_INTERVALS}, got {interval}")
        body: dict[str, Any] = {
            "securityId": security_id,
            "exchangeSegment": exchange_segment,
            "instrument": instrument,
            "fromDate": from_date,
            "toDate": to_date,
        }
        if oi:
            body["oi"] = True
        if expiry_code is not None:
            body["expiryCode"] = expiry_code
        path = "/charts/historical"
        if interval is not None:
            body["interval"] = interval
            path = "/charts/intraday"

        raw = self.c.request("POST", path, body=body, category="data")
        return self._transpose(raw)

    @staticmethod
    def _transpose(raw: dict[str, Any]) -> list[Candle]:
        ts = raw.get("timestamp") or []
        oi = raw.get("open_interest") or []
        out: list[Candle] = []
        for i, t in enumerate(ts):
            out.append(Candle(
                timestamp=int(t),
                open=float(raw["open"][i]), high=float(raw["high"][i]),
                low=float(raw["low"][i]), close=float(raw["close"][i]),
                volume=int(raw["volume"][i]) if raw.get("volume") else 0,
                open_interest=int(oi[i]) if i < len(oi) else None,
            ))
        return out


# ---------------------------------------------------------------------------
# A minimal backtest, for the one archetype we have repo evidence on
# ---------------------------------------------------------------------------

def ema(values: Sequence[float], period: int) -> list[float | None]:
    """Standard EMA, seeded with an SMA. Mirrors the `ema()` used by
    services/sentinel/scripts/backtest-ema-cross.ts so results are comparable."""
    if period <= 0:
        raise ValueError("period must be positive")
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    k = 2.0 / (period + 1)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


@dataclass
class BacktestResult:
    trades: int
    wins: int
    total_return_pct: float
    max_drawdown_pct: float

    @property
    def win_rate(self) -> float:
        return (self.wins / self.trades * 100) if self.trades else 0.0

    def __str__(self) -> str:
        return (f"trades={self.trades} win_rate={self.win_rate:.1f}% "
                f"return={self.total_return_pct:+.2f}% max_dd={self.max_drawdown_pct:.2f}%")


def backtest_ema_cross(candles: Sequence[Candle], fast: int = 20, slow: int = 50,
                       fresh_cross_bars: int | None = None) -> BacktestResult:
    """Long-only EMA cross: enter on fast>slow, exit on fast<slow.

    `fresh_cross_bars` reproduces the filter that, per the vault note
    "2026-07-24 - EMA-cross backtest engine", flipped indices positive but not
    stocks — only take a cross that happened within the last N bars, rather than
    any bar where fast simply sits above slow.

    Deliberately crude: no costs, no slippage, no position sizing. It exists to
    sanity-check a Conditional Trigger before you arm it, not to certify a
    strategy. Treat a positive number here as "not obviously broken", nothing more.
    """
    closes = [c.close for c in candles]
    f, s = ema(closes, fast), ema(closes, slow)

    in_pos = False
    entry = 0.0
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    trades = wins = 0
    bars_since_cross = 10**9

    for i in range(1, len(closes)):
        if None in (f[i], s[i], f[i - 1], s[i - 1]):
            continue
        crossed_up = f[i - 1] <= s[i - 1] and f[i] > s[i]
        crossed_down = f[i - 1] >= s[i - 1] and f[i] < s[i]
        bars_since_cross = 0 if crossed_up else bars_since_cross + 1

        if not in_pos and crossed_up:
            if fresh_cross_bars is None or bars_since_cross <= fresh_cross_bars:
                in_pos, entry = True, closes[i]
        elif in_pos and crossed_down:
            ret = (closes[i] - entry) / entry
            equity *= 1 + ret
            trades += 1
            wins += 1 if ret > 0 else 0
            peak = max(peak, equity)
            max_dd = max(max_dd, (peak - equity) / peak)
            in_pos = False

    return BacktestResult(trades, wins, (equity - 1) * 100, max_dd * 100)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _client_from_env(dry_run: bool = True) -> DhanClient:
    return DhanClient(dry_run=dry_run)


def _cmd_list(_: argparse.Namespace) -> int:
    print(f"{len(STRATEGY_CATALOG)} strategies expressible as native Dhan Conditional Triggers")
    print("(equities + indices only - F&O must run client-side against /orders)\n")
    width = max(len(k) for k in STRATEGY_CATALOG)
    for spec in STRATEGY_CATALOG.values():
        print(f"  {spec.key:<{width}}  {spec.summary}")
        if spec.caveat:
            print(f"  {'':<{width}}  ! {spec.caveat}")
    return 0


def _cmd_describe(args: argparse.Namespace) -> int:
    spec = STRATEGY_CATALOG.get(args.key)
    if not spec:
        print(f"unknown strategy {args.key!r}; try list-strategies", file=sys.stderr)
        return 1
    print(f"{spec.title}  [{spec.key}]\n  {spec.summary}")
    print(f"  default side: {spec.default_side}")
    if spec.caveat:
        print(f"  caveat: {spec.caveat}")
    print(f"\n{spec.build.__doc__ or ''}")
    return 0


def _cmd_preview(args: argparse.Namespace) -> int:
    """Build the exact payload a strategy would POST. Never sends anything."""
    spec = STRATEGY_CATALOG.get(args.key)
    if not spec:
        print(f"unknown strategy {args.key!r}", file=sys.stderr)
        return 1
    kwargs: dict[str, Any] = {"security_id": args.security_id, "segment": args.segment}
    if spec.key in ("price-breakout", "index-basket"):
        if args.level is None:
            print(f"{spec.key} requires --level", file=sys.stderr)
            return 1
        kwargs["level"] = args.level
    if spec.key == "index-basket":
        kwargs = {"index_security_id": args.security_id, "level": args.level}

    condition = spec.build(**kwargs)
    orders = [TriggerOrder(
        transaction_type=spec.default_side,
        order_type=OrderType.MARKET,
        product_type=args.product,
        quantity=args.qty,
    )]
    client = _client_from_env(dry_run=True)
    payload = ConditionalTriggers(client).create(condition, orders)
    print(json.dumps(payload, indent=2, default=str))
    return 0


def _cmd_triggers(_: argparse.Namespace) -> int:
    client = _client_from_env(dry_run=True)
    if not client.access_token:
        print("DHAN_ACCESS_TOKEN not set", file=sys.stderr)
        return 1
    print(json.dumps(ConditionalTriggers(client).list(), indent=2, default=str))
    return 0


def _cmd_backtest(args: argparse.Namespace) -> int:
    client = _client_from_env(dry_run=True)
    if not client.access_token:
        print("DHAN_ACCESS_TOKEN not set", file=sys.stderr)
        return 1
    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    candles = Charts(client).candles(
        security_id=args.security_id, exchange_segment=args.segment,
        instrument=args.instrument, from_date=from_date, to_date=to_date,
    )
    print(f"{len(candles)} daily candles {from_date} to {to_date} (toDate non-inclusive)")
    if len(candles) < args.slow * 2:
        print("not enough history to be meaningful", file=sys.stderr)
        return 1
    bare = backtest_ema_cross(candles, args.fast, args.slow)
    fresh = backtest_ema_cross(candles, args.fast, args.slow, fresh_cross_bars=3)
    print(f"  EMA{args.fast}/{args.slow} bare        : {bare}")
    print(f"  EMA{args.fast}/{args.slow} fresh-cross : {fresh}")
    print("\nNo costs, no slippage. A positive number means 'not obviously broken'.")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    # `describe` prints docstrings containing em-dashes, and a Windows console
    # defaults to cp1252 — which raises UnicodeEncodeError rather than degrading.
    # Degrade instead: the prose matters more than the glyph.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, OSError):
            pass

    p = argparse.ArgumentParser(
        prog="dhan_algo_strategies",
        description="Dhan algo-strategy surface: catalog, payload builder, backtest. "
                    "Dry-run by default - this tool does not place orders.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list-strategies", help="every natively expressible strategy").set_defaults(
        fn=_cmd_list)

    d = sub.add_parser("describe", help="detail one strategy")
    d.add_argument("key")
    d.set_defaults(fn=_cmd_describe)

    pv = sub.add_parser("preview", help="build the trigger payload without sending it")
    pv.add_argument("key")
    pv.add_argument("--security-id", required=True)
    pv.add_argument("--segment", default=ExchangeSegment.NSE_EQ)
    pv.add_argument("--product", default=ProductType.INTRADAY)
    pv.add_argument("--qty", type=int, default=1)
    pv.add_argument("--level", type=float, default=None)
    pv.set_defaults(fn=_cmd_preview)

    sub.add_parser("triggers", help="list live conditional triggers").set_defaults(
        fn=_cmd_triggers)

    bt = sub.add_parser("backtest", help="EMA-cross sanity check on real Dhan candles")
    bt.add_argument("--security-id", required=True)
    bt.add_argument("--segment", default=ExchangeSegment.NSE_EQ)
    bt.add_argument("--instrument", default="EQUITY")
    bt.add_argument("--days", type=int, default=365)
    bt.add_argument("--fast", type=int, default=20)
    bt.add_argument("--slow", type=int, default=50)
    bt.set_defaults(fn=_cmd_backtest)

    args = p.parse_args(argv)
    try:
        return int(args.fn(args))
    except DhanError as exc:
        print(f"[dhan] {exc}", file=sys.stderr)
        return 2
    except (ValueError, RuntimeError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
