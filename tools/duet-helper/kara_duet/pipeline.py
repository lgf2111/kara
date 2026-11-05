"""Run UNMIXX once, then build and render the calibrated voice map."""

from __future__ import annotations

import json
import os

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import torchaudio

from . import voicemap
from .anchors import parse_anchors, validate_anchor
from .config import MODEL_SAMPLE_RATE, OUTPUT_SAMPLE_RATE
from .embeddings import Embedder
from .runner import (
    choose_device,
    install_mps_pool_fallback,
    load_audio,
    load_model,
    separate_chunk,
)


def load_vocal_44(path: Path) -> np.ndarray:
    waveform, sample_rate = torchaudio.load(str(path))
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != OUTPUT_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, sample_rate, OUTPUT_SAMPLE_RATE)
    return waveform.squeeze(0).numpy()


def separate_and_save(
    input_path: Path,
    output_dir: Path,
    unmixx_dir: Path,
    device: torch.device,
    chunk_seconds: float,
    overlap_seconds: float,
) -> dict:
    """Run the model and write one WAV per stream per chunk."""
    chunks_dir = output_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    waveform = load_audio(input_path)
    frames = waveform.shape[-1]
    chunk = int(round(chunk_seconds * MODEL_SAMPLE_RATE))
    overlap = int(round(overlap_seconds * MODEL_SAMPLE_RATE))
    hop = chunk - overlap
    total = max(1, (max(0, frames - overlap) + hop - 1) // hop)
    print(json.dumps({"stage": "loading", "device": str(device)}), flush=True)
    model = load_model(unmixx_dir, device)
    meta = {"totalFrames": frames, "chunk": chunk, "overlap": overlap, "chunks": []}
    started = time.monotonic()

    for index in range(total):
        start = index * hop
        if start >= frames:
            break
        end = min(frames, start + chunk)
        piece = waveform[:, start:end]
        valid = piece.shape[-1]
        if valid < chunk:
            piece = F.pad(piece, (0, chunk - valid))
        estimate = separate_chunk(model, piece, device)[:, :valid].numpy()
        for slot in range(2):
            sf.write(
                chunks_dir / f"chunk_{index:03d}_{slot}.wav",
                estimate[slot],
                MODEL_SAMPLE_RATE,
            )
        meta["chunks"].append(
            {
                "index": index,
                "start": start,
                "valid": valid,
                "rms": [float(np.sqrt(np.mean(estimate[slot] ** 2))) for slot in range(2)],
            }
        )
        print(
            json.dumps(
                {
                    "stage": "chunk",
                    "done": index + 1,
                    "total": total,
                    "elapsedSeconds": round(time.monotonic() - started, 1),
                }
            ),
            flush=True,
        )
        if device.type == "mps":
            torch.mps.empty_cache()

    (chunks_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    return meta


def load_saved_chunks(output_dir: Path, meta: dict) -> list[tuple[float, np.ndarray]]:
    chunks: list[tuple[float, np.ndarray]] = []
    for record in meta["chunks"]:
        pair = []
        for slot in range(2):
            path = output_dir / "chunks" / f"chunk_{record['index']:03d}_{slot}.wav"
            data, _ = sf.read(path, dtype="float32", always_2d=False)
            pair.append(np.asarray(data, dtype=np.float32))
        chunks.append((record["start"] / MODEL_SAMPLE_RATE, np.stack(pair)))
    return chunks


def run(
    input_path: Path,
    output_dir: Path,
    unmixx_dir: Path,
    device_name: str,
    chunk_seconds: float,
    overlap_seconds: float,
    anchors_raw: str | None,
    reuse: bool,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    device = choose_device(device_name)
    install_mps_pool_fallback()

    vocal_path = output_dir / "vocal.wav"
    meta_path = output_dir / "chunks" / "meta.json"
    if reuse:
        if not meta_path.is_file() or not vocal_path.is_file():
            raise ValueError("there is no saved analysis in this directory")
        meta = json.loads(meta_path.read_text())
    else:
        vocal = load_vocal_44(input_path)
        sf.write(vocal_path, vocal, OUTPUT_SAMPLE_RATE)
        meta = separate_and_save(
            input_path,
            output_dir,
            unmixx_dir,
            device,
            chunk_seconds,
            overlap_seconds,
        )

    vocal44 = librosa.load(vocal_path, sr=OUTPUT_SAMPLE_RATE, mono=True)[0]
    vocal24 = librosa.resample(vocal44, orig_sr=OUTPUT_SAMPLE_RATE, target_sr=MODEL_SAMPLE_RATE)
    chunks = load_saved_chunks(output_dir, meta)
    streams = voicemap.stitch_streams(chunks, len(vocal24))
    cache = output_dir / "windows.json"
    if reuse and cache.is_file():
        rows = json.loads(cache.read_text())
        windows = [
            voicemap.Window(
                time=float(row["time"]),
                rms=(float(row["rms"][0]), float(row["rms"][1])),
                f0=(row["f0"][0], row["f0"][1]),
            )
            for row in rows
        ]
        print(json.dumps({"stage": "map-cached"}), flush=True)
    else:
        print(json.dumps({"stage": "map"}), flush=True)
        windows = voicemap.measure_windows(
            streams,
            len(vocal24) / MODEL_SAMPLE_RATE,
            on_progress=lambda done, total: (
                print(
                    json.dumps({"stage": "map-window", "done": done, "total": total}),
                    flush=True,
                )
                if done % 10 == 0 or done == total
                else None
            ),
        )
        cache.write_text(
            json.dumps(
                [{"time": row.time, "rms": list(row.rms), "f0": list(row.f0)} for row in windows]
            )
        )
    edges = voicemap.vocal_phrase_edges(vocal44, OUTPUT_SAMPLE_RATE)
    segments = voicemap.build_segments(windows, edges)

    embedder = Embedder(model_dir=Path(__file__).resolve().parent.parent / ".cache/ecapa")
    anchors = voicemap.default_anchors(
        segments,
        vocal44,
        OUTPUT_SAMPLE_RATE,
        embedder,
        windows=windows,
    )
    requested = parse_anchors(anchors_raw)
    for item in requested:
        validate_anchor(segments, int(item["voice"]), float(item["start"]), float(item["end"]))
        anchors = voicemap.add_anchor(
            anchors,
            int(item["voice"]),
            float(item["start"]),
            float(item["end"]),
            vocal44,
            OUTPUT_SAMPLE_RATE,
            embedder,
        )
    voicemap.label_segments(
        segments,
        anchors,
        vocal24,
        MODEL_SAMPLE_RATE,
        embedder,
        streams,
        windows,
    )
    voice1, voice2 = voicemap.render(segments, vocal24, MODEL_SAMPLE_RATE, streams)
    voicemap.save_wav(output_dir / "voice1.wav", voice1, OUTPUT_SAMPLE_RATE)
    voicemap.save_wav(output_dir / "voice2.wav", voice2, OUTPUT_SAMPLE_RATE)

    quality = {"solo": 0.0, "both": 0.0, "unison": 0.0, "none": 0.0, "lowConfidence": 0.0}
    for segment in segments:
        duration = segment.end - segment.start
        quality[segment.kind] = quality.get(segment.kind, 0.0) + duration
        if segment.kind in ("solo", "both") and segment.confidence < 0.15:
            quality["lowConfidence"] += duration
    payload = {
        "version": 1,
        "sampleRate": OUTPUT_SAMPLE_RATE,
        "durationSeconds": len(vocal44) / OUTPUT_SAMPLE_RATE,
        "anchors": [
            {"voice": anchor.voice, "start": anchor.start, "end": anchor.end} for anchor in anchors
        ],
        "segments": [
            {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "kind": segment.kind,
                "voice": segment.voice,
                "voice1Slot": segment.voice1_slot,
                "confidence": round(segment.confidence, 3),
                "reason": segment.reason,
            }
            for segment in segments
        ],
        "quality": {key: round(value, 2) for key, value in quality.items()},
    }
    (output_dir / "map.json").write_text(json.dumps(payload, indent=1))
    print(
        json.dumps(
            {
                "stage": "done",
                "output": str(output_dir),
                "seconds": round(payload["durationSeconds"], 2),
                "lowConfidenceSeconds": payload["quality"]["lowConfidence"],
            }
        ),
        flush=True,
    )
