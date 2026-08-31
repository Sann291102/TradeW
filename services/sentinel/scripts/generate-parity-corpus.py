#!/usr/bin/env python3
"""Generate the cross-engine parity corpus.

Runs the REAL `services/sentinel-py` evaluator over deterministic candle
series and records, bar by bar, what every condition answered. The TypeScript
side then asserts it produces the identical answers
(`src/user-strategy/replay-parity.spec.ts`).

    cd services/sentinel-py && python3 ../sentinel/scripts/generate-parity-corpus.py

## Why a generated fixture instead of calling Python from the test

CI runs `vitest` with no Python toolchain, and a suite that silently skips when
an interpreter is missing is a suite that stops protecting anything. Committing
the corpus makes the parity claim a checked-in artefact: the fixture is
evidence produced by the Python engine, and the TypeScript test cannot pass by
agreeing with itself.

Regenerate whenever either engine's semantics change. A diff in this file is
the signal that a port drifted — which is exactly what it is for.

## What the corpus covers

Every series is evaluated at EVERY prefix length, not only at its end, so the
comparison is of *state transitions over time* rather than a single verdict.
That is what catches the interesting class of bug: a condition that eventually
agrees but confirms one bar early, which no end-state assertion would see.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sentinel-py"))

from app.market.feed import Candle  # noqa: E402
from app.watch.evaluator import evaluate  # noqa: E402
from app.watch.indicators import ema_of  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))

# The five conditions of `ema7_bullish_reclaim`, the v1 certified family.
RULES = [
    {"id": "rule_trend", "name": "price_above_ema7", "condition": "price_above_ema7", "mandatory": True},
    {"id": "rule_ema_slope", "name": "ema7_rising", "condition": "ema7_rising", "mandatory": True},
    {"id": "rule_reclaim", "name": "ema7_body_reclaim", "condition": "ema7_body_reclaim", "mandatory": True},
    {
        "id": "rule_follow_through",
        "name": "reclaim_follow_through",
        "condition": "reclaim_retest_or_consolidation",
        "mandatory": True,
    },
    {
        "id": "rule_volume_confirm",
        "name": "volume_confirm",
        "condition": "volume_above_20_period_avg",
        "mandatory": False,
    },
]


def bar(ts: datetime, o: float, h: float, l: float, c: float, v: float) -> Candle:
    return Candle(timestamp=ts, open=o, high=h, low=l, close=c, volume=v)


def walk(seed: int, n: int, start: float, drift: float, vol: float) -> list[Candle]:
    """A seeded random walk. Deterministic across runs and across machines —
    `random.Random(seed)` is specified behaviour, unlike hash ordering."""
    rng = random.Random(seed)
    t = datetime(2026, 8, 31, 9, 15, tzinfo=IST)
    out: list[Candle] = []
    price = start
    for _ in range(n):
        o = price
        move = rng.gauss(drift, vol)
        c = max(0.05, o + move)
        h = max(o, c) + abs(rng.gauss(0, vol * 0.4))
        l = min(o, c) - abs(rng.gauss(0, vol * 0.4))
        out.append(bar(t, o, h, l, c, round(abs(rng.gauss(10_000, 3_000)) + 500)))
        price = c
        t += timedelta(minutes=5)
    return out


def scripted(spec: list[tuple[float, float, float, float, float]]) -> list[Candle]:
    t = datetime(2026, 8, 31, 9, 15, tzinfo=IST)
    out: list[Candle] = []
    for o, h, l, c, v in spec:
        out.append(bar(t, o, h, l, c, v))
        t += timedelta(minutes=5)
    return out


def ramp(n: int, start: float, step: float, vol: float = 1.0) -> list[tuple[float, float, float, float, float]]:
    spec = []
    price = start
    for i in range(n):
        o = price
        c = price + step
        spec.append((o, max(o, c) + vol, min(o, c) - vol, c, 10_000.0))
        price = c
    return spec


def build_corpus() -> list[dict]:
    """Named series, each chosen to exercise a specific edge of the port."""
    series: list[dict] = []

    # Random walks: the broad net. Different drifts so some sessions trend up,
    # some down, some chop — each produces a different mix of reclaims.
    for seed, drift, note in (
        (1, 0.35, "uptrend — reclaims should confirm"),
        (2, -0.30, "downtrend — EMA-7 falling, trend condition should stay false"),
        (3, 0.0, "chop — the interesting case for reclaim multiplicity"),
        (4, 0.08, "slow grind up — slope near the ±0.25 ATR threshold"),
    ):
        series.append({"name": f"walk-seed{seed}", "note": note, "candles": walk(seed, 60, 24_000, drift, 12.0)})

    # ── Hand-built reclaim scenarios ───────────────────────────────────
    #
    # These are anchored to the ACTUAL EMA-7 value at the end of the ramp
    # rather than to a guessed price. The first draft used a fixed dip and
    # produced no reclaim at all — the EMA lags a steep ramp by more than the
    # dip was deep — so the series tested nothing while still passing parity,
    # because both engines agreed there was no reclaim. Deriving the bar from
    # the indicator is what makes the scenario the scenario.
    def reclaim_bar(base: list[tuple], *, high_extra: float, wick_only: bool) -> tuple:
        """Craft a bar against the EMA-7 the `base` ramp actually produces."""
        candles = scripted(base)
        ema = ema_of(candles, 7)[-1]
        if wick_only:
            # Body entirely ABOVE the EMA, only the wick pierces it. Must not
            # count as a reclaim — the distinction the family rests on.
            o = ema + 1.0
            c = ema + 1.6
            return (o, max(o, c) + 0.4, ema - 2.5, c, 12_000.0)
        # Body STRADDLES the EMA and closes above it: open below, close above.
        o = ema - 1.5
        c = ema + 1.2
        return (o, max(o, c) + high_extra, o - 0.6, c, 12_000.0)

    base = ramp(12, 100.0, 1.2)
    rb = reclaim_bar(base, high_extra=0.5, wick_only=False)
    spec = base + [rb]
    # A bar that closes above the reclaim candle's high — the follow-through.
    spec += [(rb[3], rb[1] + 2.0, rb[3] - 0.5, rb[1] + 1.5, 18_000.0)]
    spec += ramp(6, rb[1] + 1.5, 0.8)
    series.append({"name": "clean-reclaim", "note": "textbook reclaim then follow-through", "candles": scripted(spec)})

    # The same reclaim, but with a high nothing afterwards clears.
    base = ramp(12, 100.0, 1.2)
    rb = reclaim_bar(base, high_extra=8.0, wick_only=False)
    spec = base + [rb]
    for _ in range(4):
        spec.append((rb[3], rb[3] + 0.6, rb[3] - 0.6, rb[3] + 0.2, 9_000.0))
    series.append(
        {"name": "reclaim-no-followthrough", "note": "reclaim present, follow-through must stay false", "candles": scripted(spec)}
    )

    # Wick pierces the EMA, body does not.
    base = ramp(12, 100.0, 1.2)
    spec = base + [reclaim_bar(base, high_extra=0.4, wick_only=True)]
    spec += ramp(4, spec[-1][3], 0.6)
    series.append({"name": "wick-only-touch", "note": "wick pierces EMA, body does not — no reclaim", "candles": scripted(spec)})

    # Flat line: zero range, zero movement. Exercises the divide-by-zero paths
    # in slope scaling and ATR at once.
    series.append(
        {"name": "flat", "note": "no movement — slope scale and ATR degenerate", "candles": scripted([(100.0, 100.0, 100.0, 100.0, 5_000.0)] * 30)}
    )

    # Zero volume throughout: `_volume_above_average` must report unjudgeable
    # rather than false-by-arithmetic.
    spec = [(o, h, l, c, 0.0) for (o, h, l, c, _v) in ramp(30, 100.0, 0.5)]
    series.append({"name": "zero-volume", "note": "instrument reports no volume", "candles": scripted(spec)})

    # Exactly at the history boundaries: 7 bars (EMA-7 becomes computable),
    # 10 (slope), 21 (volume average). Prefix evaluation covers all of them,
    # but a short series makes the boundary explicit in the fixture.
    series.append({"name": "short-8", "note": "just past the EMA-7 boundary", "candles": scripted(ramp(8, 100.0, 1.0))})
    series.append({"name": "short-22", "note": "just past the volume-average boundary", "candles": scripted(ramp(22, 100.0, 1.0))})

    return series


def main() -> None:
    corpus = []
    for entry in build_corpus():
        candles: list[Candle] = entry["candles"]
        steps = []
        # Evaluate at every prefix. NOTE: `evaluate()` itself calls
        # `closed_candles()`, which drops the last element — so a prefix of
        # length N is evaluated on N-1 bars. The TypeScript harness feeds the
        # same prefix and applies the same policy, so the two stay aligned;
        # recording `bars` here as the prefix length keeps that visible.
        for n in range(2, len(candles) + 1):
            result = evaluate(RULES, candles[:n])
            steps.append(
                {
                    "bars": n,
                    "conditions": {
                        r.condition: {"met": bool(r.met), "detail": r.detail} for r in result.rules
                    },
                }
            )
        corpus.append(
            {
                "name": entry["name"],
                "note": entry["note"],
                "candles": [
                    {
                        "timestamp": c.timestamp.isoformat(),
                        "open": c.open,
                        "high": c.high,
                        "low": c.low,
                        "close": c.close,
                        "volume": c.volume,
                    }
                    for c in candles
                ],
                "steps": steps,
            }
        )

    out_path = os.path.join(os.path.dirname(__file__), "..", "src", "user-strategy", "parity-corpus.json")
    out_path = os.path.abspath(out_path)
    with open(out_path, "w") as fh:
        json.dump({"generatedBy": "services/sentinel/scripts/generate-parity-corpus.py", "series": corpus}, fh, indent=1)

    total = sum(len(s["steps"]) for s in corpus)
    print(f"wrote {out_path}")
    print(f"{len(corpus)} series, {total} evaluated bars, {total * len(RULES)} condition verdicts")


if __name__ == "__main__":
    main()
