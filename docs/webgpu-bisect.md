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

## The answer: fp16 ReduceMean returns zero

**`ReduceMean` is the op.** Measured, from
`fixtures/generated/pipeline-results/webgpu-bisect-report.json`:

| Tensor | What it is | WASM | WebGPU |
| --- | --- | --- | --- |
| `/Pow_1_output_0` | the 687960 squares, fp16 | mean abs 0.069624 | mean abs **0.069625** |
| `/Clip_1_output_0` | `Clip(ReduceMean(squares), 0)` | 0.06958 | **0** |
| `/Sqrt_1_output_0` | the standard deviation | 0.263916 | **0** |
| `/Add_1_output_0` | `std + 1e-5` | 0.263916 | **1e-5** |
| `/Unsqueeze_3_output_0` | `ReduceMean(mix)`, no Pow or Clip on its path | 1e-4 | **0** |

The squares are right to five figures on the GPU, so Pow is not it. Clip is handed something that
is already zero or worse, and the plain mean of `mix` reaches zero with no Clip and no Pow anywhere
on its path, so Clip is not it either. Both reductions return exactly zero. `Div` then divides the
centred signal by the bare epsilon, which is where ±65000 comes from, and why the result scales
with the input gain instead of saturating: gain 1 gives 65472, 0.1 gives 7632, 0.01 gives 762. The
divisor is fixed at 1e-5 and only the numerator moves.

Exactly zero, rather than a saturated or stalled partial sum, is the part that names the mechanism.
A mean is a sum over an element count, and **the element counts here are not representable in
fp16**: 2 × 343980 = 687960 and 4 × 2048 × 336 = 2752512, both past fp16's largest finite value of
65504. A divisor that rounds to infinity makes any mean exactly zero whatever the sum was.

That reading predicts which reductions survive, and the same report confirms it. All four
reductions in the head normalisation exceed 65504 elements and all four come back zero. The two
`InstanceNormalization` nodes inside `encoder.0/dconv` reduce 2016 and 32256 elements, both exactly
representable in fp16, and neither produces zero: the non-finite values in
`/encoder.0/dconv/Add_output_0` are the head's ±65000 carried downstream, not a second fault.

The bisection could not say this on its own, for a reason worth keeping: it stops at the first
output that is non-finite, and the four tensors before `Div` are finite and merely wrong. They are
also tensors of one element, which the divergence verdict used to treat as a sample too small to
fail. Both are fixed — `verdictFor` now fails a tensor whose every element drifted — and the
`island` step below reports all eight island tensors at once so nothing has to be inferred.

## The float32 island patch

`apps/web/src/diagnostics/onnx-fp32-island.ts` rewrites each island to compute in float32:

- one `Cast(to=float32)` on the island input, shared between islands that normalise the same tensor
- `ReduceMean`, `Sub`, `Pow`, `ReduceMean`, `Clip`, `Sqrt`, `Add` and `Div` rebuilt on float32
  tensors under a suffixed name, attributes copied as bytes so `axes` keeps its encoding
- every island tensor that something outside the island reads cast back to the elem_type the graph
  declared for it, so the mean, the standard deviation and the normalised signal re-enter the graph
  as fp16 and the piece's inputs and outputs are the same contract as before
- the constants, the exponent two and the epsilon, converted by a Cast each rather than re-encoded,
  so the rewrite computes with the values the model holds and not with rounder ones
- `value_info` for the five tensors nothing outside reads removed, because nothing produces them now

The island is matched through the data flow, not by index or name: the producer of the Pow's input
has to be a Sub, the Sub's second input has to be a ReduceMean of the Sub's first input, both
reductions have to be over the same axes, and the Div has to divide the centred tensor. `Clip` is
optional. Two islands in one graph are both rewritten, and a third anywhere else would be too.
An island already in float32 is left alone and reported under `skipped`.

`patchNormalisationIslands(bytes)` is pure: the model bytes in, new bytes out, the input untouched.
`apps/web/test/onnx-fp32-island.test.ts` checks it on a synthetic eight-node graph, including that
the result stays topological, that every tensor has one producer, that nothing declared is missing
and that nothing outside the island changed name or type.

## Running it

Weights first, once. They are gitignored and never committed:

```sh
node scripts/spike/models.mjs fetch htdemucs-web
```

Then, from the repository root:

```sh
node scripts/spike/webgpu-bisect.mjs                      # all four steps
node scripts/spike/webgpu-bisect.mjs --only compare       # step 1 alone
node scripts/spike/webgpu-bisect.mjs --only nodes         # the node table, no inference
node scripts/spike/webgpu-bisect.mjs --only island        # the normalisation, both backends
node scripts/spike/webgpu-bisect.mjs --only bisect        # step 2 alone
node scripts/spike/webgpu-bisect.mjs --only options       # step 3 alone
node scripts/spike/webgpu-bisect.mjs --patch              # with the float32 island
```

It starts the Vite dev server on port 5275, drives `/webgpu-bisect` in Playwright's Chromium with
WebGPU enabled, prints a summary and writes
`fixtures/generated/pipeline-results/webgpu-bisect-<label>.json`. Nothing is uploaded, no file of
yours is read, and the input is synthesised in the page from a seed.

Useful flags:

| Flag | What it is for |
| --- | --- |
| `--patch` | WebGPU gets the piece with its normalisation islands rebuilt in float32. WASM still gets the piece as it ships, so the comparison is the rewrite against the reference and not against itself. Every declared output is reported with its worst relative difference and its non-finite count, and `--only report --patch` runs the unpatched comparison too, so one file holds the before and the after for the same input and machine. The label defaults to `<step>-patched`. |
| `--only island` | Every tensor of every normalisation island on both backends, with the island's axes and the number of elements each reduction covers. This is the step that names the op: a bisection stops at the first non-finite output, and the statistics before it are finite, wrong, and one element each. |
| `--piece htdemucs_p04.onnx` | Any piece in the manifest. The pieces before it run on WASM, so both backends still see identical inputs. |
| `--gain 0.01` | A quieter input. A fault that needs a loud input is an overflow. |
| `--shape tonal` \| `silent` | `tonal` leaves the top of the spectrum at window-leakage level; `silent` leaves every bin at exactly zero. A fault that needs near-empty bins is a division by a variance that vanished. The report counts the bins that came out exactly zero. |
| `--opt all` | Optimisation stays `disabled` by default, because a tensor that is a graph output cannot be fused away and only the unoptimised graph is honestly comparable. WebGPU returns NaN there too, so nothing is given up. |
| `--seed`, `--tolerance`, `--port`, `--headed true`, `--stall`, `--label` | As they read. |

The page is also clickable at `http://localhost:5275/webgpu-bisect` after `pnpm run dev --port 5275`,
and has a second row of buttons for the patched run.

One thing `--patch` does not change: `--only bisect --patch` probes the rewritten graph on **both**
backends, because a probe exposes one tensor by name and the island's internal tensors only exist
under their suffixed names there. `compare`, `island` and `options` all keep WASM on the unpatched
piece.

## What the steps answer

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

**3. Which op of the normalisation is wrong?** `--only island`. The bisection answers "which node
is the first to go non-finite", which is a different question from "which node is the first to be
wrong", and in this graph four nodes sit between the two: the mean, the variance, the clipped
variance and the standard deviation are all finite and all zero on WebGPU before the Div turns that
into ±65000. They are also tensors of one element each. So this step exposes all eight island
tensors as graph outputs in one run and reports both backends on every one of them, next to the
island's axes and the number of elements its reductions cover. Nothing in it is a search, so there
is nothing to read into where it stopped.

**4. Which session option changes the answer?** One row per hypothesis, each against the WASM
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

**5. Does the float32 island fix it?** `--patch` answers that over every declared output of the
piece rather than over the node that used to break, because a fix that moves the fault one node
downstream is not a fix. The summary leads with the worst relative difference against WASM across
all outputs and the list of outputs holding a non-finite value, then prints the per-tensor lines.
If another island diverges once this one is right, the patch already covers it: it is written
against the pattern, not against these two instances.

## Suspected op types

`htdemucs-web` is fp16 **except** its Conv and ConvTranspose nodes, so the graph is full of Cast
nodes and most arithmetic runs in half precision. The node table prints each Cast's target type, so
the precision boundary around the break reads straight off it, along with every node's attributes
and the value of every initializer small enough to be a constant rather than a weight.

The list below is what the suspicion was before the run. It is kept because the shape of the
reasoning still applies to the next piece; the answer for this one is at the top of this file, and
it is item 4.

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
- The patched graph is a different graph. It loads and runs on the WASM backend and agrees with the
  unpatched piece there to within fp16 rounding, which is the check that it is still the same
  computation, but an ONNX Runtime that accepts it today is not a promise about every version. If a
  patched run fails to load, the error is the data point and `--only nodes --patch` prints the graph
  it was handed.
- The rewrite computes the island in float32 and then casts back to float16 at the island's edge.
  That is on purpose: it reproduces the reference's precision instead of improving on it, so a
  remaining difference against WASM is a real difference and not the patch being better. It also
  means the patch is not a performance argument for float32 anywhere else in the graph.

## Where the code is

| Path | What it holds |
| --- | --- |
| `apps/web/src/diagnostics/onnx-graph.ts` | Minimal ONNX protobuf: list nodes with their attributes, read small initializers, collect declared types, add graph outputs, rebuild a graph field by field. No dependency. |
| `apps/web/src/diagnostics/onnx-fp32-island.ts` | Finds the normalisation islands and rewrites them in float32. Pure, on the model bytes. |
| `apps/web/src/diagnostics/tensor-stats.ts` | Finiteness, ranges, where the bad elements sit, divergence. |
| `apps/web/src/diagnostics/synthetic-segment.ts` | The deterministic input. |
| `apps/web/src/diagnostics/webgpu-bisect.ts` | Sessions, probes, the island step, the search, the option matrix. |
| `apps/web/src/webgpu-bisect-main.ts` | The page, and `window.karaBisect`. |
| `scripts/spike/webgpu-bisect.mjs` | The Playwright driver. |
| `apps/web/test/onnx-fp32-island.test.ts` | The rewrite on a synthetic eight-node graph. |

The production worker is untouched and still refuses WebGPU. Lifting that is a separate change: it
needs a patched run that is clean on every output of every piece, and then a decision about where
the rewrite belongs, because loading a rewritten model in the worker is not the same risk as
loading one in a diagnostic page.
