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
    "ema",
    "ema_slope",
    "candle_body_vs_level",
    "reclaim",
    "pullback_depth",
    "vwap",
    "vwap_slope",
    "vwap_test_count",
    "atr",
    "session_clock",
    "level_detection",
    "level_age",
    "impulse_detection",
    "volatility_contraction",
    "zone_detection",
    "zone_scoring",
    "htf_alignment",
    "liquidity_pools",
    "displacement",
    "fair_value_gap",
    "structure_shift",
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
    #: Overrides the derived reason when "the evaluator lacks a primitive"
    #: understates the situation — some templates are waiting on a subsystem,
    #: not on a function.
    unavailable_note: str = ""

    @property
    def missing(self) -> list[str]:
        return sorted(self.requires - SUPPORTED_PRIMITIVES)

    @property
    def available(self) -> bool:
        return not self.missing

    @property
    def steps(self) -> list[str]:
        """What the strategy does, in order, in the definition's own words.

        Derived from the rules themselves rather than written separately, so a
        preview can never drift from what the engine will actually evaluate —
        a description maintained beside the rules eventually describes an
        older version of them. The frontend renders this list; it does not
        compose one, which is what keeps strategy knowledge out of React.
        """
        return [
            str(rule.get("description") or rule.get("name") or "")
            for rule in (self.rules.get("rules") or [])
        ]

    @property
    def mode(self) -> str:
        """How the setup may be applied, in words a user reads."""
        return "Long only" if self.direction == "long_only" else "Both directions"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "summary": self.summary,
            "direction": self.direction,
            # The preview the user reads before adopting. Empty for a template
            # that cannot be adopted, because there are no rules to describe.
            "steps": self.steps if self.available else [],
            "mode": self.mode,
            "available": self.available,
            "requires": sorted(self.requires),
            "missing": self.missing,
            "unavailableReason": (
                ""
                if self.available
                else self.unavailable_note
                or f"Needs {', '.join(self.missing)}, which the watch engine cannot evaluate yet."
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
        requires={"ema", "ema_slope", "candle_body_vs_level", "reclaim", "relative_volume"},
        rules={
            "timeframe": "5m",
            "levels": ["ema7"],
            "rules": [
                {
                    "id": "rule_trend",
                    "name": "price_above_ema7",
                    "condition": "price_above_ema7",
                    "mandatory": True,
                    "description": "Price is trading above the 7 EMA",
                },
                {
                    "id": "rule_ema_slope",
                    "name": "ema7_rising",
                    "condition": "ema7_rising",
                    "mandatory": True,
                    "description": "The 7 EMA is rising, so it can act as dynamic support",
                },
                {
                    "id": "rule_reclaim",
                    "name": "ema7_body_reclaim",
                    "condition": "ema7_body_reclaim",
                    "mandatory": True,
                    "description": "A candle BODY reaches the 7 EMA and closes back above it",
                },
                {
                    "id": "rule_follow_through",
                    "name": "reclaim_follow_through",
                    "condition": "reclaim_retest_or_consolidation",
                    "mandatory": True,
                    "description": "After the reclaim, price closes above the reclaim candle high",
                },
                {
                    "id": "rule_volume_confirm",
                    "name": "volume_confirm",
                    "condition": "volume_above_20_period_avg",
                    "mandatory": False,
                    "description": "The reclaim carries above-average volume",
                },
            ],
            # Long only: no short side is offered, because the setup has none.
            "entry": {"long": "after_reclaim_follow_through", "short": None},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    Template(
        id="ema_9_21_pullback",
        name="9/21 EMA Pullback",
        summary=(
            "Not a crossover. The cross is the least interesting moment: this looks for an "
            "established trend with 9 above 21 and both rising, a pullback into the pair, and "
            "then a close back above the 9 that shows the trend resuming."
        ),
        direction="both",
        requires={"ema", "ema_slope", "pullback_depth"},
        rules={
            "timeframe": "5m",
            "levels": ["ema9", "ema21"],
            "rules": [
                {
                    "id": "rule_alignment",
                    "name": "ema_9_21_bullish_alignment",
                    "condition": "ema_9_21_bullish_alignment",
                    "mandatory": True,
                    "description": "9 EMA above the 21 and rising — an established trend, not a fresh cross",
                },
                {
                    "id": "rule_pullback",
                    "name": "pullback_into_ema_zone",
                    "condition": "pullback_into_ema_zone",
                    "mandatory": True,
                    "description": "Price retraces from a swing high far enough to reach the 9/21 zone",
                },
                {
                    "id": "rule_continuation",
                    "name": "pullback_rejection_continuation",
                    "condition": "pullback_rejection_continuation",
                    "mandatory": True,
                    "description": "After the pullback low, price closes back above the 9 EMA",
                },
                {
                    "id": "rule_volume_confirm",
                    "name": "volume_confirm",
                    "condition": "volume_above_20_period_avg",
                    "mandatory": False,
                    "description": "The continuation carries above-average volume",
                },
            ],
            "entry": {"long": "after_pullback_continuation", "short": None},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    # The two VWAP templates share primitives and nothing else. One is a
    # continuation setup, the other a fade; a single merged "VWAP strategy"
    # would average a trend-follower with its opposite and report a number
    # that described neither. They stay separate, and so do their funnels.
    Template(
        id="vwap_bounce",
        name="VWAP Bounce / Rejection",
        summary=(
            "A continuation setup. VWAP is trending and price is on its side; price returns to "
            "VWAP, a body interacts with it, closes back onto the side it came from, and then "
            "carries beyond the test candle."
        ),
        direction="both",
        requires={"vwap", "vwap_slope", "vwap_test_count", "relative_volume"},
        rules={
            "timeframe": "5m",
            "levels": ["vwap"],
            "rules": [
                {
                    "id": "rule_vwap_trend",
                    "name": "vwap_trend_established",
                    "condition": "vwap_trend_established",
                    "mandatory": True,
                    "description": "VWAP is rising or falling and price is on the same side of it",
                },
                {
                    "id": "rule_vwap_interaction",
                    "name": "vwap_body_interaction",
                    "condition": "vwap_body_interaction",
                    "mandatory": True,
                    "description": "A candle BODY reaches VWAP — a wick touch is not the event",
                },
                {
                    "id": "rule_vwap_rejection",
                    "name": "vwap_rejection_reclaim",
                    "condition": "vwap_rejection_reclaim",
                    "mandatory": True,
                    "description": "Price closes back onto the side it approached VWAP from",
                },
                {
                    "id": "rule_vwap_continuation",
                    "name": "vwap_continuation",
                    "condition": "vwap_continuation",
                    "mandatory": True,
                    "description": "Price closes beyond the extreme of the VWAP-test candle",
                },
                {
                    "id": "rule_volume_confirm",
                    "name": "volume_confirm",
                    "condition": "volume_above_20_period_avg",
                    "mandatory": False,
                    "description": "The rejection carries above-average volume",
                },
            ],
            "entry": {"long": "after_vwap_rejection_continuation", "short": "after_vwap_rejection_continuation"},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    Template(
        id="vwap_reversion_eod",
        name="End-of-Day VWAP Mean Reversion",
        summary=(
            "A fade, not a continuation. Late in the session price is stretched at least 1.5 ATR "
            "from VWAP, stops extending, and returns to the level. Deviation is measured in ATR "
            "multiples so the same threshold means the same thing on an index and on an option."
        ),
        direction="both",
        requires={"vwap", "atr", "session_clock"},
        rules={
            "timeframe": "5m",
            "levels": ["vwap"],
            "rules": [
                {
                    "id": "rule_late_session",
                    "name": "late_session_window",
                    "condition": "late_session_window",
                    "mandatory": True,
                    "description": "The session is inside its final 90 minutes",
                },
                {
                    "id": "rule_extension",
                    "name": "vwap_extension_beyond_atr",
                    "condition": "vwap_extension_beyond_atr",
                    "mandatory": True,
                    "description": "Price has travelled at least 1.5 ATR away from VWAP",
                },
                {
                    "id": "rule_exhaustion",
                    "name": "vwap_exhaustion_reversal",
                    "condition": "vwap_exhaustion_reversal",
                    "mandatory": True,
                    "description": "After the extreme, a candle closes back toward VWAP",
                },
                {
                    "id": "rule_return",
                    "name": "vwap_return_to_level",
                    "condition": "vwap_return_to_level",
                    "mandatory": True,
                    "description": "Price reaches VWAP again",
                },
            ],
            "entry": {"long": "after_vwap_reversion_confirmed", "short": "after_vwap_reversion_confirmed"},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    Template(
        id="sr_flip",
        name="Support / Resistance Flip",
        summary=(
            "One level, four stages. A level the market has turned at more than once, and that "
            "has been around a while, breaks; price comes back to it from the other side; and it "
            "holds. Resistance becomes support, or support becomes resistance."
        ),
        direction="both",
        requires={"level_detection", "level_age", "close_beyond_level", "retest", "relative_volume"},
        rules={
            "timeframe": "15m",
            "levels": ["detected"],
            "rules": [
                {
                    "id": "rule_level",
                    "name": "established_level_present",
                    "condition": "established_level_present",
                    "mandatory": True,
                    "description": "A level with 2+ touches that has been in place at least 10 bars",
                },
                {
                    "id": "rule_break",
                    "name": "level_break_close",
                    "condition": "level_break_close",
                    "mandatory": True,
                    "description": "Price closes clear of that level",
                },
                {
                    "id": "rule_flip_retest",
                    "name": "level_flip_retest",
                    "condition": "level_flip_retest",
                    "mandatory": True,
                    "description": "Price returns to the level from the side it broke to",
                },
                {
                    "id": "rule_flip_holds",
                    "name": "level_flip_holds",
                    "condition": "level_flip_holds",
                    "mandatory": True,
                    "description": "The level holds in its new role instead of failing back through",
                },
                {
                    "id": "rule_volume_confirm",
                    "name": "volume_confirm",
                    "condition": "volume_above_20_period_avg",
                    "mandatory": False,
                    "description": "The break carried above-average volume",
                },
            ],
            "entry": {"long": "after_flip_holds", "short": "after_flip_holds"},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    Template(
        id="flag_pennant",
        name="Flag / Pennant Continuation",
        summary=(
            "A move that goes somewhere fast, a pause that goes nowhere, then a resumption. The "
            "pause is measured against the impulse that preceded it, not against a fixed number "
            "of points, and it may not give back more than half of the move."
        ),
        direction="both",
        requires={"impulse_detection", "volatility_contraction", "atr", "relative_volume"},
        rules={
            "timeframe": "5m",
            "levels": ["flag_high", "flag_low"],
            "rules": [
                {
                    "id": "rule_impulse",
                    "name": "impulse_leg",
                    "condition": "impulse_leg",
                    "mandatory": True,
                    "description": "A move of at least 2 ATR within 6 bars, mostly in one direction",
                },
                {
                    "id": "rule_contraction",
                    "name": "volatility_contraction",
                    "condition": "volatility_contraction",
                    "mandatory": True,
                    "description": "A pause inside half the impulse range that gives back at most half the move",
                },
                {
                    "id": "rule_breakout",
                    "name": "flag_breakout_continuation",
                    "condition": "flag_breakout_continuation",
                    "mandatory": True,
                    "description": "Price closes out of the pause in the impulse direction",
                },
                {
                    "id": "rule_volume_confirm",
                    "name": "volume_confirm",
                    "condition": "volume_above_20_period_avg",
                    "mandatory": False,
                    "description": "The breakout carries above-average volume",
                },
            ],
            "entry": {"long": "after_flag_breakout", "short": "after_flag_breakout"},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    Template(
        id="supply_demand_zone",
        name="Supply / Demand Zone",
        summary=(
            "An area price left in a hurry, described by how fresh it is, how hard price departed, "
            "and how tight it is. The zone keeps its identity across sweeps, so a return to it is "
            "a second visit rather than a brand-new discovery."
        ),
        direction="both",
        requires={"zone_detection", "zone_scoring", "htf_alignment", "atr"},
        rules={
            "timeframe": "5m",
            "levels": ["zone_top", "zone_bottom"],
            "rules": [
                {
                    "id": "rule_zone",
                    "name": "zone_present",
                    "condition": "zone_present",
                    "mandatory": True,
                    "description": "A base price departed from by at least 1.5 ATR",
                },
                {
                    "id": "rule_htf",
                    "name": "zone_htf_aligned",
                    "condition": "zone_htf_aligned",
                    "mandatory": False,
                    "description": "The higher timeframe is moving with the zone rather than against it",
                },
                {
                    "id": "rule_return",
                    "name": "price_returns_to_zone",
                    "condition": "price_returns_to_zone",
                    "mandatory": True,
                    "description": "Price comes back into the zone",
                },
                {
                    "id": "rule_reaction",
                    "name": "zone_reaction",
                    "condition": "zone_reaction",
                    "mandatory": True,
                    "description": "Price closes back out of the zone in the zone's direction",
                },
            ],
            "entry": {"long": "after_zone_reaction", "short": "after_zone_reaction"},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    Template(
        id="liquidity_sweep_fvg",
        name="Liquidity Sweep + Fair Value Gap",
        summary=(
            "Seven stages of one event: a pool of equal highs or lows is TAKEN rather than broken, "
            "price displaces away, structure shifts, the move leaves an unfilled imbalance, price "
            "returns into it, and then carries beyond the displacement."
        ),
        direction="both",
        requires={"liquidity_pools", "displacement", "fair_value_gap", "structure_shift", "atr"},
        rules={
            "timeframe": "5m",
            "levels": ["liquidity_pool", "fvg_top", "fvg_bottom"],
            "rules": [
                {
                    "id": "rule_sweep",
                    "name": "liquidity_pool_swept",
                    "condition": "liquidity_pool_swept",
                    "mandatory": True,
                    "description": "Price trades through a pool of equal highs or lows and closes back",
                },
                {
                    "id": "rule_displacement",
                    "name": "displacement_from_sweep",
                    "condition": "displacement_from_sweep",
                    "mandatory": True,
                    "description": "At least 1.5 ATR away from the sweep, in the direction it implies",
                },
                {
                    "id": "rule_structure",
                    "name": "structure_shift",
                    "condition": "structure_shift",
                    "mandatory": True,
                    "description": "The last opposing swing is taken out",
                },
                {
                    "id": "rule_fvg",
                    "name": "fair_value_gap_left",
                    "condition": "fair_value_gap_left",
                    "mandatory": True,
                    "description": "The displacement left a three-candle imbalance",
                },
                {
                    "id": "rule_retrace",
                    "name": "fvg_retrace",
                    "condition": "fvg_retrace",
                    "mandatory": True,
                    "description": "Price trades back into that gap",
                },
                {
                    "id": "rule_continuation",
                    "name": "liquidity_continuation",
                    "condition": "liquidity_continuation",
                    "mandatory": True,
                    "description": "Price closes beyond the displacement extreme",
                },
            ],
            "entry": {"long": "after_fvg_continuation", "short": "after_fvg_continuation"},
            "riskManagement": {"stopLoss": None, "targets": []},
        },
    ),
    # Not waiting on an indicator. This one needs a research and market-impact
    # pipeline — sourcing, verification, event extraction, entity and market
    # linking, expected versus actual reaction, persistence — which is a
    # subsystem with its own data model, not a function in the evaluator.
    # Listing it with a placeholder `news_feed` primitive would make it look
    # one afternoon away from working.
    Template(
        id="news_momentum",
        name="News Momentum",
        summary="A classified catalyst, the reaction it produces, and whether that reaction persists.",
        direction="both",
        requires={"news_feed", "news_classification", "reaction_persistence"},
        unavailable_note="Unavailable — requires News Research / Market Impact pipeline.",
    ),
]


def list_templates() -> list[dict]:
    return [template.to_dict() for template in CATALOGUE]


def get_template(template_id: str) -> Template | None:
    return next((t for t in CATALOGUE if t.id == template_id), None)
