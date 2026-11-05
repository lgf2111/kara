"""Voice map and two-voice renderer for the duet helper.

The model separates simultaneous voices, but it does not keep a singer on the
same output across a song. This module turns the raw per-chunk streams into a
consistent pair of voices:

1. Measure energy and f0 for both streams once per second.
2. Split the song into `none`, `solo`, `both` and `unison` regions.
3. Put the first two long solo regions on Voice 1 and Voice 2 by default. The
   panel can replace or extend those anchors with a line the person knows.
4. Label every solo region against the anchor set, using the best-matching
   register. Only when that is weak does it fall back to pitch continuity with
   the neighbouring duet section.
5. Render solo regions from the untouched vocal stem, and duet regions from the
   separated streams, crossfading at the joins.

The map is deliberately a plain dataclass graph: it can be rebuilt and
re-rendered in seconds without running UNMIXX again.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .config import MODEL_SAMPLE_RATE, OUTPUT_SAMPLE_RATE
from .embeddings import Embedder

WINDOW_SECONDS = 1.0
MIN_RMS = 0.008
BOTH_RMS = 0.015
BOTH_GAP_HZ = 30.0
F0_SPLIT_HZ = 45.0
ANCHOR_MARGIN = 0.08
BOTH_MARGIN = 0.10


@dataclass
class Window:
    time: float
    rms: tuple[float, float]
    f0: tuple[float | None, float | None]


@dataclass
class Segment:
    kind: str  # none | solo | both | unison
    start: float
    end: float
    slot: int | None = None
    lower: int | None = None  # both: which slot has the lower f0
    voice: int | None = None  # solo: 1 or 2; unison: None
    voice1_slot: int | None = None  # both: which slot is Voice 1
    confidence: float = 0.0
    reason: str = ""


@dataclass
class Anchor:
    voice: int
    start: float
    end: float
    embedding: np.ndarray | None = None


def classify(window: Window) -> tuple[str, int | None]:
    if max(window.rms) < MIN_RMS:
        return "none", None
    if min(window.rms) > BOTH_RMS and window.f0[0] is not None and window.f0[1] is not None:
        if abs(window.f0[0] - window.f0[1]) > BOTH_GAP_HZ:
            return "both", None
        total = window.rms[0] ** 2 + window.rms[1] ** 2
        share = window.rms[0] ** 2 / total if total > 0 else 0.5
        # Two streams at the same pitch and comparable loudness are a unison
        # line, not two separable singers. Keep it shared rather than guessing
        # which side owns it.
        if 0.35 <= share <= 0.65:
            return "unison", None
    return "solo", 0 if window.rms[0] >= window.rms[1] else 1


def build_segments(
    windows: Sequence[Window], phrase_edges: Sequence[float] | None = None
) -> list[Segment]:
    regions: list[Segment] = []
    last_f0: dict[int, float | None] = {0: None, 1: None}
    for window in windows:
        kind, slot = classify(window)
        split = False
        if regions and regions[-1].kind == kind and regions[-1].slot == slot:
            previous = regions[-1]
            if kind == "solo":
                a = last_f0.get(slot)
                b = window.f0[slot]
                if a is not None and b is not None and abs(a - b) > F0_SPLIT_HZ:
                    split = True
                if window.time - previous.end > 1.5:
                    split = True
            if phrase_edges and any(
                previous.end <= edge < window.time + WINDOW_SECONDS for edge in phrase_edges
            ):
                split = True
        if split or not regions or regions[-1].kind != kind or regions[-1].slot != slot:
            regions.append(
                Segment(kind=kind, start=window.time, end=window.time + WINDOW_SECONDS, slot=slot)
            )
        else:
            regions[-1].end = window.time + WINDOW_SECONDS
        if kind == "solo":
            last_f0[slot] = window.f0[slot]

    # Split duet regions when the lower stream changes; this is where the
    # model's arbitrary output order flips.
    split: list[Segment] = []
    for region in regions:
        if region.kind != "both":
            split.append(region)
            continue
        current: Segment | None = None
        lower: int | None = None
        for window in windows:
            if not (region.start <= window.time < region.end):
                continue
            if window.f0[0] is None or window.f0[1] is None:
                next_lower = lower
            else:
                next_lower = 0 if window.f0[0] <= window.f0[1] else 1
            if current is None or next_lower == lower:
                if current is None:
                    current = Segment(
                        kind="both",
                        start=window.time,
                        end=window.time + WINDOW_SECONDS,
                        lower=next_lower,
                    )
                else:
                    current.end = window.time + WINDOW_SECONDS
                    current.lower = next_lower
                lower = next_lower
            else:
                split.append(current)
                current = Segment(
                    kind="both",
                    start=window.time,
                    end=window.time + WINDOW_SECONDS,
                    lower=next_lower,
                )
                lower = next_lower
        if current is not None:
            split.append(current)
    return split


def _median(values: Iterable[float | None]) -> float | None:
    clean = [value for value in values if value is not None]
    return float(np.median(clean)) if clean else None


def _window_f0(windows: Sequence[Window], start: float, end: float, slot: int) -> float | None:
    return _median(w.f0[slot] for w in windows if start <= w.time < end)


def _segment_f0(segment: Segment, windows: Sequence[Window]) -> float | None:
    if segment.slot is None:
        return None
    return _window_f0(windows, segment.start, segment.end, segment.slot)


def vocal_phrase_edges(vocal: np.ndarray, sample_rate: int) -> list[float]:
    """Silence-delimited phrase edges in the vocal stem.

    These are the joins the model does not see: a change of singer often
    happens at a breath, not at a pitch jump.
    """
    rms = librosa.feature.rms(y=vocal, frame_length=1024, hop_length=max(1, sample_rate // 50))[0]
    times = librosa.frames_to_time(
        np.arange(len(rms)), sr=sample_rate, hop_length=max(1, sample_rate // 50)
    )
    if len(rms) == 0:
        return []
    threshold = max(0.01, float(np.percentile(rms, 85)) * 0.12)
    voiced = rms > threshold
    edges: list[float] = []
    was_voiced = False
    for index, active in enumerate(voiced):
        if active != was_voiced:
            edges.append(float(times[index]))
            was_voiced = active
    return edges


def _longest_solo(segments: Sequence[Segment], minimum: float = 3.0) -> list[Segment]:
    return [s for s in segments if s.kind == "solo" and s.end - s.start >= minimum]


def default_anchors(
    segments: Sequence[Segment],
    vocal: np.ndarray,
    sample_rate: int,
    embedder: Embedder,
    count: int = 2,
    windows: Sequence[Window] | None = None,
) -> list[Anchor]:
    """The first two distinct solo lines, in order: Voice 1 then Voice 2."""
    # Use coarse regions for the anchors: the fine map splits at every breath,
    # and the first two short phrases are often the same singer.
    source = build_segments(windows, None) if windows is not None else segments
    solos = _longest_solo(source, minimum=6.0)
    if len(solos) < count:
        solos = _longest_solo(source, minimum=3.0)
    if len(solos) < count:
        raise ValueError("the song needs at least two solo lines to learn the voices")
    first = solos[0]
    first_f0 = _segment_f0(first, windows) if windows is not None else None
    second: Segment | None = None
    for candidate in solos[1:]:
        candidate_f0 = _segment_f0(candidate, windows) if windows is not None else None
        far = candidate.start - first.end > 10.0
        different = (
            first_f0 is not None
            and candidate_f0 is not None
            and abs(candidate_f0 - first_f0) > 50.0
        )
        if different or (first_f0 is None and far):
            second = candidate
            break
    if second is None:
        second = next(
            (candidate for candidate in solos[1:] if candidate.start - first.end > 1.5), solos[1]
        )
    selected = [first, second][:count]
    anchors: list[Anchor] = []
    for voice, segment in enumerate(selected, start=1):
        length = min(4.0, segment.end - segment.start)
        start = segment.start + max(0.0, (segment.end - segment.start - length) / 2)
        a = int(start * sample_rate)
        b = int((start + length) * sample_rate)
        anchors.append(
            Anchor(
                voice=voice,
                start=start,
                end=start + length,
                embedding=embedder.embed(vocal[a:b], sample_rate),
            )
        )
    return anchors


def add_anchor(
    anchors: Sequence[Anchor],
    voice: int,
    start: float,
    end: float,
    vocal: np.ndarray,
    sample_rate: int,
    embedder: Embedder,
) -> list[Anchor]:
    if voice not in (1, 2):
        raise ValueError("voice must be 1 or 2")
    if end <= start:
        raise ValueError("the anchor has no duration")
    start = max(0.0, min(start, len(vocal) / sample_rate - 0.1))
    end = min(len(vocal) / sample_rate, max(start + 0.1, end))
    a = int(start * sample_rate)
    b = int(end * sample_rate)
    fresh = Anchor(
        voice=voice,
        start=start,
        end=end,
        embedding=embedder.embed(vocal[a:b], sample_rate),
    )
    return [
        anchor
        for anchor in anchors
        if not (
            anchor.voice == voice
            and abs(anchor.start - start) < 0.5
            and abs(anchor.end - end) < 0.5
        )
    ] + [fresh]


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def _best_anchor(embedding: np.ndarray, anchors: Sequence[Anchor], voice: int) -> float:
    values = [
        _cosine(embedding, anchor.embedding)
        for anchor in anchors
        if anchor.voice == voice and anchor.embedding is not None
    ]
    return max(values) if values else -1.0


def _segment_audio(
    segment: Segment,
    vocal: np.ndarray,
    sample_rate: int,
    streams: Sequence[np.ndarray] | None,
) -> np.ndarray:
    start = segment.start + max(0.0, (segment.end - segment.start - 3.0) / 2)
    length = min(3.0, segment.end - segment.start)
    a = int(start * sample_rate)
    b = int((start + length) * sample_rate)
    if segment.kind == "solo":
        return vocal[a:b]
    if segment.kind == "both" and streams is not None and segment.lower is not None:
        slot = segment.lower
        return streams[slot][a:b]
    return vocal[a:b]


def label_segments(
    segments: Sequence[Segment],
    anchors: Sequence[Anchor],
    vocal: np.ndarray,
    sample_rate: int,
    embedder: Embedder,
    streams: Sequence[np.ndarray] | None = None,
    windows: Sequence[Window] | None = None,
) -> None:
    """Fill in `voice` for solos and `voice1_slot` for duets."""
    solo_scores: list[tuple[Segment, float, float, float]] = []
    for segment in segments:
        if segment.kind != "solo":
            continue
        audio = _segment_audio(segment, vocal, sample_rate, streams)
        e = embedder.embed(audio, sample_rate)
        s1 = _best_anchor(e, anchors, 1)
        s2 = _best_anchor(e, anchors, 2)
        solo_scores.append((segment, s1, s2, s2 - s1))

    # First pass: strong anchor matches.
    for segment, _s1, _s2, margin in solo_scores:
        if margin > ANCHOR_MARGIN:
            segment.voice = 2
            segment.confidence = min(1.0, margin)
            segment.reason = "anchor"
        elif margin < -ANCHOR_MARGIN / 2:
            segment.voice = 1
            segment.confidence = min(1.0, -margin)
            segment.reason = "anchor"
        else:
            segment.voice = None
            segment.confidence = abs(margin)
            segment.reason = "weak"

    # Second pass: short weak segments inherit a unanimous neighbourhood.
    ordered = [s for s in segments if s.kind == "solo"]
    for index, segment in enumerate(ordered):
        if segment.voice is not None and segment.confidence >= 0.30:
            continue
        previous = ordered[index - 1] if index > 0 else None
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        if (
            previous is not None
            and following is not None
            and previous.voice is not None
            and previous.voice == following.voice
            and segment.end - segment.start < 4.0
            and previous.end - segment.start < 12.0
            and following.start - segment.end < 12.0
        ):
            segment.voice = previous.voice
            segment.reason = "neighbour"
            continue
        if (
            previous is not None
            and previous.voice is not None
            and segment.end - segment.start < 3.0
            and 0.0 <= segment.start - previous.end < 6.0
            and (following is None or following.start - segment.end >= 6.0)
        ):
            segment.voice = previous.voice
            segment.reason = "neighbour-left"
            continue
        if (
            following is not None
            and following.voice is not None
            and segment.end - segment.start < 3.0
            and 0.0 <= following.start - segment.end < 6.0
            and (previous is None or segment.start - previous.end >= 6.0)
        ):
            segment.voice = following.voice
            segment.reason = "neighbour-right"

    # Third pass: the remaining weak lines use the nearest duet section's
    # pitch placement. This is the only place where register alone decides.
    for segment, _s1, _s2, margin in solo_scores:
        if segment.voice is not None:
            continue
        nearest = _nearest_both(segments, segment)
        f0 = _segment_f0(segment, windows) if windows is not None else None
        if (
            f0 is not None
            and nearest is not None
            and nearest.lower is not None
            and windows is not None
        ):
            lo = _window_f0(windows, nearest.start, nearest.end, nearest.lower)
            hi = _window_f0(windows, nearest.start, nearest.end, 1 - nearest.lower)
            if lo is not None and hi is not None:
                segment.voice = 1 if abs(f0 - lo) <= abs(f0 - hi) else 2
                segment.reason = "pitch"
                continue
        segment.voice = 1 if margin < 0.0 else 2
        segment.reason = "fallback"

    # Duet sections: score the two possible slot orders against the anchors.
    for segment in segments:
        if segment.kind != "both":
            continue
        if streams is None:
            segment.voice1_slot = 0
            segment.confidence = 0.0
            segment.reason = "default"
            continue
        center = segment.start + max(0.0, (segment.end - segment.start - 3.0) / 2)
        a = int(center * sample_rate)
        b = min(len(streams[0]), int((center + 3.0) * sample_rate))
        e0 = embedder.embed(streams[0][a:b], sample_rate)
        e1 = embedder.embed(streams[1][a:b], sample_rate)
        direct = _best_anchor(e0, anchors, 1) + _best_anchor(e1, anchors, 2)
        swapped = _best_anchor(e0, anchors, 2) + _best_anchor(e1, anchors, 1)
        if direct - swapped > BOTH_MARGIN:
            segment.voice1_slot = 0
            segment.confidence = min(1.0, direct - swapped)
            segment.reason = "anchor"
        elif swapped - direct > BOTH_MARGIN:
            segment.voice1_slot = 1
            segment.confidence = min(1.0, swapped - direct)
            segment.reason = "anchor"
        else:
            # Fall back to the lower stream as Voice 1; the panel can swap.
            segment.voice1_slot = segment.lower if segment.lower is not None else 0
            segment.confidence = max(0.0, abs(direct - swapped))
            segment.reason = "pitch"

    # Unison and none carry no voice; they are rendered as a shared line.
    for segment in segments:
        if segment.kind in ("none", "unison"):
            segment.voice = None
            segment.voice1_slot = None


def _nearest_both(segments: Sequence[Segment], segment: Segment) -> Segment | None:
    candidates = [s for s in segments if s.kind in ("both", "unison")]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda s: min(abs(s.start - segment.end), abs(segment.start - s.end)),
    )


def stitch_streams(
    chunks: Sequence[tuple[float, np.ndarray]], frames: int
) -> tuple[np.ndarray, np.ndarray]:
    """Crossfade the raw chunk outputs into two continuous streams."""
    streams = [np.zeros(frames, dtype=np.float32), np.zeros(frames, dtype=np.float32)]
    previous_end = 0
    for index, (start_seconds, estimate) in enumerate(chunks):
        start = int(round(start_seconds * MODEL_SAMPLE_RATE))
        end = min(frames, start + estimate.shape[1])
        if end <= start:
            continue
        fade = min(
            int(1.0 * MODEL_SAMPLE_RATE),
            max(0, previous_end - start),
            end - start,
        )
        for slot in range(2):
            piece = estimate[slot, : end - start]
            if index > 0 and fade > 0:
                ramp = np.linspace(0, 1, fade, dtype=np.float32)
                streams[slot][start : start + fade] = (
                    streams[slot][start : start + fade] * (1 - ramp) + piece[:fade] * ramp
                )
                streams[slot][start + fade : end] = piece[fade:]
            else:
                streams[slot][start:end] = piece
        previous_end = end
    return streams[0], streams[1]


def render(
    segments: Sequence[Segment],
    vocal: np.ndarray,
    sample_rate: int,
    streams: Sequence[np.ndarray] | None,
    output_rate: int = OUTPUT_SAMPLE_RATE,
) -> tuple[np.ndarray, np.ndarray]:
    """Render the two voices as mono arrays at `output_rate`.

    The fine map has many one-second segments. Fading every segment would put
    a dip on every second, so the fades are only at joins where the source or
    the voice actually changes.
    """
    if sample_rate != output_rate:
        vocal = librosa.resample(vocal, orig_sr=sample_rate, target_sr=output_rate)
    if streams is not None:
        streams = [
            librosa.resample(stream, orig_sr=sample_rate, target_sr=output_rate)
            if sample_rate != output_rate
            else stream
            for stream in streams
        ]
    length = len(vocal)
    v1 = np.zeros(length, dtype=np.float32)
    v2 = np.zeros(length, dtype=np.float32)
    fade = max(1, int(0.008 * output_rate))

    # (segment, route, targets) for every segment that writes audio. The route
    # is what must stay the same for the join to be seamless.
    active: list[tuple[Segment, tuple, list[np.ndarray]]] = []
    for segment in segments:
        a = max(0, int(segment.start * output_rate))
        b = min(length, int(segment.end * output_rate))
        if b <= a:
            continue
        if segment.kind == "solo" and segment.voice in (1, 2):
            target = v1 if segment.voice == 1 else v2
            active.append((segment, ("vocal", segment.voice), [target]))
        elif segment.kind == "both" and streams is not None and segment.voice1_slot is not None:
            active.append((segment, ("both", segment.voice1_slot), [v1, v2]))
        elif segment.kind == "unison":
            active.append((segment, ("unison",), [v1, v2]))

    for index, (segment, route, targets) in enumerate(active):
        a = max(0, int(segment.start * output_rate))
        b = min(length, int(segment.end * output_rate))
        if b <= a:
            continue
        if segment.kind == "solo" and segment.voice in (1, 2):
            source = vocal[a:b]
            for target in targets:
                target[a:b] = source
        elif segment.kind == "both" and streams is not None and segment.voice1_slot is not None:
            source1 = streams[segment.voice1_slot][a:b]
            source2 = streams[1 - segment.voice1_slot][a:b]
            v1[a:b] = source1
            v2[a:b] = source2
        elif segment.kind == "unison":
            for target in targets:
                target[a:b] = vocal[a:b]

        previous_segment = active[index - 1][0] if index > 0 else None
        following_segment = active[index + 1][0] if index + 1 < len(active) else None
        previous = (
            active[index - 1][1]
            if previous_segment is not None and previous_segment.end >= segment.start - 0.05
            else None
        )
        following = (
            active[index + 1][1]
            if following_segment is not None and following_segment.start <= segment.end + 0.05
            else None
        )
        if previous != route:
            width = min(fade, b - a)
            if width > 0:
                ramp = np.linspace(0, 1, width, dtype=np.float32)
                for target in targets:
                    target[a : a + width] *= ramp
        if following != route:
            width = min(fade, b - a)
            if width > 0:
                ramp = np.linspace(1, 0, width, dtype=np.float32)
                for target in targets:
                    target[b - width : b] *= ramp

    return v1, v2


def save_wav(path: Path, voice: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    stereo = np.stack([voice, voice], axis=0)
    sf.write(path, stereo.T, sample_rate)


def measure_windows(
    streams: Sequence[np.ndarray],
    total_seconds: float,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[Window]:
    """One energy/f0 row per second, for both continuous streams."""
    windows: list[Window] = []
    total = int(total_seconds)
    for second in range(total):
        a = int(second * MODEL_SAMPLE_RATE)
        b = int((second + 1) * MODEL_SAMPLE_RATE)
        rms: list[float] = []
        f0s: list[float | None] = []
        for slot in range(2):
            piece = streams[slot][a:b]
            if len(piece) < b - a:
                piece = np.pad(piece, (0, b - a - len(piece)))
            rms.append(float(np.sqrt(np.mean(piece**2))))
            if rms[-1] < 0.004:
                f0s.append(None)
                continue
            f0, voiced, _ = librosa.pyin(
                piece,
                fmin=65,
                fmax=800,
                sr=MODEL_SAMPLE_RATE,
                frame_length=2048,
                hop_length=512,
            )
            values = f0[voiced & np.isfinite(f0)]
            f0s.append(float(np.median(values)) if len(values) else None)
        windows.append(Window(time=float(second), rms=(rms[0], rms[1]), f0=(f0s[0], f0s[1])))
        if on_progress is not None:
            on_progress(second + 1, total)
    return windows
