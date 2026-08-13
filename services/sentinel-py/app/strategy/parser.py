"""Deterministic text strategy parser.

Regex + keyword matching only — no LLM. The same input text always produces
the same output, which matters here for two reasons: the user reviews and
confirms the parsed rules before they're saved (so a re-parse of an edited
strategy must not silently drift), and Sentinel's "we only watch what you
told us" guarantee depends on the extraction step being auditable.

Extends the keyword table from the Sentinel architecture plan (P1 scope).
"""

import re

from app.strategy.schemas import ParsedStrategy, StrategyEntry, StrategyRiskManagement, StrategyRule

_TIMEFRAME_RE = re.compile(
    r"first\s+(\d+)\s*-?\s*min(?:ute)?s?\s+(?:high|low)|(\d+)\s*-?\s*min(?:ute)?s?\s+orb",
    re.IGNORECASE,
)
_BREAKOUT_LONG_RE = re.compile(r"break(?:out)?\s+above\s+(?:the\s+)?high", re.IGNORECASE)
_BREAKOUT_SHORT_RE = re.compile(r"break(?:out)?\s+below\s+(?:the\s+)?low", re.IGNORECASE)
_RETEST_RE = re.compile(r"retest|pull ?back|come back to", re.IGNORECASE)
_LONG_ABOVE_RE = re.compile(r"long above|buy above", re.IGNORECASE)
_SHORT_BELOW_RE = re.compile(r"short below|sell below", re.IGNORECASE)
_STOP_LOSS_POINTS_RE = re.compile(r"stop\s*loss\s*(?:at)?\s*(\d+)\s*points?", re.IGNORECASE)
_STOP_LOSS_AT_LOW_RE = re.compile(r"(?:sl|stop\s*loss)\s*at\s*(?:the\s+)?low", re.IGNORECASE)
_STOP_LOSS_AT_HIGH_RE = re.compile(r"(?:sl|stop\s*loss)\s*at\s*(?:the\s+)?high", re.IGNORECASE)
_RR_TARGET_RE = re.compile(r"1\s*[:/]\s*(\d+)|target\s*(\d+)\s*r\b", re.IGNORECASE)
_VOLUME_RE = re.compile(r"volume", re.IGNORECASE)


def parse_strategy_text(text: str) -> tuple[ParsedStrategy, list[str]]:
    warnings: list[str] = []
    rules: list[StrategyRule] = []
    levels: list[str] = []
    entry = StrategyEntry()
    risk = StrategyRiskManagement()

    timeframe_match = _TIMEFRAME_RE.search(text)
    timeframe = None
    if timeframe_match:
        minutes = timeframe_match.group(1) or timeframe_match.group(2)
        timeframe = f"{minutes}m"
        levels = [f"{timeframe}_high", f"{timeframe}_low"]
    tf_label = timeframe or "reference"

    has_breakout_long = bool(_BREAKOUT_LONG_RE.search(text))
    has_breakout_short = bool(_BREAKOUT_SHORT_RE.search(text))
    if has_breakout_long:
        rules.append(
            StrategyRule(
                id="rule_breakout_high",
                name="breakout_high",
                condition=f"price_closes_above_{tf_label}_high",
                mandatory=True,
                description=f"Price must close above the {tf_label} high",
            )
        )
        entry.long = f"breakout_above_{tf_label}_high"
    if has_breakout_short:
        rules.append(
            StrategyRule(
                id="rule_breakout_low",
                name="breakout_low",
                condition=f"price_closes_below_{tf_label}_low",
                mandatory=True,
                description=f"Price must close below the {tf_label} low",
            )
        )
        entry.short = f"breakout_below_{tf_label}_low"

    if _RETEST_RE.search(text):
        rules.append(
            StrategyRule(
                id="rule_retest",
                name="retest",
                condition="price_retests_level_then_bounces",
                mandatory=True,
                description="Price retests the breakout level and bounces before entry",
            )
        )
        if entry.long:
            entry.long = f"after_retest_bounce_above_{tf_label}_high"
        if entry.short:
            entry.short = f"after_retest_bounce_below_{tf_label}_low"

    if _LONG_ABOVE_RE.search(text) and not entry.long:
        entry.long = f"price_above_{tf_label}_high"
    if _SHORT_BELOW_RE.search(text) and not entry.short:
        entry.short = f"price_below_{tf_label}_low"

    if _VOLUME_RE.search(text):
        rules.append(
            StrategyRule(
                id="rule_volume_confirm",
                name="volume_confirm",
                condition="volume_above_20_period_avg",
                mandatory=False,
                description="Volume should be above the 20-period average",
            )
        )

    points_match = _STOP_LOSS_POINTS_RE.search(text)
    if points_match:
        risk.stopLoss = f"{tf_label}_low_minus_{points_match.group(1)}_points"
    elif _STOP_LOSS_AT_LOW_RE.search(text):
        risk.stopLoss = f"{tf_label}_low"
    elif _STOP_LOSS_AT_HIGH_RE.search(text):
        risk.stopLoss = f"{tf_label}_high"

    rr_matches = _RR_TARGET_RE.findall(text)
    max_r = 0
    for group_pair in rr_matches:
        for value in group_pair:
            if value:
                max_r = max(max_r, int(value))
    if max_r:
        risk.targets = [f"{n}R" for n in range(1, max_r + 1)]

    if not rules:
        warnings.append(
            "No recognizable rules found — the strategy will be saved but has no mandatory conditions to watch for yet."
        )
    if not entry.long and not entry.short:
        warnings.append("No entry direction detected (expected phrases like 'long above high' or 'short below low').")

    parsed = ParsedStrategy(timeframe=timeframe, levels=levels, rules=rules, entry=entry, riskManagement=risk)
    return parsed, warnings
