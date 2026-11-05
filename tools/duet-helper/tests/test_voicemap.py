"""Pure voice-map tests; no UNMIXX, torch or network."""

from __future__ import annotations

import numpy as np
import pytest

from kara_duet.anchors import anchor_segment, parse_anchors, validate_anchor
from kara_duet.voicemap import (
    Anchor,
    Segment,
    Window,
    add_anchor,
    build_segments,
    classify,
    default_anchors,
    label_segments,
    render,
    stitch_streams,
    vocal_phrase_edges,
)


class FakeEmbedder:
    """Deterministic embeddings from the signal's mean sign/value."""

    def embed(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        del sample_rate
        value = float(np.mean(audio))
        if value >= 0:
            return np.array([1.0, 0.0, 0.0])
        return np.array([0.0, 1.0, 0.0])


def window(time: float, rms: tuple[float, float], f0: tuple[float | None, float | None]) -> Window:
    return Window(time=time, rms=rms, f0=f0)


def test_classify_none_solo_both_and_unison() -> None:
    assert classify(window(0, (0.0, 0.0), (None, None))) == ("none", None)
    assert classify(window(0, (0.1, 0.001), (180.0, None))) == ("solo", 0)
    assert classify(window(0, (0.001, 0.1), (None, 220.0))) == ("solo", 1)
    assert classify(window(0, (0.1, 0.1), (200.0, 400.0))) == ("both", None)
    assert classify(window(0, (0.1, 0.1), (300.0, 310.0))) == ("unison", None)


def test_build_segments_merges_phrases_and_splits_duet_order() -> None:
    windows = []
    for time in range(3):
        windows.append(window(float(time), (0.1, 0.001), (150.0, None)))
    for time in range(3, 5):
        windows.append(window(float(time), (0.1, 0.1), (200.0, 400.0)))
    for time in range(5, 7):
        windows.append(window(float(time), (0.1, 0.1), (410.0, 300.0)))
    windows.append(window(7.0, (0.0, 0.0), (None, None)))
    for time in range(8, 10):
        windows.append(window(float(time), (0.1, 0.1), (300.0, 310.0)))

    segments = build_segments(windows)
    assert [segment.kind for segment in segments] == [
        "solo",
        "both",
        "both",
        "none",
        "unison",
    ]
    assert segments[0].start == 0.0
    assert segments[0].end == 3.0
    assert segments[1].lower == 0
    assert segments[2].lower == 1
    assert segments[4].start == 8.0

    split = build_segments(windows, phrase_edges=[1.5])
    assert split[0].end == 1.0
    assert split[1].start == 1.0
    assert split[1].end == 3.0


def test_vocal_phrase_edges_finds_silence_joins() -> None:
    sample_rate = 8_000
    seconds = 5
    vocal = np.zeros(seconds * sample_rate, dtype=np.float32)
    tone = 0.5 * np.sin(2 * np.pi * 220 * np.arange(sample_rate) / sample_rate)
    vocal[sample_rate : 2 * sample_rate] = tone
    vocal[3 * sample_rate : 4 * sample_rate] = tone

    edges = vocal_phrase_edges(vocal, sample_rate)
    for expected in (1.0, 2.0, 3.0, 4.0):
        assert min(abs(edge - expected) for edge in edges) < 0.15


def test_stitch_streams_crossfades_the_overlap() -> None:
    frames = 48_000
    chunk = np.ones((2, 24_000), dtype=np.float32)
    streams = stitch_streams(
        [
            (0.0, chunk),
            (0.5, chunk * 2.0),
        ],
        frames,
    )
    assert streams[0][12_000] == pytest.approx(1.0)
    assert streams[0][18_000] == pytest.approx(1.5, abs=1e-3)
    assert streams[0][24_000] == pytest.approx(2.0)
    assert streams[0][30_000] == pytest.approx(2.0)
    assert streams[0][40_000] == pytest.approx(0.0)


def test_default_anchors_picks_two_distinct_registers() -> None:
    windows = []
    for time in range(30):
        if time < 10:
            windows.append(window(float(time), (0.1, 0.001), (150.0, None)))
        elif time >= 20:
            windows.append(window(float(time), (0.1, 0.001), (300.0, None)))
        else:
            windows.append(window(float(time), (0.0, 0.0), (None, None)))

    sample_rate = 8_000
    vocal = np.zeros(30 * sample_rate, dtype=np.float32)
    vocal[: 10 * sample_rate] = 1.0
    vocal[20 * sample_rate :] = -1.0
    segments = build_segments(windows)

    anchors = default_anchors(segments, vocal, sample_rate, FakeEmbedder(), windows=windows)

    assert [(anchor.voice, anchor.start, anchor.end) for anchor in anchors] == [
        (1, 3.0, 7.0),
        (2, 23.0, 27.0),
    ]


def test_label_segments_uses_anchor_identity() -> None:
    sample_rate = 8_000
    vocal = np.concatenate(
        [
            np.ones(4 * sample_rate, dtype=np.float32),
            -np.ones(4 * sample_rate, dtype=np.float32),
        ]
    )
    segments = [
        Segment(kind="solo", start=0.0, end=4.0, slot=0),
        Segment(kind="solo", start=4.0, end=8.0, slot=0),
    ]
    anchors = [
        Anchor(voice=1, start=0.0, end=1.0, embedding=np.array([1.0, 0.0, 0.0])),
        Anchor(voice=2, start=0.0, end=1.0, embedding=np.array([0.0, 1.0, 0.0])),
    ]

    label_segments(segments, anchors, vocal, sample_rate, FakeEmbedder())

    assert [segment.voice for segment in segments] == [1, 2]


def test_label_segments_assigns_the_duet_slots() -> None:
    sample_rate = 8_000
    vocal = np.ones(8 * sample_rate, dtype=np.float32)
    streams = [
        np.ones(8 * sample_rate, dtype=np.float32),
        -np.ones(8 * sample_rate, dtype=np.float32),
    ]
    segments = [Segment(kind="both", start=0.0, end=4.0, lower=0)]
    anchors = [
        Anchor(voice=1, start=0.0, end=1.0, embedding=np.array([1.0, 0.0, 0.0])),
        Anchor(voice=2, start=0.0, end=1.0, embedding=np.array([0.0, 1.0, 0.0])),
    ]

    label_segments(segments, anchors, vocal, sample_rate, FakeEmbedder(), streams)

    assert segments[0].voice1_slot == 0
    assert segments[0].reason == "anchor"


def test_add_anchor_appends_without_replacing_the_defaults() -> None:
    sample_rate = 8_000
    vocal = np.ones(10 * sample_rate, dtype=np.float32)
    anchors = [Anchor(voice=1, start=0.0, end=1.0, embedding=np.array([1.0, 0.0, 0.0]))]

    updated = add_anchor(anchors, 2, 2.0, 3.0, vocal, sample_rate, FakeEmbedder())

    assert len(updated) == 2
    assert updated[-1].voice == 2
    assert updated[-1].start == 2.0


def test_render_keeps_same_voice_joins_seamless() -> None:
    sample_rate = 8_000
    frames = 4 * sample_rate
    vocal = np.sin(2 * np.pi * 220 * np.arange(frames) / sample_rate).astype(np.float32)
    segments = [
        Segment(kind="solo", start=0.0, end=2.0, slot=0, voice=1),
        Segment(kind="solo", start=2.0, end=4.0, slot=0, voice=1),
    ]

    voice1, voice2 = render(segments, vocal, sample_rate, None, output_rate=sample_rate)

    assert np.allclose(
        voice1[2 * sample_rate : 2 * sample_rate + 64],
        vocal[2 * sample_rate : 2 * sample_rate + 64],
    )
    assert np.allclose(voice2, 0.0)


def test_render_routes_each_voice_and_unison() -> None:
    sample_rate = 8_000
    frames = 4 * sample_rate
    vocal = np.ones(frames, dtype=np.float32)
    streams = [np.ones(frames, dtype=np.float32), np.full(frames, 2.0, dtype=np.float32)]

    voice1, voice2 = render(
        [Segment(kind="both", start=0.0, end=2.0, lower=0, voice1_slot=0)],
        vocal,
        sample_rate,
        streams,
        output_rate=sample_rate,
    )
    assert voice1[15_000] == pytest.approx(1.0)
    assert voice2[15_000] == pytest.approx(2.0)

    voice1, voice2 = render(
        [Segment(kind="unison", start=0.0, end=4.0)],
        vocal,
        sample_rate,
        None,
        output_rate=sample_rate,
    )
    assert np.allclose(voice1[100:-100], vocal[100:-100])
    assert np.allclose(voice2[100:-100], vocal[100:-100])


def test_anchor_parsing_and_validation() -> None:
    assert parse_anchors(None) == []
    assert parse_anchors('[{"voice": 1, "start": 2, "end": 5}]') == [
        {"voice": 1, "start": 2.0, "end": 5.0}
    ]
    with pytest.raises(ValueError):
        parse_anchors('[{"voice": 3, "start": 2, "end": 5}]')

    long_raw = '[{"voice": 1, "start": 2, "end": 5, "note": "' + "x" * 300 + '"}]'
    assert parse_anchors(long_raw) == [{"voice": 1, "start": 2.0, "end": 5.0}]

    segments = [
        Segment(kind="both", start=0.0, end=3.0),
        Segment(kind="solo", start=3.0, end=8.0),
    ]
    assert anchor_segment(segments, 4.0) is segments[1]
    assert validate_anchor(segments, 1, 4.0, 5.0) is segments[1]
    with pytest.raises(ValueError):
        validate_anchor(segments, 1, 1.0, 2.0)
