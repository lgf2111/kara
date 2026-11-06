#!/usr/bin/env bash
# Prepare the native duet helper: pinned UNMIXX checkout plus the ECAPA model.
set -euo pipefail

cd "$(dirname "$0")"

UNMIXX_REPO="${UNMIXX_REPO:-https://github.com/jihoojung0106/unmixx.git}"
# The upstream code is pinned so a fresh setup is reproducible. Override this
# only when testing a deliberate upstream update.
UNMIXX_REF="${UNMIXX_REF:-8e750521b5942f4717656cac86a23cf0bd90dea5}"

if [ -d .vendor/unmixx/.git ]; then
  current="$(git -C .vendor/unmixx rev-parse HEAD 2>/dev/null || true)"
  if [ "$current" != "$UNMIXX_REF" ]; then
    echo "replacing .vendor/unmixx (found ${current:-unknown}, want $UNMIXX_REF)"
    rm -rf .vendor/unmixx
  fi
elif [ -d .vendor/unmixx ]; then
  # A previous download without its git metadata cannot be pinned or patched.
  echo "replacing incomplete .vendor/unmixx"
  rm -rf .vendor/unmixx
fi

if [ ! -d .vendor/unmixx/.git ]; then
  mkdir -p .vendor
  git init --quiet .vendor/unmixx
  git -C .vendor/unmixx remote add origin "$UNMIXX_REPO"
  git -C .vendor/unmixx fetch --depth 1 origin "$UNMIXX_REF"
  git -C .vendor/unmixx checkout --quiet --detach FETCH_HEAD
else
  echo "using existing .vendor/unmixx"
fi

# The upstream package imports its full training stack from these two package
# initializers. The inference path only needs the model and layer modules, so
# clear the optional imports rather than installing the whole training world.
: > .vendor/unmixx/look2hear/utils/__init__.py
: > .vendor/unmixx/look2hear/models/layers/__init__.py

# Upstream's STFT path builds its window with Tensor.type("torch.mps.FloatTensor"),
# which current PyTorch rejects. Apply the reviewed MPS patch once; setup can be
# rerun safely.
patch_file="$PWD/patches/unmixx-mps.patch"
if git -C .vendor/unmixx apply --reverse --check "$patch_file" >/dev/null 2>&1; then
  echo "MPS patch already applied"
else
  git -C .vendor/unmixx apply --check "$patch_file"
  git -C .vendor/unmixx apply "$patch_file"
fi

# The singer-identity pass uses ECAPA. Pull it once into the helper's cache so
# the first duet run is not also a model download.
if ! python -c "import speechbrain" >/dev/null 2>&1; then
  echo "speechbrain is not installed; activate the venv and run 'uv pip install -r requirements.txt' first" >&2
  exit 1
fi

python - <<'PY'
from speechbrain.inference.speaker import EncoderClassifier

EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=".cache/ecapa",
)
PY

echo "UNMIXX ready in .vendor/unmixx"
