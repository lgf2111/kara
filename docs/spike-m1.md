# M1 feasibility spike

Target machine: Apple M1, 8 GB, Chrome. Date: 2026-11-03.

## Verdict

**Separation: viable with limits.** A real browser on this machine separated a whole 4-minute
stereo track, start to finish, in **123 s of wall clock**, holding 60 fps on the main thread
throughout, and streamed two 81 MiB stems to OPFS. The limits are specific and listed below: it
needs WebGPU, the host-side transform is now the bottleneck, and decoding a whole file costs
~188 MB before separation starts.

**Transcription: still unmeasured.** Not built, not run. The defect that blocked separation would
have blocked it too, and that is now fixed, so it is unblocked work rather than an open risk.

**Hosting: answered**, with one extra requirement discovered the hard way: any origin serving the
inference runtime must assert COEP, not just CORP.

## The hang, and its root cause

Two independent defects, both in the harness rather than in any model, cost 69 minutes of wall
clock across three runs. Both are fixed, and both are worth recording because they fail silently.

**1. `decodeAudioData` on a plain `AudioContext` never returns in a headless browser.** There is no
audio output device, the context never reaches a running state, and the promise simply never
settles: no error, no timeout. This is what the renderer sitting at 1% CPU with 21 MB was doing.
Fixed by decoding through an `OfflineAudioContext`, which needs no device, and by passing
`--mute-audio` and `--autoplay-policy=no-user-gesture-required`. Decoding a 42 MiB WAV now takes
about 150 ms.

**2. `InferenceSession.create` never settled because Chrome blocked the runtime fetch.** The page is
cross-origin isolated, and `onnxruntime-web` loads its emscripten glue as a nested worker script.
Chrome then requires the response itself to carry COEP, and reported, via the Audits domain:

```
BlockedByResponseIssue  reason: CoepFrameResourceNeedsCoepHeader
  url: /spike-ort/ort-wasm-simd-threaded.asyncify.mjs?import
```

The request appeared as `net::ERR_BLOCKED_BY_RESPONSE`, and ORT reacted by waiting forever instead
of rejecting. Fixed by having the dev-only route send
`Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin`.
Session creation went from "hangs for 39 minutes" to **0.66 s on WASM and 1.89 s on WebGPU**.

Three things were ruled out along the way, each with evidence: the host DSP (unit tested; a
300-frame n_fft-7680 round trip is 552 ms), a missing runtime file (`--check` fetches all four URLs
and gets 200s), and the GPU being a software fallback (`vendor apple`, `architecture metal-3`,
`isFallbackAdapter: false`). One earlier probe was also measuring the wrong thing entirely: Vite
found port 5173 busy and moved to 5174, and the harness happily measured another project's page.
It now pins the port with `--strictPort` and rejects any page not titled `Kara M1 spike`.

### The watchdog

Every run now reports each phase it enters, and the harness fails the run if no phase arrives for
`--stall` seconds, naming the phase it stalled in, writing a JSON report, closing the browser and
exiting non-zero. No run can occupy this machine indefinitely again. Phases are: `page-ready`,
`fixture-fetch-start`, `fixture-fetched`, `decode-start`, `decode-done`, `run-start`,
`opfs-cleared`, `memory-sampled`, `worker-created`, `worker-posting-request`, `worker-received`,
`worker-gpu`, `ort-init`, `creating session`, `graph input shape`, `session ready`, `stft`,
`separating N/M`, `run-done`.

## Environment, measured

| Fact | Value |
| --- | --- |
| Browser | HeadlessChrome/156.0.8078.4, Playwright's bundled Chromium |
| Cores | 8 |
| Cross-origin isolated | true |
| `AudioContext` state | running, with `--mute-audio` |
| WebGPU adapter | vendor `apple`, architecture `metal-3`, `isFallbackAdapter: false` |
| `maxBufferSize` | 4 GiB |
| Free memory during runs | **81 MiB to 1031 MiB of 8192 MiB**, load average 4.4 to 13.8 |

That last row matters: another workload shared this machine throughout, so **every timing below is
an upper bound** on what the hardware can do.

## Question 1: separation

### Results

Fixture: 240 s synthesised stereo 44.1 kHz. Segments overlap by 25%. "Inference RTF" is audio
seconds per second spent inside `session.run`; "wall RTF" is audio seconds per second of total
elapsed time, which is the number a user would feel.

| Model | Backend | Mode | Segments | Load | Median segment | Inference RTF | Wall RTF | Worst frame gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mdx-inst-hq5 | webgpu | load | — | 1.89 s | — | — | — | 42 ms |
| mdx-inst-hq5 | wasm | load | — | 0.66 s | — | — | — | 19 ms |
| mdx-inst-hq5 | webgpu | bench | 4 | 0.82 s | 1297 ms | 3.04x | — | 23 ms |
| mdx-inst-hq5 | wasm | bench | 4 | 0.62 s | 4802 ms | 0.92x | — | 19 ms |
| htdemucs-web | webgpu | load | — | 1.80 s (21 pieces) | — | — | — | 19 ms |
| htdemucs-web | webgpu | bench | 4 | 1.66 s | 1733 ms | 2.73x | — | 19 ms |
| htdemucs-web | wasm | bench | 4 | 1.93 s | 5323 ms | 1.10x | — | 21 ms |
| mdx-inst-hq5 | webgpu | audio | 4 | 0.79 s | 1330 ms | 3.23x | — | 21 ms |
| **mdx-inst-hq5** | **webgpu** | **audio** | **54, whole track** | 0.79 s | **1306 ms** | **3.38x** | **1.95x** | **36 ms, 0 over 50 ms** |
| mdx-inst-hq5 (repeat) | webgpu | audio | 54, whole track | 0.79 s | 1318 ms | 3.30x | 1.82x | 98 ms, 1 over 50 ms |

The headline run and its repeat differ by 1% on median segment time and by 7% on wall clock, which
tracks the load average at the time (8.05 against 12.79). The spread across 54 segments is tight:
min 1282 ms, max 1529 ms, so there is no drift or leak over a full track.

### What this says

- **WebGPU is the only viable backend here.** It is 3.7x faster than WASM on MDX (1297 ms against
  4802 ms) and 3.1x on htdemucs. WASM lands at 0.92x and 1.10x of realtime, so a 4-minute track
  would take about 4 minutes of compute. WASM is a correctness fallback, not a usable one.
- **The tab survives comfortably.** Over 7333 animation frames of a full-track run the worst gap
  was 36 ms and nothing exceeded 50 ms. Inference is in a worker and the main thread stays free,
  which is what the player will need.
- **The host transform is now the bottleneck, not the model.** 54 segments spent 70.5 s inside
  `session.run` but 123 s of wall clock. The missing ~52 s is my JavaScript STFT and iSTFT, about
  0.96 s per segment, or **42% of total time**. Moving the transform into WASM is the single
  highest-value optimisation for M2 and would take the felt rate from 1.95x towards 3.3x.
- **htdemucs costs only 34% more than MDX per second of audio** on WebGPU (1733 ms per 7.80 s
  segment against 1297 ms per 5.92 s segment), while producing 4 stems instead of 2 and being the
  better-regarded model. Its 21 pieces load in 1.80 s.

### Memory

| Measurement | Value |
| --- | --- |
| Page JS heap after decoding 240 s of stereo | **188 MB** |
| Page JS heap before decoding | 20.5 MB |
| Stems written per 240 s track | 2 × 81 MiB, streamed to OPFS |
| Worker peak heap | **unavailable**: `performance.memory` does not exist in a worker |
| Whole-agent memory | **unavailable**: `measureUserAgentSpecificMemory` returned null on every run |

188 MB to hold one decoded track is the number to worry about on an 8 GB machine that sometimes has
100 MB free. 240 s × 44100 × 2 channels × 4 bytes is 84.7 MB of samples, and the undecoded
ArrayBuffer and the copies account for the rest. M2 should decode in chunks rather than whole.
Nothing here sees WebGPU buffer memory, so GPU-side usage is unmeasured by any figure above.

## Question 2: transcription

**Not measured and not built.** No whisper run happened, so there is nothing to report about
Mandarin, Japanese, word timestamps, or backend comparison. Weights were inventoried but not
downloaded. The COEP defect above would have blocked `@huggingface/transformers` in exactly the
same way, so fixing it is a prerequisite that is now done.

| Variant | Encoder | Merged decoder | Total |
| --- | --- | --- | --- |
| int8 | 22.1 MiB | 51.2 MiB | 73.3 MiB |
| fp16 | 39.4 MiB | 99.9 MiB | 139.3 MiB |
| fp32 | 78.6 MiB | 198.9 MiB | 277.5 MiB |

int8 is the variant to measure on both backends, since it is the only one that is sane on WASM and
one set of weights is the only way the comparison means anything.

## Question 3: where weights can live

- **Cloudflare Pages caps a single asset at 25 MiB**, hard
  ([Pages limits](https://developers.cloudflare.com/pages/platform/limits)).
- `connect-src 'self'` means the exact origin. A subdomain is not `'self'`.
- The page is COEP `require-corp`, and, measured above, **the runtime's own script must also assert
  COEP** or Chrome blocks it and the loader hangs.

| Model | Largest file | Ships as a Pages asset? |
| --- | --- | --- |
| htdemucs-web | 21.0 MiB | **yes**, all 21 pieces fit |
| mdx-inst-hq5 | 56.3 MiB | no |
| whisper-base int8 | 51.2 MiB | no |

**Recommendation: R2 under the same host and path**, for example `/weights/*`. Same-origin means
`connect-src 'self'` needs no change, CORP and COEP are satisfied by our own headers, no preflight
happens, and the 25 MiB asset cap does not apply to R2 objects. The spike is direct evidence that
the arrangement works: it served 176 MiB of weights and a 29 MB WASM runtime to a cross-origin
isolated page from its own origin, and **needed no CSP exception at all**.

**A named third-party origin is now clearly worse.** Besides a permanent `connect-src` entry
widening the one rule that makes "your audio never leaves your device" checkable, the third party
would have to serve its JavaScript glue with `Cross-Origin-Embedder-Policy: require-corp`. Most
CDNs do not, and the failure mode is a silent hang rather than an error.

The production CSP is unchanged by this spike and still pinned by a test.

## Licences, recorded

| Model | Declared | Upstream | Notes |
| --- | --- | --- | --- |
| `monteslu/htdemucs-web-onnx` | MIT | demucs (Meta AI), MIT | Export credits Défossez et al. Clean. |
| `raydotac/AudioSeparatorONNX` | MIT (repo metadata) | UVR MDX-Net weights by Anjok07 and others | **The repo licence covers the conversion, not the weights' training data, which is undocumented upstream.** Resolve before shipping. |
| `onnx-community/whisper-base` | Apache-2.0 | Whisper, MIT | Clean. |

No weights are committed; `models/` is gitignored and the media guard fails CI on any `.onnx`.

## A correction worth keeping

`raydotac`'s `metadata.json` gives `dim_f` 3072 for `UVR-MDX-NET-Inst_HQ_5`. The graph rejects that:

```
Got invalid dimensions for input: index: 2 Got: 3072 Expected: 2560
```

Its real input is `[-1, 4, 2560, 256]`. The worker now reads the shape back from the session and
uses that, so published metadata cannot silently break a run again.

## What I did not or could not measure

- **Transcription, entirely.** See above.
- **Separation quality, for anything.** The fixture is tones and pink noise; it exercises tensor
  shapes and nothing else. The MDX stems are real audio produced by the real pipeline, so the ear
  check is ready, but judging it needs a song. Play one through `/spike` by hand.
- **htdemucs audio.** Its host pipeline (demucs framing, `mag` layout, mask, iSTFT, overlap-add) is
  not implemented, so its numbers are inference cost only and say nothing about its output.
- **Worker and GPU memory.** `performance.memory` is absent in workers,
  `measureUserAgentSpecificMemory` returned null throughout, and no web API reports WebGPU buffer
  memory. Process-level measurement would need `ps` or `vm_stat`, which this shell does not allow.
- **Full Chrome, and headed mode.** Everything ran in Playwright's bundled headless Chromium. The
  adapter is the real Apple GPU, so the headless-shell suspicion is retired, but `--headed true
  --channel chrome` is wired up and untried.
- **A 4-minute run on an unloaded machine.** Free memory ranged from 81 MiB to 1031 MiB and load
  average from 4.4 to 13.8 during these runs, so the true figures are better than those reported.
- **Resumability.** Jobs are not checkpointed yet; a closed tab loses the run.

## Reproducing

```sh
node scripts/spike/make-fixtures.mjs
node scripts/spike/models.mjs fetch htdemucs-web mdx-inst-hq5

node scripts/spike/run-spike.mjs --probe                      # environment only
node scripts/spike/run-spike.mjs --check                      # runtime and model URLs
node scripts/spike/run-spike.mjs --mode load  --model mdx-inst-hq5 --backend webgpu
node scripts/spike/run-spike.mjs --mode bench --model htdemucs-web --backend webgpu --segments 4
node scripts/spike/run-spike.mjs --mode audio --model mdx-inst-hq5 --backend webgpu --segments 0
```

`--stall` bounds every run, default 90 s. `--segments 0` runs the whole input. Reports land in
`fixtures/generated/spike-results/`, which is gitignored. For the ear check, `pnpm run dev`, open
`/spike`, pick a file you own, run MDX in `audio` mode and play the two stems.

## What M2 should take from this

1. Move the STFT and iSTFT into WASM. They are 42% of wall time.
2. Decode in chunks. 188 MB for one decoded track is too much on this target.
3. Build on WebGPU, and treat WASM as a correctness fallback with an honest warning, not a path a
   4-minute track should take.
4. Prefer htdemucs: 4 stems, better reputation, 34% more compute per second of audio, every piece
   under the Pages limit. Its host pipeline is the work.
5. Checkpoint per segment. A 123 s job needs to survive a closed tab.
