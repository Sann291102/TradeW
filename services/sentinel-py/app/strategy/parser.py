"""Deterministic text strategy parser.

Regex + keyword matching only — no LLM. The same input text always produces
the same output, which matters here for two reasons: the user reviews and
confirms the parsed rules before they're saved (so a re-parse of an edited
strategy must not silently drift), and Sentinel's "we only watch what you
told us" guarantee depends on the extraction step being auditable.

## Two rules the whole file is built around

**Never invent.** A direction, a stop, a target or a condition the user did
not express is not extracted, not defaulted and not implied. A strategy that
watches for something its author never asked for is worse than one that
watches for too little: the user cannot audit what they cannot see, and they
would be alerted on a setup that is not theirs.

**Never silently drop.** The earlier version matched
"first 15 min high" but not "first 15 min CANDLE high", and quietly returned
a rule set containing neither the opening range nor the breakout — the user
saw a plausible two-rule strategy and no indication that most of their
sentence had been ignored. So every phrase this parser recognises is
recorded as a consumed span, and whatever meaningful words are left over are
reported back. Understanding half a strategy and saying so is honest;
understanding half and presenting it as the whole is not.
"""

import re

from app.strategy.schemas import ParsedStrategy, StrategyEntry, StrategyRiskManagement, StrategyRule

# --- vocabulary --------------------------------------------------------------
#
# Each pattern below is written to survive the filler words people actually
# type — "candle", "the", "then", hyphens, "min"/"minute"/"m" — because the
# failure mode being fixed here is a pattern that only matched one phrasing.

#: "first 15 min high", "first 15-minute candle high/low", "15 min opening range",
#: "15m ORB", "first 15 minutes".
_RANGE_WITH_DURATION_RE = re.compile(
    r"""(?:
        (?:first|opening|initial)\s+(?P<a>\d+)\s*-?\s*(?:min(?:ute)?s?|m)\b
      | (?P<b>\d+)\s*-?\s*(?:min(?:ute)?s?|m)\s+(?:opening\s+range|orb|range)
    )""",
    re.IGNORECASE | re.VERBOSE,
)

#: An opening range named without a duration: "ORB", "opening range",
#: "morning range". Recognised so the concept is not lost, but the duration is
#: then reported as missing rather than guessed at.
_RANGE_NO_DURATION_RE = re.compile(r"\borb\b|\bopening\s+range\b|\bmorning\s+range\b", re.IGNORECASE)

#: The range's boundaries, however they are referred to.
_RANGE_BOUNDS_RE = re.compile(r"\bhigh\s*(?:/|\s+and\s+|\s+)?\s*low\b|\blow\s*(?:/|\s+and\s+)\s*high\b", re.IGNORECASE)

_BREAKOUT_ABOVE_RE = re.compile(
    r"break(?:s|out|ing)?\s+(?:out\s+)?(?:above|over)\s+(?:the\s+)?(?:\w+\s+){0,3}?high", re.IGNORECASE
)
_BREAKOUT_BELOW_RE = re.compile(
    r"break(?:s|out|ing)?\s+(?:out\s+)?(?:below|under)\s+(?:the\s+)?(?:\w+\s+){0,3}?low", re.IGNORECASE
)
#: Directionless: "breakout", "break the morning range". The range has two
#: sides and the user named neither, so both boundaries are watched and the
#: entry direction is left unset rather than chosen for them.
_BREAKOUT_ANY_RE = re.compile(r"\bbreak(?:s|out|outs|ing)?\b", re.IGNORECASE)

_RETEST_RE = re.compile(r"\bre-?tests?\b|\bpull\s?backs?\b|\bcomes?\s+back\s+to\b|\bthrowback\b", re.IGNORECASE)

_LONG_ABOVE_RE = re.compile(r"\b(?:long|buy)\s+(?:above|over)\b", re.IGNORECASE)
_SHORT_BELOW_RE = re.compile(r"\b(?:short|sell)\s+(?:below|under)\b", re.IGNORECASE)

_VOLUME_RE = re.compile(r"\bvolumes?\b|\brvol\b", re.IGNORECASE)
#: "with volume confirmation", "volume must be", "only if volume" — wording
#: that makes the volume check a requirement rather than a nice-to-have.
_VOLUME_REQUIRED_RE = re.compile(
    r"\b(?:must|required?|only\s+if|needs?\s+to)\b[^.]{0,30}\bvolumes?\b"
    r"|\bvolumes?\b[^.]{0,30}\b(?:must|required?|confirmation)\b",
    re.IGNORECASE,
)

_STOP_LOSS_POINTS_RE = re.compile(r"(?:sl|stop\s*loss)\s*(?:at|of)?\s*(\d+)\s*points?", re.IGNORECASE)
_STOP_LOSS_AT_LOW_RE = re.compile(r"(?:sl|stop\s*loss)\s*(?:at|below)\s*(?:the\s+)?low", re.IGNORECASE)
_STOP_LOSS_AT_HIGH_RE = re.compile(r"(?:sl|stop\s*loss)\s*(?:at|above)\s*(?:the\s+)?high", re.IGNORECASE)
#: "1:2", "target 1:2 risk reward", "target 3R". The trailing wording is part
#: of the match so it is not later reported as text the parser ignored.
_RR_TARGET_RE = re.compile(
    r"(?:targets?\s+)?1\s*[:/]\s*(\d+)(?:\s*(?:risk[\s-]*reward|rr))?"
    r"|targets?\s+(\d+)\s*r\b",
    re.IGNORECASE,
)

#: Words that carry no strategy meaning, so their being unconsumed says
#: nothing. Kept deliberately small: over-filling this list is how a parser
#: starts claiming to understand text it ignored.
_FILLER = {
    "a", "an", "and", "the", "then", "with", "of", "on", "in", "at", "to", "for", "it", "is", "be",
    "my", "i", "we", "when", "if", "after", "before", "that", "this", "there", "wait", "waits",
    "waiting", "candle", "candles", "price", "prices", "market", "trade", "trades", "setup",
    "entry", "enter", "confirmation", "confirmed", "confirm", "confirms", "above", "below", "over",
    "under", "min", "mins", "minute", "minutes", "m", "first", "second", "next", "using", "use",
    "strategy", "range", "level", "levels", "side", "sides", "both", "either", "or", "but", "not",
}


def _consume(spans: list[tuple[int, int]], pattern: re.Pattern, text: str) -> bool:
    """Record every span `pattern` matches, and say whether it matched.

    The spans are what makes the leftover report possible: a word the parser
    never covered is a word it did not understand.
    """
    found = False
    for match in pattern.finditer(text):
        spans.append(match.span())
        found = True
    return found


def _leftover_words(text: str, spans: list[tuple[int, int]]) -> list[str]:
    covered = bytearray(len(text))
    for start, end in spans:
        for i in range(start, min(end, len(text))):
            covered[i] = 1

    words: list[str] = []
    for match in re.finditer(r"[A-Za-z][A-Za-z0-9/_-]*", text):
        start, end = match.span()
        if any(covered[i] for i in range(start, end)):
            continue
        word = match.group().lower()
        if word in _FILLER or len(word) < 3:
            continue
        if word not in words:
            words.append(word)
    return words


def parse_strategy_text(text: str) -> tuple[ParsedStrategy, list[str]]:
    warnings: list[str] = []
    rules: list[StrategyRule] = []
    levels: list[str] = []
    entry = StrategyEntry()
    risk = StrategyRiskManagement()
    spans: list[tuple[int, int]] = []

    # --- opening range ------------------------------------------------------
    timeframe: str | None = None
    range_match = _RANGE_WITH_DURATION_RE.search(text)
    has_range = False
    if range_match:
        spans.append(range_match.span())
        minutes = range_match.group("a") or range_match.group("b")
        timeframe = f"{minutes}m"
        has_range = True
    elif _consume(spans, _RANGE_NO_DURATION_RE, text):
        has_range = True
        # Named but not measured. A 15-minute default is the common convention
        # and precisely the kind of guess this parser must not make: the user
        # would be watching a range they never specified.
        warnings.append(
            "Opening range mentioned without a duration — say e.g. '15 minute opening range' "
            "so Sentinel watches the range you mean."
        )

    _consume(spans, _RANGE_BOUNDS_RE, text)
    label = timeframe or "opening_range"
    if has_range:
        levels = [f"{label}_high", f"{label}_low"]
        rules.append(
            StrategyRule(
                id="rule_opening_range",
                name="opening_range",
                condition="opening_range_established",
                # Context, not a condition of the setup. It is shown in the
                # checklist because the user asked for a range and should see
                # when it exists — but counting it as mandatory would put every
                # watch into FORMING at 09:30 each day merely because the
                # market opened, which is not a setup developing.
                mandatory=False,
                description=(
                    f"The {timeframe} opening range is established"
                    if timeframe
                    else "The opening range is established"
                ),
            )
        )

    # --- breakout -----------------------------------------------------------
    above = _consume(spans, _BREAKOUT_ABOVE_RE, text)
    below = _consume(spans, _BREAKOUT_BELOW_RE, text)
    directionless = _consume(spans, _BREAKOUT_ANY_RE, text)

    if above:
        rules.append(
            StrategyRule(
                id="rule_breakout_high",
                name="breakout_high",
                condition=f"price_closes_above_{label}_high",
                mandatory=True,
                description=f"Price closes above the {label} high",
            )
        )
        entry.long = f"breakout_above_{label}_high"
    if below:
        rules.append(
            StrategyRule(
                id="rule_breakout_low",
                name="breakout_low",
                condition=f"price_closes_below_{label}_low",
                mandatory=True,
                description=f"Price closes below the {label} low",
            )
        )
        entry.short = f"breakout_below_{label}_low"

    if directionless and not above and not below:
        if has_range:
            # A range breakout with no side named. Both boundaries are watched
            # because a range has two of them — but no entry direction is set,
            # because the user did not choose one and Sentinel will not.
            for side, comparison in (("high", "above"), ("low", "below")):
                rules.append(
                    StrategyRule(
                        id=f"rule_breakout_{side}",
                        name=f"breakout_{side}",
                        condition=f"price_closes_{comparison}_{label}_{side}",
                        mandatory=True,
                        description=f"Price closes {comparison} the {label} {side}",
                    )
                )
            warnings.append(
                "Breakout direction not stated — both sides of the range are watched, and no "
                "entry direction was assumed."
            )
        else:
            warnings.append(
                "A breakout is mentioned, but not of what — name the level or range "
                "(e.g. 'breaks above the first 15 minute high')."
            )

    # --- retest -------------------------------------------------------------
    if _consume(spans, _RETEST_RE, text):
        rules.append(
            StrategyRule(
                id="rule_retest",
                name="retest",
                condition="price_retests_level_then_bounces",
                mandatory=True,
                description="Price returns to the broken level and closes back through it",
            )
        )
        if entry.long:
            entry.long = f"after_retest_bounce_above_{label}_high"
        if entry.short:
            entry.short = f"after_retest_bounce_below_{label}_low"

    # --- explicit direction -------------------------------------------------
    if _consume(spans, _LONG_ABOVE_RE, text) and not entry.long:
        entry.long = f"price_above_{label}_high"
    if _consume(spans, _SHORT_BELOW_RE, text) and not entry.short:
        entry.short = f"price_below_{label}_low"

    # --- volume -------------------------------------------------------------
    required = _consume(spans, _VOLUME_REQUIRED_RE, text)
    if _consume(spans, _VOLUME_RE, text) or required:
        rules.append(
            StrategyRule(
                id="rule_volume_confirm",
                name="volume_confirm",
                condition="volume_above_20_period_avg",
                # Mandatory only when the user's own wording made it a
                # requirement. "with volume" is a corroboration; "only if
                # volume confirms" is a condition.
                mandatory=required,
                description=(
                    "Volume must be above the 20-period average"
                    if required
                    else "Volume above the 20-period average corroborates the move"
                ),
            )
        )

    # --- risk, all of it the user's own numbers -----------------------------
    points_match = _STOP_LOSS_POINTS_RE.search(text)
    if points_match:
        spans.append(points_match.span())
        risk.stopLoss = f"{label}_low_minus_{points_match.group(1)}_points"
    elif _consume(spans, _STOP_LOSS_AT_LOW_RE, text):
        risk.stopLoss = f"{label}_low"
    elif _consume(spans, _STOP_LOSS_AT_HIGH_RE, text):
        risk.stopLoss = f"{label}_high"

    max_r = 0
    for match in _RR_TARGET_RE.finditer(text):
        spans.append(match.span())
        for value in match.groups():
            if value:
                max_r = max(max_r, int(value))
    if max_r:
        risk.targets = [f"{n}R" for n in range(1, max_r + 1)]

    # --- what was not understood -------------------------------------------
    if not rules:
        warnings.append(
            "No recognizable rules found — the strategy will be saved but has no mandatory "
            "conditions to watch for yet."
        )
    if not entry.long and not entry.short:
        warnings.append(
            "No entry direction detected (expected phrases like 'long above high' or "
            "'short below low')."
        )

    leftover = _leftover_words(text, spans)
    if leftover:
        # The honesty clause. These words were read and not understood, and the
        # user is told so BEFORE saving, rather than discovering later that
        # Sentinel was watching for less than they described.
        warnings.append(
            "Not understood, so not watched for: " + ", ".join(f"'{w}'" for w in leftover) + "."
        )

    parsed = ParsedStrategy(timeframe=timeframe, levels=levels, rules=rules, entry=entry, riskManagement=risk)
    return parsed, warnings
