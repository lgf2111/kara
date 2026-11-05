# Kara Duet Helper

A local, native helper that turns the htdemucs vocal stem into two consistent
voices: **Voice 1** and **Voice 2**. The extension can then mute either voice
instead of muting the whole guide.

Everything runs on this machine. The extension uploads the vocal stem to
`127.0.0.1`; no audio leaves the computer.

The separator is UNMIXX:

- repository: <https://github.com/jihoojung0106/unmixx>
- checkpoint: `ckpt/best.ckpt` in that repository
- non-commercial use only

UNMIXX separates two simultaneous voices, but its two outputs are not tied to a
singer across a whole song. The helper adds a voice map on top: solo lines are
routed from the untouched vocal stem, simultaneous lines use the separated
streams, and the map is anchored by two clean solo lines. The panel can replace
or add anchors when a song uses an unexpected register.

## Setup

```bash
cd tools/duet-helper
uv venv .venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements.txt
./setup.sh
```

`setup.sh` clones UNMIXX into `.vendor/unmixx`, removes two optional training
imports from the vendored copy, and downloads the ECAPA speaker model used by
the voice map into `.cache/ecapa`.

## Start the bridge

```bash
source .venv/bin/activate
python bridge.py
```

The bridge prints:

```text
Kara duet bridge on http://127.0.0.1:8765
token: ...
```

Open the Kara popup and paste the URL and token into **Duet helper**, then press
**Save**. The token is also stored at `~/.kara-duet/token`, so it survives a
restart.

Options:

```text
--host 127.0.0.1
--port 8765
--unmixx .vendor/unmixx
--token <fixed token>
--jobs-dir ~/.kara-duet/jobs
```

The bridge serves one song at a time, reports progress, serves the two WAVs,
and accepts calibration anchors for a finished job. It binds to loopback only.

## Use it from the extension

1. Start karaoke and wait until the normal preparation is complete.
2. Press **Duet** on the Vocals row.
3. Wait while the helper splits and maps the voices. The normal vocal row stays
   usable for the whole wait. **Cancel** stops the helper and returns to the
   single vocal.
4. When it is ready, the Vocals row becomes **Voice 1** and **Voice 2**, each
   with a level, **M**, **S**, and the usual backing rows below.
5. Use **Swap** if the two streams are the right pair but the labels are the
   wrong way round.
6. If a line is in the wrong voice, pause on a line where only one singer
   sings, press **Fix line**, and choose **This is Voice 1** or **Voice 2**. The
   helper adds that line as an anchor and re-renders in a few seconds.
7. **Single vocal** returns to the ordinary one-vocal stem.

The panel warns when the map has low-confidence sections. That is usually a
unison or a harmony where both singers are too close for a clean split; the
line still plays, but it may not mute cleanly.

## Command line

A full run:

```bash
python helper.py \
  --input /path/to/vocals.wav \
  --output-dir ./out \
  --device mps
```

Outputs:

```text
out/
  voice1.wav       44.1 kHz stereo, Voice 1
  voice2.wav       44.1 kHz stereo, Voice 2
  map.json         segments, anchors, confidence and quality
  vocal.wav        the mono 44.1 kHz stem used for anchors
  chunks/          the raw UNMIXX streams, kept for re-rendering
  windows.json     the one-second energy/f0 rows
```

`--device` can be `auto`, `mps`, `cuda` or `cpu`. `--chunk-seconds` and
`--overlap-seconds` default to 13 and 1.

Re-render with calibration anchors, without running the model again:

```bash
python helper.py --reuse --output-dir ./out --anchors anchors.json
```

`anchors.json` is a list:

```json
[
  { "voice": 1, "start": 77.0, "end": 80.0 },
  { "voice": 2, "start": 102.0, "end": 105.0 }
]
```

The bridge uses the same path for the panel's **Fix line** button.

## How the voice map works

1. UNMIXX runs on 13-second chunks with a one-second overlap and saves both raw
   streams.
2. The helper measures energy and f0 once per second, and marks each second as
   **none**, **solo**, **both** or **unison**.
3. **Solo** lines are rendered from the untouched vocal stem. They are the
   cleanest audio and do not depend on the model's output order.
4. **Both** lines are rendered from the two separated streams. The map chooses
   which stream is Voice 1 by comparing each stream against the anchor set, and
   falls back to pitch continuity when the anchors are weak.
5. **Unison** lines are copied to both voices, because they cannot be split;
   the panel reports them as low confidence.
6. The first two long solo lines are the default anchors. The first is Voice 1,
   the second is Voice 2. **Fix line** adds a user anchor, which takes priority
   over the defaults through a best-match score.

The map is a plain list of segments in `map.json`, so it can be inspected or
rebuilt without touching the model.

## Time

On this M1 Mac with MPS:

- full 4:54 song: about **5.5 minutes** for UNMIXX
- voice map: roughly **1–2 minutes**
- calibration re-render: about **8 seconds** (the model is not run again)

CPU-only is much slower; CUDA is faster.

## Limits

- UNMIXX is trained on speech separation and does not separate two singers who
  sing **in unison**. Those sections are marked low confidence and played as a
  shared line.
- The speaker model is speech-trained. A high male register and a low female
  register can look alike; that is exactly what **Fix line** is for.
- The helper keeps the raw streams and the vocal stem on disk for a day, under
  `~/.kara-duet/jobs`, so a calibration can re-render without repeating the
  model. Delete that directory to reclaim the space.
- UNMIXX has no `LICENSE` file upstream; this project uses it only for a
  personal, non-commercial karaoke tool and does not redistribute the weights.
