"""Vocabulary guard for anything sentinel-py sends to a user.

TradeW's product constitution (docs/handbook/00-front-matter.md ARCH-4,
26-decision-records.md, root CLAUDE.md Rule 2) forbids Buy/Sell/Entry/
Target/Stop language on every surface, naming notifications explicitly. It
is a SEBI compliance posture, not a style preference.

services/sentinel (TS) enforces this with a rewriting vocabulary layer
(src/vocabulary/vocabulary.ts). This is the sentinel-py equivalent, and it
REJECTS rather than rewrites: sentinel-py composes its own short strings
from a fixed set of templates, so a banned term here means a template is
wrong and should fail loudly in tests, not be silently laundered into
different words at runtime.
"""

import re

BANNED = [
    (re.compile(r"\bbuy\b", re.I), "buy"),
    (re.compile(r"\bsell\b", re.I), "sell"),
    (re.compile(r"\bstop[- ]?loss\b", re.I), "stop-loss"),
    (re.compile(r"\btargets?\b", re.I), "target"),
    (re.compile(r"\bgo (?:long|short)\b", re.I), "go long/short"),
    (re.compile(r"\benter (?:a |the )?(?:trade|position)\b", re.I), "enter a trade"),
    (re.compile(r"\bexit (?:your )?position\b", re.I), "exit position"),
    (re.compile(r"\b(?:i|we)\s+recommend\b", re.I), "recommend"),
    (re.compile(r"\brecommends?\b", re.I), "recommend"),
    (re.compile(r"\badvice\b", re.I), "advice"),
    (re.compile(r"\bbook (?:your )?profits?\b", re.I), "book profits"),
    (re.compile(r"\bcut (?:your )?loss(?:es)?\b", re.I), "cut losses"),
]

# Fields that must never appear in a notification payload. A notification
# arrives stripped of the page that explains it — a price to enter at and a
# price to stop at IS a trade alert, whatever the surrounding words say.
FORBIDDEN_METADATA_KEYS = {
    "entryprice",
    "entry",
    "stoploss",
    "stop",
    "stopprice",
    "target",
    "targetprice",
    "targets",
    "side",
    "bias",
    "recommendation",
}


class ComplianceError(ValueError):
    pass


def assert_clean_text(*texts: str) -> None:
    for text in texts:
        for pattern, label in BANNED:
            if pattern.search(text):
                raise ComplianceError(
                    f"notification text contains forbidden term '{label}' "
                    f"(ARCH-4: no Buy/Sell/Entry/Target/Stop language in notifications): {text!r}"
                )


def assert_clean_metadata(metadata: dict) -> None:
    for key in metadata:
        if key.lower() in FORBIDDEN_METADATA_KEYS:
            raise ComplianceError(
                f"notification metadata carries forbidden key '{key}' — "
                "entry/stop/target levels belong on the page where the evidence sits beside them"
            )


def assert_compliant(title: str, body: str, metadata: dict) -> None:
    assert_clean_text(title, body)
    assert_clean_metadata(metadata)
