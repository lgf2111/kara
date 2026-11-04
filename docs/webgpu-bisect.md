# WebGPU bisect: why htdemucs returns NaN

WebGPU runs this model about 3.4x realtime on an M1 against about 1.2x on WASM, so separation wants
it. It cannot have it yet: the WebGPU provider returns non-finite values and the worker refuses to
write those stems. What is known from `fixtures/generated/pipeline-results/htdemucs-webgpu-run.json`:

- the first piece to go bad is `htdemucs_p00.onnx`, at `/encoder.0/dconv/Add_output_0`
- **129024 of 8257536 values**, one part in 64. Not everything, which rules out a graph that was
  wrong from its first node
- `[1, 48, 512, 336]` is that tensor's shape, and 129024 is exactly 8 × 48 × 336
- turning graph optimisation off changes nothing (`htdemucs-webgpu-webgpu-noopt.json`)
- the inputs are clean: `magNonFinite` 0, `mixNonFinite` 0, peaks 0.86 and 0.15

This harness turns that into a named node and a named cause.

## Running it

Weights first, once. They are gitignored and never committed:

```sh
node scripts/spike/models.mjs fetch htdemucs-web
```

Then, from the repository root:

```sh
node scripts/spike/webgpu-bisect.mjs                      # all three steps
node scripts/spike/webgpu-bisect.mjs --only compare       # step 1 alone
node scripts/spike/webgpu-bisect.mjs --only nodes         # the node table, no inference
node scripts/spike/webgpu-bisect.mjs --only bisect        # step 2 alone
node scripts/spike/webgpu-bisect.mjs --only options       # step 3 alone
```

It starts the Vite dev server on port 5275, drives `/webgpu-bisect` in Playwright's Chromium with
WebGPU enabled, prints a summary and writes
`fixtures/generated/pipeline-results/webgpu-bisect-<label>.json`. Nothing is uploaded, no file of
yours is read, and the input is synthesised in the page from a seed.

Useful flags:

| Flag | What it is for |
| --- | --- |
| `--piece htdemucs_p04.onnx` | Any piece in the manifest. The pieces before it run on WASM, so both backends still see identical inputs. |
| `--gain 0.01` | A quieter input. A fault that needs a loud input is an overflow. |
| `--shape tonal` \| `silent` | `tonal` leaves the top of the spectrum at window-leakage level; `silent` leaves every bin at exactly zero. A fault that needs near-empty bins is a division by a variance that vanished. The report counts the bins that came out exactly zero. |
| `--opt all` | Optimisation stays `disabled` by default, because a tensor that is a graph output cannot be fused away and only the unoptimised graph is honestly comparable. WebGPU returns NaN there too, so nothing is given up. |
| `--seed`, `--tolerance`, `--port`, `--headed true`, `--stall`, `--label` | As they read. |

The page is also clickable at `http://localhost:5275/webgpu-bisect` after `pnpm run dev --port 5275`.

## What the three steps answer

**1. Does a fixed synthetic segment reproduce it?** Both backends get byte-identical `mix` and
`mag`, built by the real `createHtdemucsHost` framing. Every output is reported with its
non-finite count, its range over the finite values, and its worst relative difference from WASM.
`reproduced: false` is a result too: it would mean the fault needs something this input does not
have, and `--shape` and `--gain` are the next things to vary.

**2. Which node breaks first?** Intermediate tensors are added to `GraphProto.output` by a protobuf
edit in the page (`apps/web/src/diagnostics/onnx-graph.ts`), which is enough to ask
`session.run` for them. The stored node order is then binary-searched for the first output that is
non-finite on WebGPU or has drifted past the tolerance. The report names the node, its op type and
the six around it, then re-runs that one node with its own inputs exposed as well.

Read `axes` on a bad tensor before anything else. It says where the bad elements sit:

- **whole slices of one axis, all of every other axis** — dispatch, tiling or a buffer that was
  never written. ONNX Runtime reuses pooled GPU buffers without zeroing them, so an output element
  no kernel wrote keeps whatever was there and can read back as NaN.
- **spread across every axis** — arithmetic. An overflow, or a division by something that reached
  zero on one backend and not the other.

The evidence above is consistent with both until this runs: 129024 is 8 of the 512 positions along
one axis, but it is equally 384 scattered (channel, bin) pairs.

**3. Which session option changes the answer?** One row per hypothesis, each against the WASM
reference for the same input:

| Row | What a change would mean |
| --- | --- |
| optimisation disabled / basic / extended / all | A fusion is miscompiling. Already known not to be the whole story. |
| output left on the gpu | The download is corrupting, not the compute. |
| NHWC layout | The NCHW convolution path specifically. |
| no buffer cache | A pooled buffer is being reused without being written. This is the direct test for stale memory. |
| full validation | Surfaces a WebGPU error the default mode swallows. Watch the console lines in the JSON. |
| fp32 matmul accumulation | A partial sum along K saturated fp16 to Inf. ONNX Runtime documents this failure mode for its MatMulNBits kernels. |
| graph capture | Expected to fail on a graph with dynamic allocation; the error itself is the data point. |
| input at a tenth / a hundredth | Clean when quiet means overflow. |
| tonal / silent input | Clean when loud and broadband but broken when bins are near empty means a vanished variance or a lost epsilon. |
| the first bad node forced to cpu | Whether `forceCpuNodeNames` is a usable workaround: one node on the CPU, the rest of the graph still on the GPU. |
| device without shader-f16 | Clean without fp16 shaders means the fault is precision, not indexing. Inconclusive if the result does not change: ONNX Runtime may keep the device it made for itself. |

## Suspected op types

`htdemucs-web` is fp16 **except** its Conv and ConvTranspose nodes, so the graph is full of Cast
nodes and most arithmetic runs in half precision. The node table prints each Cast's target type, so
the precision boundary around the break reads straight off it.

`/encoder.0/dconv` is demucs' residual `x = x + layer(x)`, where `layer` is Conv1d, GroupNorm, GELU,
Conv1d, GroupNorm, GLU, LayerScale, applied to the frequency-encoder output reshaped from
`[1, 48, 512, 336]` to `[512, 48, 336]`. In rough order of suspicion:

1. **InstanceNormalization.** `nn.GroupNorm(1, C)` exports as Reshape, InstanceNormalization,
   Reshape, Mul, Add, and that is the only reduction inside the block. Two asymmetries meet here.
   ONNX Runtime's CPU provider has no fp16 kernel for much of this and its required
   `InsertCastTransformer` wraps those nodes in casts to fp32, which is why WASM is right and why
   turning optimisation off does not help: that transform is not an optimisation level. And
   GroupNorm's epsilon of 1e-5 is below fp16's smallest normal, 6.1e-5, so a backend that flushes
   subnormals loses it entirely and an empty frequency row becomes 0/0.
2. **Transpose and Reshape** around the block, the `[1, 48, 512, 336]` to `[512, 48, 336]` shuffle.
   This is where "whole slices of one axis are garbage" comes from most cheaply.
3. **Conv**, both the 8×1 stride-4 encoder convolution over 2048 frequency bins and the 1-D convs
   inside the block expressed with a degenerate axis. The tiled paths are chosen by shape and are
   where tail handling goes wrong.
4. **The head normalisation**, a mean and standard deviation over 2.75M elements. If any of it is
   fp16 the sum of squares passes 65504 immediately. The bisect would land near node 0, not inside
   `encoder.0`, so step 2 tells these apart in one run.
5. **Erf**, the unfused GELU. Lower odds, but it is in the window.

## Caveats, so the output is not over-read

- Exposing a tensor as a graph output changes the graph: it cannot be fused away or computed in
  place. The bisect runs with optimisation disabled, where there was nothing to fuse, and the full
  optimisation levels are measured separately in step 3.
- The search assumes a bad output stays bad down the stored node order. That holds along one chain,
  and every probe is listed in the report so a break in the assumption is visible.
- An added output is declared without a type, so ONNX Runtime infers it the way it does for any
  intermediate. This graph is mixed precision and declaring one type for everything would be wrong.
  If a probe will not load that way it is retried as float32 and then as float16, and `exposedAs`
  on each probe says which declaration the numbers came from.
- The synthetic input is not the tone fixture the production run used. Its peaks are reported next
  to that run's, and `--shape` and `--gain` exist because the difference may matter.
- A clean WASM reference is assumed, not proved. It is the backend the product ships on and its
  stems sum back to the mixture, which is the check the worker already makes.

## Where the code is

| Path | What it holds |
| --- | --- |
| `apps/web/src/diagnostics/onnx-graph.ts` | Minimal ONNX protobuf: list nodes, add graph outputs. No dependency. |
| `apps/web/src/diagnostics/tensor-stats.ts` | Finiteness, ranges, where the bad elements sit, divergence. |
| `apps/web/src/diagnostics/synthetic-segment.ts` | The deterministic input. |
| `apps/web/src/diagnostics/webgpu-bisect.ts` | Sessions, probes, the search, the option matrix. |
| `apps/web/src/webgpu-bisect-main.ts` | The page, and `window.karaBisect`. |
| `scripts/spike/webgpu-bisect.mjs` | The Playwright driver. |

The production worker is untouched and still refuses WebGPU. Lifting that is a separate change,
and it needs this evidence first.
