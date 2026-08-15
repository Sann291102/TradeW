"""Adoptable strategy templates.

A template is a precise, named definition the user can ADOPT — at which
point it becomes their strategy, editable like any strategy they typed
themselves. Sentinel never adopts one on a user's behalf, never ranks them
against each other, and never nominates one. The catalogue is a menu, not a
recommendation.

## Why some are listed as unavailable

The watch engine can only evaluate conditions the evaluator implements
(app/watch/evaluator.py). Listing a template whose conditions would silently
never fire would be worse than not listing it: the user would adopt it, see
nothing happen, and have no way to tell whether the market was quiet or the
strategy was inert.

So every template declares the primitives it needs, availability is derived
from what the evaluator actually supports, and an unavailable one says which
primitive is missing. As primitives land, templates become adoptable with no
change here beyond the requirement list.
"""

from dataclasses import dataclass, field
from typing import Any

# Conditions app/watch/evaluator.py can currently decide. Anything a template
# needs beyond this set makes it unavailable rather than silently inert.
SUPPORTED_PRIMITIVES = {
    "opening_range",
    "close_beyond_level",
    "retest",
    "relative_volume",
}


@dataclass
class Template:
    id: str
    name: str
    summary: str
    # Long-only templates must never be presented as producing a short side.
    direction: str  # "both" | "long_only"
    requires: set[str]
    rules: dict[str, Any] = field(default_factory=dict)

    @property
    def missing(self) -> list[str]:
        return sorted(self.requires - SUPPORTED_PRIMITIVES)

    @property
    def available(self) -> bool:
        return not self.missing

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "summary": self.summary,
            "direction": self.direction,
            "available": self.available,
            "requires": sorted(self.requires),
            "missing": self.missing,
            "unavailableReason": (
                ""
                if self.available
                else f"Needs {', '.join(self.missing)}, which the watch engine cannot evaluate yet."
            ),
            "rules": self.rules if self.available else {},
        }


def _orb_rules(timeframe: str, with_retest: bool, with_volume: bool) -> dict:
    rules = [
        {
            "id": "rule_breakout_high",
            "name": "breakout_high",
            "condition": f"price_closes_above_{timeframe}_high",
            "mandatory": True,
            "description": f"Price closes above the {timeframe} opening-range high",
        },
        {
            "id": "rule_breakout_low",
            "name": "breakout_low",
            "condition": f"price_closes_below_{timeframe}_low",
            "mandatory": True,
            "description": f"Price closes below the {timeframe} opening-range low",
        },
    ]
    if with_retest:
        rules.append(
            {
                "id": "rule_retest",
                "name": "retest",
                "condition": "price_retests_level_then_bounces",
                "mandatory": True,
                "description": "Price returns to the broken level and closes back through it",
            }
        )
    if with_volume:
        rules.append(
            {
                "id": "rule_volume_confirm",
                "name": "volume_confirm",
                "condition": "volume_above_20_period_avg",
                "mandatory": False,
                "description": "Breakout carries above-average volume",
            }
        )
    return {
        "timeframe": timeframe,
        "levels": [f"{timeframe}_high", f"{timeframe}_low"],
        "rules": rules,
        "entry": {
            "long": f"after_retest_bounce_above_{timeframe}_high"
            if with_retest
            else f"breakout_above_{timeframe}_high",
            "short": f"after_retest_bounce_below_{timeframe}_low"
            if with_retest
            else f"breakout_below_{timeframe}_low",
        },
        "riskManagement": {"stopLoss": None, "targets": []},
    }


CATALOGUE: list[Template] = [
    Template(
        id="orb_15m_retest",
        name="15-Minute Opening Range Breakout + Retest",
        summary=(
            "The first 15 minutes set the range. Price must close beyond it, then return to the "
            "broken level and close back through before the setup counts as confirmed."
        ),
        direction="both",
        requires={"opening_range", "close_beyond_level", "retest", "relative_volume"},
        rules=_orb_rules("15m", with_retest=True, with_volume=True),
    ),
    Template(
        id="orb_30m",
        name="30-Minute Opening Range Breakout",
        summary=(
            "A slower opening range. The first 30 minutes set the levels; a close beyond one of "
            "them confirms, with volume as an optional corroboration."
        ),
        direction="both",
        requires={"opening_range", "close_beyond_level", "relative_volume"},
        rules=_orb_rules("30m", with_retest=False, with_volume=True),
    ),
    # --- Declared but not yet evaluable ------------------------------------
    # Each names the primitive it is waiting on rather than pretending to work.
    Template(
        id="ema7_bullish_reclaim",
        name="EMA-7 Bullish Reclaim",
        summary=(
            "Long only. In an uptrend with EMA-7 rising, price pulls back until a candle BODY "
            "interacts with the EMA and closes back above it. The reclaim alone is not the entry: "
            "the setup then waits for a retest or a consolidation breakout."
        ),
        direction="long_only",
        requires={"ema", "ema_slope", "candle_body_vs_level", "reclaim", "retest", "relative_volume"},
    ),
    Template(
        id="ema_9_21_pullback",
        name="9/21 EMA Pullback",
        summary="Trend with 9 above 21 and both rising, a pullback into the pair, then continuation.",
        direction="both",
        requires={"ema", "ema_slope", "pullback_depth"},
    ),
    Template(
        id="vwap_bounce",
        name="VWAP Bounce / Rejection",
        summary="Price returns to VWAP, rejects it, and continues in the prevailing direction.",
        direction="both",
        requires={"vwap", "vwap_slope", "vwap_test_count"},
    ),
    Template(
        id="vwap_reversion_eod",
        name="End-of-Day VWAP Mean Reversion",
        summary="An extreme, ATR-normalised deviation from VWAP late in the session, then reversion.",
        direction="both",
        requires={"vwap", "atr", "session_clock"},
    ),
    Template(
        id="sr_flip",
        name="Support / Resistance Flip",
        summary="A level breaks, is retested from the other side, and holds — resistance becomes support.",
        direction="both",
        requires={"level_detection", "level_age", "close_beyond_level", "retest", "relative_volume"},
    ),
    Template(
        id="flag_pennant",
        name="Flag / Pennant Continuation",
        summary="An impulse, then volatility contraction, then a breakout in the impulse direction.",
        direction="both",
        requires={"impulse_detection", "volatility_contraction", "atr"},
    ),
    Template(
        id="supply_demand_zone",
        name="Supply / Demand Zone",
        summary="A scored zone — freshness, departure strength, prior tests — reacting on a return.",
        direction="both",
        requires={"zone_detection", "zone_scoring", "htf_alignment"},
    ),
    Template(
        id="liquidity_sweep_fvg",
        name="Liquidity Sweep + Fair Value Gap",
        summary="A liquidity pool is swept, price displaces away, and retraces into the gap left behind.",
        direction="both",
        requires={"liquidity_pools", "displacement", "fair_value_gap", "structure_shift"},
    ),
    Template(
        id="news_momentum",
        name="News Momentum",
        summary="A classified catalyst, the reaction it produces, and whether that reaction persists.",
        direction="both",
        requires={"news_feed", "news_classification", "reaction_persistence"},
    ),
]


def list_templates() -> list[dict]:
    return [template.to_dict() for template in CATALOGUE]


def get_template(template_id: str) -> Template | None:
    return next((t for t in CATALOGUE if t.id == template_id), None)
