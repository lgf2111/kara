"""The UNMIXX model and one-chunk inference.

The extension cannot run PyTorch itself, so the helper keeps the model native.
This module is the model half only: load the checkpoint, choose an accelerator,
read a WAV at the model rate, and run one padded chunk.
"""

from __future__ import annotations

import os

# Must be set before torch is imported: MPS does not implement every op used by
# the model's STFT path, and the fallback is bit-identical to CPU in testing.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import sys
from pathlib import Path

import torch
import torch.nn.functional as F
import torchaudio
import yaml

from .config import MODEL_SAMPLE_RATE


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
    """Pick the requested accelerator, or the best available one."""
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
    """Load the upstream UNMIXX checkpoint into the vendored package."""
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
    state = {key.removeprefix("audio_model."): value for key, value in state.items()}
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
