"""Strategy-specific breakdowns of the user's own history.

Every evaluator records its characteristic measurement into the observation
metadata (pullback depth, level age, VWAP test ordinal, zone freshness, flag
tightness, liquidity stage). This module turns those into buckets.

Two rules govern everything here:

1. **A breakdown only exists if there are observations for it.** No dimension
   is offered with zero samples. Rendering an empty "shallow / normal / deep"
   split would invite the user to read three empty bars as three findings, and
   a dashboard that is mostly zeroes teaches people to ignore it.

2. **Nothing is compared across strategies and nothing is ranked.** These are
   counts of what happened in the user's own watches. A bucket with a higher
   count is not a better bucket, and no note here says otherwise.
"""

from dataclasses import asdict, dataclass, field

#: Where each dimension lives in observation metadata, and how a raw value
#: becomes a bucket label. Declared as data so a new evaluator becomes
#: available to the UI by recording its measurement, not by editing the UI.
_DIMENSIONS: dict[str, dict] = {
    "pullbackDepth": {
        "label": "Pullback depth",
        "key": "pullback",
        "field": "classification",
        "order": ["shallow", "normal", "deep"],
    },
    "levelAge": {
        "label": "Level age",
        "key": "flip",
        "field": "ageBars",
        "order": ["fresh", "established", "old"],
        # Bars, not minutes: the timeframe is the strategy's own.
        "bucket": lambda bars: "fresh" if bars < 20 else "established" if bars < 60 else "old",
    },
    "vwapTest": {
        "label": "VWAP test",
        "key": "vwap",
        "field": "testOrdinal",
        "order": ["first", "second", "repeated"],
    },
    "vwapDeviation": {
        "label": "VWAP deviation",
        "key": "vwap",
        "field": "deviationBucket",
        "order": ["under-0.5", "0.5-1", "1-2", "2+"],
    },
    "zoneFreshness": {
        "label": "Zone freshness",
        "key": "zone",
        "field": "touches",
        "order": ["untested", "second visit", "repeated"],
        "bucket": lambda touches: (
            "untested" if touches == 0 else "second visit" if touches == 1 else "repeated"
        ),
    },
    "flagTightness": {
        "label": "Flag tightness",
        "key": "flag",
        "field": "contractionRatio",
        "order": ["tight", "loose"],
        "bucket": lambda ratio: "tight" if ratio <= 0.3 else "loose",
    },
    "liquidityStage": {
        "label": "Stage reached",
        "key": "liquidity",
        "field": "stage",
        "order": [
            "pool",
            "sweep",
            "displacement",
            "structure shift",
            "FVG",
            "retrace",
            "continuation",
        ],
        "bucket": lambda stage: [
            "pool",
            "sweep",
            "displacement",
            "structure shift",
            "FVG",
            "retrace",
            "continuation",
        ][min(max(int(stage) - 1, 0), 6)],
    },
}


@dataclass
class Bucket:
    label: str
    observations: int = 0
    #: Watches that reached a confirmed state while in this bucket.
    confirmations: int = 0


@dataclass
class Segment:
    id: str
    label: str
    buckets: list[Bucket] = field(default_factory=list)
    #: Total observations behind the whole breakdown. The UI shows this so a
    #: split built on four samples never looks like a finding.
    samples: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def _value_of(observation: dict, dimension: dict):
    metadata = observation.get("metadata") or {}
    payload = metadata.get(dimension["key"])
    if not isinstance(payload, dict):
        return None
    return payload.get(dimension["field"])


def available_dimensions(observations: list[dict]) -> list[str]:
    """Which breakdowns this user's history can actually support.

    Derived from the observations themselves rather than from which template
    was adopted: a strategy adopted this morning that has not run yet has no
    analytics, and saying otherwise would promise a panel that renders empty.
    """
    found = []
    for dimension_id, dimension in _DIMENSIONS.items():
        if any(_value_of(o, dimension) is not None for o in observations):
            found.append(dimension_id)
    return found


def compute_segment(dimension_id: str, observations: list[dict]) -> Segment | None:
    """Bucket the user's observations along one dimension.

    Returns None when the dimension has no samples — the caller renders
    nothing rather than an empty chart.
    """
    dimension = _DIMENSIONS.get(dimension_id)
    if dimension is None:
        return None

    counts: dict[str, Bucket] = {
        label: Bucket(label=label) for label in dimension["order"]
    }
    samples = 0
    for observation in observations:
        value = _value_of(observation, dimension)
        if value is None:
            continue
        bucket_of = dimension.get("bucket")
        try:
            label = bucket_of(value) if bucket_of else str(value)
        except (TypeError, ValueError, IndexError):
            # A malformed measurement is dropped rather than filed under a
            # guessed bucket: an uncounted sample is honest, a miscounted one
            # is not.
            continue
        if label not in counts:
            continue
        counts[label].observations += 1
        samples += 1
        metadata = observation.get("metadata") or {}
        if metadata.get("mandatoryTotal") and metadata.get("mandatoryMet") == metadata.get(
            "mandatoryTotal"
        ):
            counts[label].confirmations += 1

    if samples == 0:
        return None

    return Segment(
        id=dimension_id,
        label=dimension["label"],
        buckets=list(counts.values()),
        samples=samples,
    )


def compute_segments(observations: list[dict]) -> list[dict]:
    segments = [compute_segment(d, observations) for d in available_dimensions(observations)]
    return [s.to_dict() for s in segments if s is not None]
