"""Native chunked runner for UNMIXX.

The extension cannot run PyTorch itself, so this helper keeps the model native
and exposes it to the extension later over a local bridge. This file is only
the audio half: WAV in, two WAVs out.

The important details are the 24 kHz mono model input, chunking below the point
where MPS attention becomes impractical, speaker-order alignment on the
overlap, and a crossfade where one chunk meets the next.
"""

from __future__ import annotations

import argparse
import json
import os

# Must be set before torch is imported: MPS does not implement every op used by
# the model's STFT path, and the fallback is bit-identical to CPU in testing.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import sys
import time
from collections.abc import Callable
from pathlib import Path

import torch
import torch.nn.functional as F
import torchaudio
import yaml

MODEL_SAMPLE_RATE = 24_000
DEFAULT_OUTPUT_RATE = 44_100
DEFAULT_CHUNK_SECONDS = 13.0
DEFAULT_OVERLAP_SECONDS = 1.0


def install_mps_pool_fallback() -> None:
    """Make adaptive pooling usable on MPS.

    PyTorch's MPS adaptive pooling requires divisible input lengths; UNMIXX's
    frequency path does not always provide them. The CPU fallback is only used
    for that one operation, and the resulting tensors move straight back to the
    accelerator.
    """
    original = F.adaptive_avg_pool1d
    if getattr(original, "_kara_safe", False):
        return

    def safe_pool(input: torch.Tensor, output_size: int) -> torch.Tensor:
        try:
            return original(input, output_size)
        except RuntimeError:
            return original(input.cpu(), output_size).to(input.device)

    safe_pool._kara_safe = True  # type: ignore[attr-defined]
    F.adaptive_avg_pool1d = safe_pool  # type: ignore[assignment]


def choose_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_audio(path: Path) -> torch.Tensor:
    """Load a file as one 24 kHz mono channel."""
    waveform, sample_rate = torchaudio.load(str(path))
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != MODEL_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, sample_rate, MODEL_SAMPLE_RATE)
    return waveform


def load_model(unmixx_dir: Path, device: torch.device) -> torch.nn.Module:
    sys.path.insert(0, str(unmixx_dir))
    from look2hear.models import UNMIXX  # noqa: PLC0415 - vendor path is runtime context

    config = yaml.safe_load((unmixx_dir / "ckpt/conf.yml").read_text())
    audio_config = config["audionet"]["audionet_config"]
    sample_rate = config["datamodule"]["data_config"]["sample_rate"]
    model = UNMIXX(sample_rate=sample_rate, **audio_config)
    checkpoint = torch.load(
        unmixx_dir / "ckpt/best.ckpt",
        map_location="cpu",
        weights_only=False,
    )
    state = checkpoint.get("state_dict", checkpoint)
    state = {
        key.removeprefix("audio_model."): value
        for key, value in state.items()
    }
    model.load_state_dict(state, strict=True)
    model.to(device).eval()
    return model


def separate_chunk(
    model: torch.nn.Module,
    chunk: torch.Tensor,
    device: torch.device,
) -> torch.Tensor:
    """Run one padded chunk through the model and return [2, frames]."""
    with torch.no_grad():
        result = model(chunk.unsqueeze(0).to(device), istest=True)
    if isinstance(result, tuple):
        result = result[0]
    if isinstance(result, dict):
        result = result.get("output_final", next(iter(result.values())))
    if result.ndim == 3:
        result = result[0]
    return result.detach().cpu()


def overlap_permutation(
    estimate: torch.Tensor,
    previous: torch.Tensor,
) -> tuple[int, int]:
    """Choose the output order that best matches the previous chunk's tail."""
    frames = min(estimate.shape[-1], previous.shape[-1])
    if frames == 0:
        return (0, 1)
    head = estimate[:, :frames]
    tail = previous[:, :frames]
    direct = float(torch.mean((head - tail) ** 2))
    swapped = float(torch.mean((head.flip(0) - tail) ** 2))
    return (0, 1) if direct <= swapped else (1, 0)


def separate_track(
    model: torch.nn.Module,
    waveform: torch.Tensor,
    device: torch.device,
    output_rate: int = DEFAULT_OUTPUT_RATE,
    chunk_seconds: float = DEFAULT_CHUNK_SECONDS,
    overlap_seconds: float = DEFAULT_OVERLAP_SECONDS,
    on_progress: Callable[[int, int, float], None] | None = None,
) -> tuple[torch.Tensor, torch.Tensor, dict[str, float | int]]:
    """Separate a whole mono 24 kHz waveform into two mono voices."""
    if chunk_seconds <= 0 or overlap_seconds < 0 or overlap_seconds >= chunk_seconds:
        raise ValueError("chunk and overlap sizes are not usable")
    if output_rate <= 0:
        raise ValueError("output rate must be positive")

    frames = waveform.shape[-1]
    chunk = int(round(chunk_seconds * MODEL_SAMPLE_RATE))
    overlap = int(round(overlap_seconds * MODEL_SAMPLE_RATE))
    hop = chunk - overlap
    total_chunks = max(1, (max(0, frames - overlap) + hop - 1) // hop)
    voices = torch.zeros(2, frames)
    previous: torch.Tensor | None = None
    started = time.monotonic()

    for index in range(total_chunks):
        start = index * hop
        if start >= frames:
            break
        end = min(frames, start + chunk)
        piece = waveform[:, start:end]
        valid = piece.shape[-1]
        if valid < chunk:
            piece = F.pad(piece, (0, chunk - valid))
        estimate = separate_chunk(model, piece, device)[:, :valid]
        if previous is not None:
            permutation = overlap_permutation(estimate, previous)
            if permutation != (0, 1):
                estimate = estimate.flip(0)
            fade = min(overlap, valid, previous.shape[-1])
            if fade > 0:
                ramp = torch.linspace(0, 1, fade).unsqueeze(0)
                voices[:, start : start + fade] = (
                    voices[:, start : start + fade] * (1 - ramp)
                    + estimate[:, :fade] * ramp
                )
                voices[:, start + fade : end] = estimate[:, fade:]
            else:
                voices[:, start:end] = estimate
        else:
            voices[:, start:end] = estimate

        tail = min(overlap, estimate.shape[-1])
        previous = estimate[:, -tail:] if tail > 0 else None
        if device.type == "mps":
            torch.mps.empty_cache()
        if on_progress is not None:
            on_progress(index + 1, total_chunks, time.monotonic() - started)

    # The model works at 24 kHz; the extension's playback stems are at 44.1 kHz.
    voices = torchaudio.functional.resample(voices, MODEL_SAMPLE_RATE, output_rate)
    summary = {
        "frames": frames,
        "seconds": frames / MODEL_SAMPLE_RATE,
        "chunks": total_chunks,
        "chunkSeconds": chunk_seconds,
        "overlapSeconds": overlap_seconds,
        "outputRate": output_rate,
    }
    return voices[0], voices[1], summary


def save_voice(path: Path, voice: torch.Tensor, sample_rate: int) -> None:
    """Save a mono voice as a stereo WAV for the extension's stem layout."""
    path.parent.mkdir(parents=True, exist_ok=True)
    stereo = voice.unsqueeze(0).repeat(2, 1)
    torchaudio.save(str(path), stereo, sample_rate)


def main() -> None:
    parser = argparse.ArgumentParser(description="Split a vocal stem into two voices with UNMIXX.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--unmixx", type=Path, default=Path(__file__).parent / ".vendor/unmixx")
    parser.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    parser.add_argument("--output-rate", type=int, default=DEFAULT_OUTPUT_RATE)
    parser.add_argument("--chunk-seconds", type=float, default=DEFAULT_CHUNK_SECONDS)
    parser.add_argument("--overlap-seconds", type=float, default=DEFAULT_OVERLAP_SECONDS)
    args = parser.parse_args()

    if not args.input.is_file():
        parser.error(f"input does not exist: {args.input}")
    if not (args.unmixx / "ckpt/best.ckpt").is_file():
        parser.error(f"UNMIXX checkpoint not found under {args.unmixx}; run setup.sh first")

    install_mps_pool_fallback()
    device = choose_device(args.device)
    print(
        json.dumps(
            {
                "stage": "loading",
                "device": str(device),
                "input": str(args.input),
                "unmixx": str(args.unmixx),
            }
        ),
        flush=True,
    )
    model = load_model(args.unmixx, device)
    waveform = load_audio(args.input)
    print(
        json.dumps(
            {
                "stage": "separating",
                "seconds": round(waveform.shape[-1] / MODEL_SAMPLE_RATE, 2),
            }
        ),
        flush=True,
    )

    def progress(done: int, total: int, elapsed: float) -> None:
        print(
            json.dumps(
                {
                    "stage": "chunk",
                    "done": done,
                    "total": total,
                    "elapsedSeconds": round(elapsed, 1),
                }
            ),
            flush=True,
        )

    started = time.monotonic()
    voice1, voice2, summary = separate_track(
        model,
        waveform,
        device,
        output_rate=args.output_rate,
        chunk_seconds=args.chunk_seconds,
        overlap_seconds=args.overlap_seconds,
        on_progress=progress,
    )
    save_voice(args.output_dir / "voice1.wav", voice1, args.output_rate)
    save_voice(args.output_dir / "voice2.wav", voice2, args.output_rate)
    print(
        json.dumps(
            {
                "stage": "done",
                "elapsedSeconds": round(time.monotonic() - started, 1),
                **summary,
                "output": str(args.output_dir),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
