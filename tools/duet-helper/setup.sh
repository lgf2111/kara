#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d .vendor/unmixx/.git ]; then
  mkdir -p .vendor
  git clone --depth 1 https://github.com/jihoojung0106/unmixx.git .vendor/unmixx
else
  echo "using existing .vendor/unmixx"
fi

# The upstream package imports its full training stack from these two package
# initializers. The inference path only needs the model and layer modules, so
# clear the optional imports rather than installing the whole training world.
: > .vendor/unmixx/look2hear/utils/__init__.py
: > .vendor/unmixx/look2hear/models/layers/__init__.py

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
