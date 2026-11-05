"""Calibration anchors: parsing, lookup and the solo-line guard."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from .voicemap import Segment

AnchorSpec = dict[str, float | int]


def parse_anchors(raw: str | None) -> list[AnchorSpec]:
    """Read a JSON list from a string or a file path.

    The bridge writes a file; the CLI accepts either. A missing value is an
    empty list rather than an error, because anchors are optional.
    """
    if raw is None or raw.strip() == "":
        return []
    path = Path(raw)
    try:
        is_file = path.is_file()
    except OSError:
        # A long JSON string can exceed the platform's filename limit; it is
        # still a string, not a path.
        is_file = False
    text = path.read_text() if is_file else raw
    value = json.loads(text)
    if not isinstance(value, list):
        raise ValueError("anchors must be a list")
    anchors: list[AnchorSpec] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("each anchor must be an object")
        voice = int(item.get("voice", 0))
        start = float(item.get("start", -1))
        end = float(item.get("end", -1))
        if voice not in (1, 2) or start < 0 or end <= start:
            raise ValueError("anchors need voice 1/2 and a positive time range")
        anchors.append({"voice": voice, "start": start, "end": end})
    return anchors


def anchor_segment(segments: Sequence[Segment], middle: float) -> Segment | None:
    """The segment containing a moment, or None between segments."""
    for segment in segments:
        if segment.start <= middle < segment.end:
            return segment
    return None


def validate_anchor(
    segments: Sequence[Segment],
    voice: int,
    start: float,
    end: float,
) -> Segment:
    """Reject a calibration that does not land on a solo line."""
    if voice not in (1, 2):
        raise ValueError("voice must be 1 or 2")
    if end <= start:
        raise ValueError("the anchor has no duration")
    segment = anchor_segment(segments, (start + end) / 2)
    if segment is None or segment.kind != "solo":
        raise ValueError("choose a moment where only one singer is singing")
    return segment
