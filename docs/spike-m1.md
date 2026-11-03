# M1 feasibility spike

Target machine: Apple M1, 8 GB, Chrome. Date: 2026-11-03.

## Verdict

**Separation: viable with limits.** A whole 4-minute stereo track separated end to end in 123 s,
holding 60 fps on the main thread, streaming two 81 MiB stems to OPFS. It needs WebGPU: WASM lands
at or below realtime.

**Transcription: runs, but not usable for M3 as exported.** `onnx-community/whisper-base` cannot
produce word-level timestamps at all. Mandarin and Japanese both work and return text with
segment timestamps, so the language coverage is fine; the timing granularity M3 needs is not there.

**Hosting: decided in principle** (R2 under the same host at `/weights/*`), not built, as briefed.

## Environment

| Fact | Value |
| --- | --- |
| Browser | HeadlessChrome/156.0.8078.4, Playwright's bundled Chromium |
| Cores | 8 |
| Cross-origin isolated | true |
| WebGPU adapter | vendor `apple`, architecture `metal-3`, `isFallbackAdapter: false` |
| Free memory during runs | **92 MiB to 1680 MiB of 8192**, load average **4.4 to 60.0** |

Another workload shared this machine throughout. **Every timing below is an upper bound**, and the
WASM transcription figure was taken at load average 60.

## Separation

Fixture: synthesised stereo 44.1 kHz, 25% segment overlap. "Inference RTF" is audio seconds per
second inside `session.run`. "Peak RSS" is the resident memory of our browser's whole process tree,
measured with `ps` and restricted to descendants of the browser we launched, so the unrelated
Chromium on this machine is excluded. It is the only figure here that includes the GPU process.

| Model | Backend | Mode | Load | Median segment | Inference RTF | Peak RSS (renderer / gpu) |
| --- | --- | --- | --- | --- | --- | --- |
| mdx-inst-hq5 | webgpu | load | 1.13 s | — | — | 309 MiB (143 / 42) |
| mdx-inst-hq5 | wasm | load | 0.83 s | — | — | 835 MiB (594 / 65) |
| htdemucs-web | webgpu | load | 1.80 s | — | — | 900 MiB (733 / 60) |
| htdemucs-web | wasm | load | 2.00 s | — | — | 894 MiB (751 / 39) |
| mdx-inst-hq5 | webgpu | bench 4 | 0.95 s | 1300 ms | **3.30x** | 982 MiB (724 / 84) |
| mdx-inst-hq5 | wasm | bench 4 | 0.83 s | 4794 ms | 0.94x | 1207 MiB (991 / 56) |
| htdemucs-web | webgpu | bench 4 | 1.86 s | 1619 ms | **3.37x** | 1096 MiB (879 / 81) |
| htdemucs-web | wasm | bench 4 | 2.17 s | 6138 ms | 0.99x | 1111 MiB (893 / 57) |
| **mdx-inst-hq5** | **webgpu** | **audio, whole track** | 0.79 s | **1306 ms** | **3.38x**, wall **1.95x** | not sampled |
| mdx-inst-hq5 (repeat) | webgpu | audio, whole track | 0.79 s | 1318 ms | 3.30x, wall 1.82x | not sampled |

The two whole-track runs predate the `ps` instrumentation, so they have no RSS figure.

Across the 54 segments of a whole-track run: min 1282 ms, max 1529 ms. No drift, no leak. Main
thread over the same run: 7333 animation frames, worst gap 36 ms, **nothing over 50 ms**. The
repeat differed by 1% on segment time and 7% on wall clock, tracking load average.

### What it says

- **WebGPU or nothing.** 3.5x faster than WASM on MDX, 3.8x on htdemucs. WASM at 0.94x and 0.99x
  means a 4-minute track costs 4 minutes of compute. It is a correctness fallback, not a path to
  offer a user. The fp16 htdemucs chain does run on WASM, so that risk is retired.
- **WebGPU also costs less memory, by a lot, at load time.** 309 MiB against 835 MiB for MDX,
  because the WASM provider holds the weights in renderer linear memory. Under inference the gap
  narrows (982 against 1207 MiB).
- **Peak RSS approaches 1.2 GiB.** On a machine that was repeatedly down to ~100 MiB free, that is
  the number that will decide whether this ships. It is survivable but not comfortable, and it is
  measured with a 42 MiB input already decoded in the page.
- **The host transform is the bottleneck, not the model.** The whole-track run spent 70.5 s inside
  `session.run` and 123 s of wall clock. The missing ~52 s is the JavaScript STFT and iSTFT, about
  0.96 s per segment, **42% of total time**. Moving it to WASM takes the felt rate from 1.95x
  towards 3.3x.
- **htdemucs costs 34% more per second of audio than MDX** on WebGPU, for 4 stems instead of 2,
  and every one of its 21 pieces is under the Pages 25 MiB asset limit.

### Memory, page side

| Measurement | Value |
| --- | --- |
| Page JS heap after decoding 240 s of stereo | **188 MB** |
| Page JS heap before decoding | 20.5 MB |
| Stems per 240 s track | 2 × 81 MiB, streamed to OPFS |
| Worker heap | unavailable: `performance.memory` does not exist in a worker |
| Whole-agent memory | unavailable: `measureUserAgentSpecificMemory` returned null on every run |

Decoding a whole file costs 188 MB before separation starts. M2 should decode in chunks.

## Transcription

`onnx-community/whisper-base`, int8 encoder and merged decoder, same weights on both backends,
through `@huggingface/transformers`. Input is the 15 s fixture, resampled in the worker to 16 kHz
mono.

| Backend | Language | Mode | Load | Inference | RTF | Word timestamps | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| webgpu | — | load | 4.08 s | — | — | — | 652 MiB |
| wasm | — | load | 1.92 s | — | — | — | 770 MiB |
| webgpu | ja | audio | 2.76 s | 7.17 s | 2.09x | **no** | 709 MiB |
| wasm | ja | audio | 1.93 s | 3.30 s | **4.54x** | **no** | 805 MiB |
| webgpu | zh | audio | 2.13 s | 66.8 s wall | 0.22x | **no** | 1026 MiB |

### Word timestamps are not available, and that is the finding

Asking for `return_timestamps: 'word'` fails on every run:

```
Model outputs must contain cross attentions to extract timestamps. This is most likely because
the model was not exported with `output_attentions=True`.
```

The spike falls back to segment timestamps, which work: the Japanese run returned
`さて、この動画が終わりに来てもらったら、またね!` spanning 0–15000 ms. **M3 needs word or
character timing for a KTV wipe, so this export cannot do the job.** Options, in order of
preference:

1. Find or produce a whisper ONNX export with cross-attentions, which is what transformers.js
   needs for its DTW alignment.
2. Do forced alignment separately against pasted or transcribed text. The product already needs
   this path for Cantonese, so building it once serves both.
3. Transcribe for text only and have the user tap timings in the editor, which M3 plans anyway.

### Two more things worth knowing

**WASM beat WebGPU, 4.54x against 2.09x.** Whisper's decoder is autoregressive: many small
sequential operations, which suit SIMD on a CPU better than per-op GPU dispatch, and int8 weights
run natively on WASM while WebGPU dequantises. Treat this as indicative rather than controlled: the
two backends returned transcripts of different lengths (6 s against 15 s of span) from identical
input, so they did different amounts of decoding work. The direction is still a real signal, and it
inverts the assumption that WebGPU is the fast path for every model.

**Non-speech input sends the decoder into a repetition loop.** The Mandarin run produced
`因為我沒有想到` sixty-odd times and took 66.8 s for 15 s of audio, 0.22x realtime, against 2.09x
for the run that terminated normally. The fixture is tones and noise, but **songs contain long
instrumental passages**, so this is a product risk and not only a fixture artefact: transcription
needs silence and instrumental detection, or a repetition penalty, before it meets a real song.

Language coverage itself is fine: `zh` and `ja` were both accepted and both returned plausible
text in the right script.

## Corrections from review

**The two long runs I previously recorded as a crash were not one.** The 39-minute run and the
1771 s run were **stalled and killed by the operator**, observed idle at about 1% CPU with a small
renderer. Nothing crashed. The result file is now
`mdx-inst-hq5-webgpu-bench-stalled-killed-by-operator.json`, and the harness no longer prints
"DIED" when its watchdog fires.

**Their cause was never directly observed.** Those runs produced no phase data, because the
instrumentation did not exist yet. What is known: the code they ran contained two independent
silent-hang defects, both since fixed and both verified by before-and-after measurement.

1. `decodeAudioData` on a plain `AudioContext` never settles in a headless browser: no output
   device, no error, no timeout. Fixed with `OfflineAudioContext` and `--mute-audio`; decoding
   42 MiB now takes about 150 ms.
2. Chrome blocked the runtime fetch and `InferenceSession.create` waited forever. The Audits domain
   named it: `BlockedByResponseIssue reason: CoepFrameResourceNeedsCoepHeader` on
   `/spike-ort/ort-wasm-simd-threaded.asyncify.mjs?import`. A cross-origin isolated page loads ORT's
   emscripten glue as a nested worker script, so the response must itself assert COEP. Fixed by
   sending COEP and CORP on the dev routes; session creation went from hanging to 0.66 s on WASM
   and 1.89 s on WebGPU.

Either could have been the stall those runs hit. Decode came first in the code path, so it is the
likelier of the two, but that is inference and not a measurement.

**The attribution guard is narrowed to authorship phrasing.** It now matches co-authorship
trailers, "generated/written/authored by or with <tool>", "assisted by <tool>", the hyphenated
machine-authorship adjective, and the robot emoji. A tool or vendor name on its own no longer trips
it, so `upstream openai/whisper weights MIT` is allowed and the original licence wording is
restored. The exclusion list shrank from four paths to two: only the pattern module and its own
test, which match by construction. `CLAUDE.md` and `pnpm-lock.yaml` are now scanned and pass.

## Hosting

- **Cloudflare Pages caps one asset at 25 MiB**, hard
  ([Pages limits](https://developers.cloudflare.com/pages/platform/limits)).
- `connect-src 'self'` means the exact origin; a subdomain is not `'self'`.
- Measured above: the runtime's own script must also assert COEP, or the loader hangs silently.

| Model | Largest file | Ships as a Pages asset? |
| --- | --- | --- |
| htdemucs-web | 21.0 MiB | **yes**, all 21 pieces fit |
| mdx-inst-hq5 | 56.3 MiB | no |
| whisper-base int8 | 51.2 MiB | no |

Accepted in principle: **R2 under the same host at `/weights/*`**. Same-origin keeps
`connect-src 'self'` intact, satisfies COEP and CORP from our own headers, and sidesteps the asset
cap. The spike is evidence the shape works: it served 254 MiB of weights and a 29 MB WASM runtime
to a cross-origin isolated page from its own origin and **needed no CSP exception**. Not built in
M1, as instructed.

## Licences

| Model | Declared | Upstream | Notes |
| --- | --- | --- | --- |
| `monteslu/htdemucs-web-onnx` | MIT | demucs (Meta AI), MIT | Credits Défossez et al. Clean. |
| `raydotac/AudioSeparatorONNX` | MIT (repo metadata) | UVR MDX-Net weights by Anjok07 and others | **Repo licence covers the conversion, not the weights' training data, which is undocumented upstream.** Resolve before shipping. |
| `onnx-community/whisper-base` | Apache-2.0 | `openai/whisper`, MIT | Clean. |

No weights are committed; `models/` is gitignored and the media guard fails CI on any `.onnx`.

## Candidates rejected

| Candidate | Why rejected |
| --- | --- |
| `timcsy/demucs-web-onnx` | No model card, so no licence and no documented input contract. Not downloaded. |
| `musetric/uvr-mdxnet-kara2-onnx` | Splits an isolated vocal into lead and backing. Needs a vocal stem, not a mix, so it is an M3 or later tool, not a separation candidate. |
| `raydotac` VR and BSRoformer graphs | 213 MiB and 347 MiB, both far past anything an 8 GB target should load, and neither needed once MDX and htdemucs both ran. Not downloaded. |
| whisper-base fp16 and fp32 | 139 MiB and 278 MiB against 73 MiB for int8, and int8 is the only variant sane on both backends. Not downloaded. |

A published metadata file was also wrong: `raydotac`'s `metadata.json` gives `dim_f` 3072 for
`UVR-MDX-NET-Inst_HQ_5`, but the graph wants 2560 (`[-1, 4, 2560, 256]`). The worker now reads the
shape back from the session rather than trusting metadata.

## What I did not or could not measure

- **Separation quality, for anything.** The fixture is tones and pink noise. The MDX stems are real
  audio from the real pipeline, so the ear check is ready: `pnpm run dev`, open `/spike`, pick a
  song you own, `audio` mode, play both stems.
- **htdemucs audio.** Its host pipeline (demucs framing, `mag` layout, mask, iSTFT, overlap-add) is
  not implemented, so its numbers are inference cost only.
- **Transcription accuracy.** Synthetic audio has no speech, and no speech fixture can be
  synthesised here. Needs a real recording.
- **Korean and Cantonese.** Only `zh` and `ja` were exercised beyond English.
- **Worker and whole-agent memory.** `performance.memory` is absent in workers and
  `measureUserAgentSpecificMemory` returned null throughout. Process-level RSS via `ps` covers the
  gap at the process level but cannot attribute memory to the worker.
- **A whole-track run with RSS sampling, and a whole-track transcription.** Both whole-track
  separation runs predate the `ps` instrumentation.
- **Full Chrome and headed mode.** Everything ran in bundled headless Chromium with a real Apple
  GPU. `--headed true --channel chrome` is wired up and untried.
- **An unloaded machine.** Load average ranged 4.4 to 60.0.
- **Resumability.** Jobs are not checkpointed; a closed tab loses the run.

## Reproducing

```sh
node scripts/spike/make-fixtures.mjs
node scripts/spike/models.mjs fetch

node scripts/spike/run-spike.mjs --probe
node scripts/spike/run-spike.mjs --check
node scripts/spike/run-spike.mjs --mode load  --model mdx-inst-hq5 --backend webgpu
node scripts/spike/run-spike.mjs --mode bench --model htdemucs-web --backend webgpu --segments 4
node scripts/spike/run-spike.mjs --mode audio --model mdx-inst-hq5 --backend webgpu --segments 0
node scripts/spike/run-spike.mjs --task transcription --mode audio --model whisper-base \
  --backend wasm --language ja --fixture tone-15s.wav
```

`--stall` bounds every run (default 90 s): no phase for that long and the run is recorded as
stalled, naming the phase, with a non-zero exit. `--segments 0` runs the whole input.

## What M2 and M3 should take from this

1. Move the STFT and iSTFT into WASM. They are 42% of separation wall time.
2. Decode in chunks: 188 MB for one decoded track is too much here.
3. Build separation on WebGPU; keep WASM as a labelled fallback, not a default.
4. Prefer htdemucs: 4 stems, 34% more compute, every piece under the Pages limit.
5. Do not assume WebGPU wins everywhere. For whisper it lost, and M3 should measure both.
6. Settle word timing before M3 starts: find an export with cross-attentions, or build forced
   alignment, which Cantonese needs anyway.
7. Handle instrumental passages before transcribing songs, or the decoder will loop.
8. Checkpoint per segment: a 123 s job must survive a closed tab.
