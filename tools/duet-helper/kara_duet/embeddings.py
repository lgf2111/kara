"""Singer embeddings for the voice map.

ECAPA is loaded lazily: the unit tests exercise the map's pure geometry with a
fake embedder, and the CLI only pays for speechbrain when it actually maps a
song.
"""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np


class Embedder:
    """A small wrapper around the speechbrain ECAPA model."""

    def __init__(self, model_dir: Path | None = None, device: str = "cpu") -> None:
        self._device = device
        self._model = None
        self._model_dir = model_dir

    def _load(self):
        if self._model is not None:
            return self._model
        from speechbrain.inference.speaker import EncoderClassifier  # noqa: PLC0415

        kwargs = {
            "source": "speechbrain/spkrec-ecapa-voxceleb",
            "run_opts": {"device": self._device},
        }
        if self._model_dir is not None:
            kwargs["savedir"] = str(self._model_dir)
        self._model = EncoderClassifier.from_hparams(**kwargs)
        return self._model

    def embed(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        import torch  # noqa: PLC0415

        resampled = librosa.resample(audio, orig_sr=sample_rate, target_sr=16_000)
        with torch.no_grad():
            embedding = (
                self._load()
                .encode_batch(torch.from_numpy(resampled).float().unsqueeze(0))
                .squeeze()
                .cpu()
                .numpy()
            )
        return embedding / (np.linalg.norm(embedding) + 1e-12)
