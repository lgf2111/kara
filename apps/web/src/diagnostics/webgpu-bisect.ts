import * as ort from 'onnxruntime-web/webgpu';

import {
  patchNormalisationIslands,
  type IslandPatch,
  type PatchedIsland,
  type SkippedIsland,
} from './onnx-fp32-island.ts';
import {
  ELEM_TYPES,
  attributeText,
  exposableOutput,
  exposeOutputs,
  opTypeHistogram,
  summariseGraph,
  type GraphSummary,
} from './onnx-graph.ts';
import { syntheticSegment, type SegmentShape, type SyntheticSegment } from './synthetic-segment.ts';
import {
  FP16_MAX,
  axisProfile,
  divergence,
  tensorStats,
  toFloat32,
  verdictFor,
  type AxisProfile,
  type Divergence,
  type TensorStats,
  type Verdict,
} from './tensor-stats.ts';

/**
 * Why htdemucs returns NaN on WebGPU and the right numbers on WASM.
 *
 * Three questions, in the order they depend on each other:
 *
 * 1. Does a fixed synthetic segment reproduce it? The same bytes go to both
 *    backends and every output is reported for finiteness and range.
 * 2. Which node breaks first? Intermediate tensors are added to the graph's
 *    outputs by a protobuf edit (onnx-graph.ts) and the stored node order is
 *    binary-searched for the first output that is non-finite on WebGPU, or has
 *    drifted from WASM past the tolerance.
 * 3. Which session option changes the answer? Optimisation level, output
 *    location, layout, buffer cache, a device with no `shader-f16`, the
 *    suspect node forced to CPU, and the input level.
 *
 * Nothing here runs in the product. The production worker still refuses
 * WebGPU; this is the evidence for whether that refusal can be lifted.
 */

const WEIGHTS = '/weights/htdemucs-web';

ort.env.wasm.wasmPaths = '/spike-ort/';
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);

export type Optimisation = 'disabled' | 'basic' | 'extended' | 'all';
export type Backend = 'wasm' | 'webgpu';

export interface Hypothesis {
  readonly name: string;
  readonly backend: Backend;
  readonly optimisation?: Optimisation;
  readonly preferredLayout?: 'NCHW' | 'NHWC';
  readonly bufferCache?: 'disabled' | 'lazyRelease' | 'simple' | 'bucket';
  readonly validation?: 'disabled' | 'wgpuOnly' | 'basic' | 'full';
  readonly outputLocation?: 'cpu' | 'gpu-buffer';
  /** ONNX node names to keep on the CPU inside an otherwise WebGPU session. */
  readonly forceCpuNodeNames?: readonly string[];
  readonly matmulFp32Accumulation?: boolean;
  readonly graphCapture?: boolean;
  /** Hand ORT a device with no optional features, so no fp16 shaders. */
  readonly withoutShaderF16?: boolean;
  /** Scales the synthetic input. A fault that needs a loud input is overflow. */
  readonly gain?: number;
  /** What the input is made of. See SegmentShape. */
  readonly shape?: SegmentShape;
}

interface PieceSpec {
  readonly file: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

interface SplitManifest {
  readonly pieces: readonly PieceSpec[];
}

interface Captured {
  readonly name: string;
  readonly type: string;
  readonly dims: readonly number[];
  readonly location: string;
  readonly values: Float32Array;
}

function phase(name: string, detail?: unknown): void {
  console.log(`[bisect] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  const hook = (globalThis as unknown as Record<string, unknown>)['karaPhase'];
  if (typeof hook === 'function') {
    (hook as (name: string, detail?: unknown) => void)(name, detail);
  }
}

function round(value: number | null, digits = 6): number | null {
  return value === null || !Number.isFinite(value) ? value : Number(value.toFixed(digits));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

// --- WebGPU, typed structurally because @webgpu/types is not a dependency ---

/** What ORT will take as its device, whether or not @webgpu/types is around. */
type WebGpuDevice = NonNullable<ort.InferenceSession.WebGpuExecutionProviderOption['device']>;

interface DeviceLike {
  readonly features?: Iterable<string>;
}

interface AdapterLike {
  readonly info?: Readonly<Record<string, unknown>>;
  readonly features?: Iterable<string>;
  readonly limits?: Readonly<Record<string, unknown>>;
  requestDevice(descriptor?: {
    requiredFeatures?: readonly string[];
    requiredLimits?: Readonly<Record<string, number>>;
  }): Promise<DeviceLike>;
}

function gpu(): { requestAdapter: () => Promise<AdapterLike | null> } | undefined {
  return (navigator as unknown as { gpu?: { requestAdapter: () => Promise<AdapterLike | null> } }).gpu;
}

const ADAPTER_INFO_KEYS = ['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'];
const LIMIT_KEYS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupsPerDimension',
];

/** GPUAdapterInfo and GPUSupportedLimits keep their values on the prototype. */
function pick(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown> | undefined)?.[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function featureList(features: Iterable<string> | undefined): readonly string[] {
  return features === undefined ? [] : [...features].sort();
}

let plainDevice: WebGpuDevice | null = null;

/**
 * A device requested with no optional features, so without `shader-f16`. ORT
 * asks for that feature whenever the adapter offers it, and this model is fp16
 * apart from its convolutions, so the device is the switch for the whole
 * precision hypothesis. The limits are taken from the adapter, so only the
 * feature differs from the device ORT would have made for itself.
 */
async function deviceWithoutShaderF16(): Promise<WebGpuDevice> {
  if (plainDevice !== null) {
    return plainDevice;
  }
  const adapter = await gpu()?.requestAdapter();
  if (adapter === undefined || adapter === null) {
    throw new Error('no WebGPU adapter, so no device to request');
  }
  const limits: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const value = (adapter.limits as Record<string, unknown> | undefined)?.[key];
    if (typeof value === 'number') {
      limits[key] = value;
    }
  }
  const device: DeviceLike = await adapter.requestDevice({
    requiredFeatures: [],
    requiredLimits: limits,
  });
  phase('device-without-shader-f16', { features: featureList(device.features) });
  plainDevice = device as WebGpuDevice;
  return plainDevice;
}

// --- sessions ---

async function sessionOptions(hypothesis: Hypothesis): Promise<ort.InferenceSession.SessionOptions> {
  const level = hypothesis.optimisation ?? 'disabled';
  if (hypothesis.backend === 'wasm') {
    return { executionProviders: ['wasm'], graphOptimizationLevel: level };
  }
  const device = hypothesis.withoutShaderF16 === true ? await deviceWithoutShaderF16() : undefined;
  const webgpu: ort.InferenceSession.WebGpuExecutionProviderOption = {
    name: 'webgpu',
    ...(hypothesis.preferredLayout === undefined ? {} : { preferredLayout: hypothesis.preferredLayout }),
    ...(hypothesis.bufferCache === undefined
      ? {}
      : {
          storageBufferCacheMode: hypothesis.bufferCache,
          defaultBufferCacheMode: hypothesis.bufferCache,
        }),
    ...(hypothesis.validation === undefined ? {} : { validationMode: hypothesis.validation }),
    ...(hypothesis.forceCpuNodeNames === undefined
      ? {}
      : { forceCpuNodeNames: hypothesis.forceCpuNodeNames }),
    ...(hypothesis.matmulFp32Accumulation === undefined
      ? {}
      : { enableMatmulFp32Accumulation: hypothesis.matmulFp32Accumulation }),
    ...(device === undefined ? {} : { device }),
  };
  return {
    executionProviders: [webgpu],
    graphOptimizationLevel: level,
    ...(hypothesis.outputLocation === undefined
      ? {}
      : { preferredOutputLocation: hypothesis.outputLocation }),
    ...(hypothesis.graphCapture === undefined ? {} : { enableGraphCapture: hypothesis.graphCapture }),
  };
}

interface RunOutcome {
  readonly captured: readonly Captured[];
  readonly createMs: number;
  readonly runMs: number;
}

async function runPiece(
  model: Uint8Array,
  hypothesis: Hypothesis,
  feeds: Readonly<Record<string, ort.Tensor>>,
  fetches: readonly string[] | null,
): Promise<RunOutcome> {
  const options = await sessionOptions(hypothesis);
  const createAt = performance.now();
  const session = await ort.InferenceSession.create(model, options);
  const createMs = performance.now() - createAt;
  try {
    const runAt = performance.now();
    const outputs =
      fetches === null ? await session.run(feeds) : await session.run(feeds, [...fetches]);
    const runMs = performance.now() - runAt;
    const captured: Captured[] = [];
    for (const [name, tensor] of Object.entries(outputs)) {
      captured.push({
        name,
        type: tensor.type,
        dims: [...tensor.dims],
        location: tensor.location,
        // A tensor left on the GPU has to be pulled down explicitly, which is
        // itself worth testing: it is a different path out of the backend.
        values: tensor.location === 'cpu' ? toFloat32(tensor.data) : toFloat32(await tensor.getData(true)),
      });
    }
    return { captured, createMs, runMs };
  } finally {
    await session.release();
  }
}

/** A chain step: raw tensors, so an fp16 intermediate stays fp16. */
async function runOnWasm(
  model: Uint8Array,
  feeds: Readonly<Record<string, ort.Tensor>>,
): Promise<ort.InferenceSession.ReturnType> {
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  try {
    return await session.run(feeds);
  } finally {
    await session.release();
  }
}

// --- model and manifest, fetched once ---

let manifestCache: SplitManifest | null = null;
const pieceCache = new Map<string, Uint8Array>();

async function manifest(): Promise<SplitManifest> {
  if (manifestCache !== null) {
    return manifestCache;
  }
  const response = await fetch(`${WEIGHTS}/htdemucs_split_manifest.json`);
  if (!response.ok) {
    throw new Error(`manifest ${String(response.status)}: run scripts/spike/models.mjs fetch`);
  }
  manifestCache = (await response.json()) as SplitManifest;
  return manifestCache;
}

async function pieceBytes(file: string): Promise<Uint8Array> {
  const cached = pieceCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetch(`${WEIGHTS}/${file}`);
  if (!response.ok) {
    throw new Error(`${file} ${String(response.status)}: run scripts/spike/models.mjs fetch`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  pieceCache.set(file, bytes);
  return bytes;
}

const patchCache = new Map<string, IslandPatch>();

/** The piece with its float16 normalisation islands rebuilt in float32. */
async function patchedPiece(file: string): Promise<IslandPatch> {
  const cached = patchCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const patch = patchNormalisationIslands(await pieceBytes(file));
  patchCache.set(file, patch);
  phase('patch', {
    piece: file,
    islands: patch.islands.length,
    skipped: patch.skipped.length,
    bytes: patch.bytes.length,
  });
  return patch;
}

/**
 * The two models a run compares.
 *
 * WASM always gets the piece as it ships: the point of `--patch` is to ask
 * whether the rewrite makes WebGPU agree with the reference, not to move the
 * reference. `renames` maps an island tensor to the name the candidate
 * produces it under, so a probe can be paired back up by its original name.
 */
interface Models {
  readonly reference: Uint8Array;
  readonly candidate: Uint8Array;
  readonly patch: IslandPatch | null;
  readonly renames: Readonly<Record<string, string>>;
}

async function modelsFor(file: string, patch: boolean): Promise<Models> {
  const reference = await pieceBytes(file);
  if (!patch) {
    return { reference, candidate: reference, patch: null, renames: {} };
  }
  const patched = await patchedPiece(file);
  const renames: Record<string, string> = {};
  for (const island of patched.islands) {
    Object.assign(renames, island.renames);
  }
  return { reference, candidate: patched.bytes, patch: patched, renames };
}

// --- feeds ---

export interface PrefixStep {
  readonly file: string;
  readonly nonFinite: number;
}

interface Feeds {
  readonly tensors: Readonly<Record<string, ort.Tensor>>;
  readonly prefix: readonly PrefixStep[];
}

/**
 * One piece's inputs. `htdemucs_p00.onnx` takes the segment itself; a later
 * piece takes intermediates, so the pieces before it run on WASM, the backend
 * known to be right, and both backends then see identical tensors.
 */
async function feedsFor(file: string, segment: SyntheticSegment): Promise<Feeds> {
  const split = await manifest();
  const target = split.pieces.find((piece) => piece.file === file);
  if (target === undefined) {
    throw new Error(`no piece named ${file} in the manifest`);
  }

  const live = new Map<string, ort.Tensor>([
    ['mix', new ort.Tensor('float32', segment.mix, [...segment.mixDims])],
    ['mag', new ort.Tensor('float32', segment.mag, [...segment.magDims])],
  ]);
  const prefix: PrefixStep[] = [];

  for (const piece of split.pieces) {
    if (piece.file === file || target.inputs.every((name) => live.has(name))) {
      break;
    }
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of piece.inputs) {
      const tensor = live.get(name);
      if (tensor === undefined) {
        throw new Error(`piece ${piece.file} wants ${name}, which nothing earlier produced`);
      }
      feeds[name] = tensor;
    }
    phase('prefix', { piece: piece.file });
    const outputs = await runOnWasm(await pieceBytes(piece.file), feeds);
    let nonFinite = 0;
    for (const [name, tensor] of Object.entries(outputs)) {
      nonFinite += tensorStats(toFloat32(tensor.data)).nonFinite;
      live.set(name, tensor);
    }
    prefix.push({ file: piece.file, nonFinite });
  }

  const tensors: Record<string, ort.Tensor> = {};
  for (const name of target.inputs) {
    const tensor = live.get(name);
    if (tensor === undefined) {
      throw new Error(`cannot build ${name} for ${file} from the manifest chain`);
    }
    tensors[name] = tensor;
  }
  return { tensors, prefix };
}

// --- comparison ---

export interface TensorComparison {
  readonly name: string;
  readonly type: string;
  readonly dims: readonly number[];
  readonly location: string;
  readonly reference: TensorStats;
  readonly candidate: TensorStats;
  /** Only when something is non-finite: where the bad elements sit. */
  readonly axes: readonly AxisProfile[];
  readonly drift: Divergence;
  readonly verdict: Verdict;
  /** A finite value within a factor of two of fp16's ceiling. */
  readonly nearFp16Max: boolean;
}

function trim(stats: TensorStats): TensorStats {
  return {
    ...stats,
    min: round(stats.min),
    max: round(stats.max),
    meanAbs: round(stats.meanAbs),
    peak: round(stats.peak),
  };
}

function compareTensors(
  reference: Captured,
  candidate: Captured,
  tolerance: number,
  name = candidate.name,
): TensorComparison {
  const referenceStats = tensorStats(reference.values);
  const candidateStats = tensorStats(candidate.values);
  const drift = divergence(reference.values, candidate.values, tolerance);
  return {
    name,
    type: candidate.type,
    dims: candidate.dims,
    location: candidate.location,
    reference: trim(referenceStats),
    candidate: trim(candidateStats),
    axes: candidateStats.nonFinite > 0 ? axisProfile(candidate.values, candidate.dims) : [],
    drift: { ...drift, maxAbs: round(drift.maxAbs) ?? 0, maxRel: round(drift.maxRel) ?? 0 },
    verdict: verdictFor(candidateStats, drift, tolerance),
    nearFp16Max:
      (candidateStats.peak ?? 0) >= FP16_MAX / 2 || (referenceStats.peak ?? 0) >= FP16_MAX / 2,
  };
}

/**
 * Reference and candidate tensors side by side, reported under the reference's
 * names. `renames` is for a patched candidate, whose rebuilt island tensors
 * carry a suffix: the pair is still the same quantity, so it is still worth
 * comparing, and the original name is the one worth printing.
 */
function pairUp(
  reference: readonly Captured[],
  candidate: readonly Captured[],
  tolerance: number,
  renames: Readonly<Record<string, string>> = {},
): readonly TensorComparison[] {
  const byName = new Map(candidate.map((item) => [item.name, item]));
  const out: TensorComparison[] = [];
  for (const item of reference) {
    const found = byName.get(renames[item.name] ?? item.name) ?? byName.get(item.name);
    if (found !== undefined) {
      out.push(compareTensors(item, found, tolerance, item.name));
    }
  }
  return out;
}

function worstOf(comparisons: readonly TensorComparison[]): Verdict {
  if (comparisons.length === 0) {
    return 'failed';
  }
  if (comparisons.some((item) => item.verdict === 'non-finite')) {
    return 'non-finite';
  }
  if (comparisons.some((item) => item.verdict === 'diverged')) {
    return 'diverged';
  }
  return 'clean';
}

// --- the page's API ---

export interface BisectOptions {
  readonly piece?: string;
  readonly seed?: number;
  readonly gain?: number;
  readonly shape?: SegmentShape;
  readonly tolerance?: number;
  readonly optimisation?: Optimisation;
  /** Give WebGPU the piece with its normalisation islands rebuilt in float32. */
  readonly patch?: boolean;
}

export interface Settled {
  readonly piece: string;
  readonly seed: number;
  readonly gain: number;
  readonly shape: SegmentShape;
  readonly tolerance: number;
  readonly optimisation: Optimisation;
  readonly patch: boolean;
}

function settle(input: BisectOptions): Settled {
  return {
    piece: input.piece ?? 'htdemucs_p00.onnx',
    seed: input.seed ?? 1337,
    gain: input.gain ?? 1,
    shape: input.shape ?? 'mixed',
    tolerance: input.tolerance ?? 1e-2,
    patch: input.patch ?? false,
    // Off by default: a tensor that is a graph output cannot be fused away, so
    // the only honest regime for a bisection is one where there was nothing to
    // fuse. WebGPU returns NaN with optimisation disabled too, so nothing is
    // given up by working here.
    optimisation: input.optimisation ?? 'disabled',
  };
}

export async function environment(): Promise<Record<string, unknown>> {
  const adapter = await gpu()?.requestAdapter();
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    crossOriginIsolated,
    ort: { ...ort.env.versions },
    wasmThreads: ort.env.wasm.numThreads ?? null,
    adapter: adapter === undefined || adapter === null ? null : pick(adapter.info, ADAPTER_INFO_KEYS),
    adapterFeatures: featureList(adapter?.features),
    adapterLimits: pick(adapter?.limits, LIMIT_KEYS),
  };
}

export interface NodeRow {
  readonly index: number;
  readonly name: string;
  readonly opType: string;
  readonly output: string | null;
  /** Cast's target type, so a precision boundary reads off the table. */
  readonly castTo: string | null;
  /** Every attribute as text: a reduction's axes, a norm's epsilon. */
  readonly attributes: string;
}

function tableOf(summary: GraphSummary): readonly NodeRow[] {
  return summary.nodes.map((node) => ({
    index: node.index,
    name: node.name,
    opType: node.opType,
    output: exposableOutput(node),
    castTo: node.castTo === null ? null : (ELEM_TYPES[node.castTo] ?? String(node.castTo)),
    attributes: node.attributes.map(attributeText).join(' '),
  }));
}

/** A small initializer with its value: an epsilon, an exponent, a clip bound. */
export interface ConstantRow {
  readonly name: string;
  readonly type: string;
  readonly dims: readonly number[];
  readonly values: readonly number[];
}

function constantsOf(summary: GraphSummary): readonly ConstantRow[] {
  const out: ConstantRow[] = [];
  for (const initializer of summary.initializers) {
    if (initializer.values === null || initializer.values.length === 0) {
      continue;
    }
    out.push({
      name: initializer.name,
      type: ELEM_TYPES[initializer.elemType] ?? String(initializer.elemType),
      dims: initializer.dims,
      values: initializer.values,
    });
  }
  return out;
}

export interface GraphReport {
  readonly piece: string;
  readonly count: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly opTypes: Readonly<Record<string, number>>;
  readonly initializerTypes: Readonly<Record<string, number>>;
  readonly initializerBytes: number;
  readonly constants: readonly ConstantRow[];
  readonly rows: readonly NodeRow[];
}

export async function nodes(input: BisectOptions = {}): Promise<GraphReport> {
  const settled = settle(input);
  const models = await modelsFor(settled.piece, settled.patch);
  const summary = summariseGraph(models.candidate);
  return {
    piece: settled.piece,
    count: summary.nodes.length,
    inputs: summary.inputs,
    outputs: summary.outputs,
    opTypes: opTypeHistogram(summary.nodes),
    initializerTypes: summary.initializerTypes,
    initializerBytes: summary.initializerBytes,
    constants: constantsOf(summary),
    rows: tableOf(summary),
  };
}

export interface CompareReport {
  readonly piece: string;
  readonly input: Record<string, unknown>;
  readonly prefix: readonly PrefixStep[];
  readonly wasmMs: number;
  readonly webgpuMs: number;
  readonly outputs: readonly TensorComparison[];
  readonly reproduced: boolean;
  /** Whether WebGPU ran the float32 rewrite. WASM never does. */
  readonly patched: boolean;
  /** Worst relative difference over every declared output, patched or not. */
  readonly worstRelative: number;
  readonly worstRelativeAt: string | null;
  readonly nonFiniteOutputs: readonly string[];
}

/** The two headline numbers, over every output rather than one node. */
function roundUp(outputs: readonly TensorComparison[]): {
  worstRelative: number;
  worstRelativeAt: string | null;
  nonFiniteOutputs: readonly string[];
} {
  let worstRelative = 0;
  let worstRelativeAt: string | null = null;
  const nonFiniteOutputs: string[] = [];
  for (const output of outputs) {
    if (output.candidate.nonFinite > 0) {
      nonFiniteOutputs.push(output.name);
    }
    if (output.drift.maxRel > worstRelative) {
      worstRelative = output.drift.maxRel;
      worstRelativeAt = output.name;
    }
  }
  return { worstRelative, worstRelativeAt, nonFiniteOutputs };
}

/** Step one: the piece's declared outputs on both backends, same input. */
export async function compare(input: BisectOptions = {}): Promise<CompareReport> {
  const settled = settle(input);
  const segment = syntheticSegment(settled.seed, settled.gain, settled.shape);
  const models = await modelsFor(settled.piece, settled.patch);
  const feeds = await feedsFor(settled.piece, segment);

  phase('compare-wasm', { piece: settled.piece });
  const wasm = await runPiece(
    models.reference,
    { name: 'wasm', backend: 'wasm', optimisation: settled.optimisation },
    feeds.tensors,
    null,
  );
  phase('compare-webgpu', { piece: settled.piece, patched: settled.patch });
  const webgpu = await runPiece(
    models.candidate,
    { name: 'webgpu', backend: 'webgpu', optimisation: settled.optimisation },
    feeds.tensors,
    null,
  );

  // The piece's declared outputs keep their names through the rewrite, so this
  // is every output of the piece and not only the node that broke.
  const outputs = pairUp(wasm.captured, webgpu.captured, settled.tolerance, models.renames);
  return {
    piece: settled.piece,
    input: {
      seed: settled.seed,
      gain: settled.gain,
      shape: settled.shape,
      mixPeak: round(segment.mixPeak),
      magPeak: round(segment.magPeak),
      emptyBins: segment.emptyBins,
      magDims: segment.magDims,
    },
    prefix: feeds.prefix,
    wasmMs: Math.round(wasm.runMs),
    webgpuMs: Math.round(webgpu.runMs),
    outputs,
    reproduced: outputs.some((output) => output.verdict !== 'clean'),
    patched: settled.patch,
    ...roundUp(outputs),
  };
}

// --- the normalisation island ---

export interface IslandRow {
  readonly role: string;
  readonly nodeIndex: number;
  readonly nodeName: string;
  readonly opType: string;
  readonly output: string;
}

export interface IslandSummary {
  readonly input: string;
  readonly inputType: string;
  readonly axes: readonly number[];
  readonly keepDims: number | null;
  readonly steps: readonly IslandRow[];
  /** Elements each reduction sums, which is the headroom question in fp16. */
  readonly reduced: number | null;
  readonly boundary: readonly string[];
  readonly internal: readonly string[];
  readonly reason: string | null;
}

export interface IslandReport {
  readonly piece: string;
  readonly patched: boolean;
  readonly suffix: string;
  readonly islands: readonly IslandSummary[];
  readonly tensors: readonly TensorComparison[];
  readonly note: string;
}

function islandRows(island: PatchedIsland | SkippedIsland, reduced: number | null): IslandSummary {
  const patchedIsland = 'boundary' in island ? island : null;
  return {
    input: island.input,
    inputType:
      island.inputElemType === null
        ? 'undeclared'
        : (ELEM_TYPES[island.inputElemType] ?? String(island.inputElemType)),
    axes: island.axes,
    keepDims: island.keepDims,
    steps: island.steps.map((step) => ({
      role: step.role,
      nodeIndex: step.nodeIndex,
      nodeName: step.nodeName,
      opType: step.opType,
      output: step.output,
    })),
    reduced,
    boundary: patchedIsland?.boundary.map((item) => item.tensor) ?? [],
    internal: patchedIsland?.internal ?? [],
    reason: 'reason' in island ? island.reason : null,
  };
}

/**
 * Every tensor of every normalisation island, on both backends.
 *
 * This is the step that names the op rather than the chain. A bisection stops
 * at the first node whose output is non-finite, and in this graph that is the
 * Div: the reduction that fed it returned a finite wrong number, and a
 * standard deviation is a tensor of one element, which no sampling verdict can
 * speak for. Asking for all eight at once leaves nothing to infer.
 *
 * With `patch`, WebGPU runs the float32 rewrite and WASM still runs the piece
 * as it ships, so the two columns are the rewrite against the reference.
 */
export async function island(input: BisectOptions = {}): Promise<IslandReport> {
  const settled = settle(input);
  const segment = syntheticSegment(settled.seed, settled.gain, settled.shape);
  const models = await modelsFor(settled.piece, settled.patch);
  const patch = await patchedPiece(settled.piece);
  const feeds = await feedsFor(settled.piece, segment);

  const all = [...patch.islands, ...patch.skipped];
  const wanted: string[] = [];
  for (const found of all) {
    for (const step of found.steps) {
      if (step.output !== '') {
        wanted.push(step.output);
      }
    }
  }
  if (wanted.length === 0) {
    return {
      piece: settled.piece,
      patched: settled.patch,
      suffix: patch.suffix,
      islands: [],
      tensors: [],
      note: 'no normalisation island in this piece',
    };
  }

  /** Already an output of this graph, so adding it again would declare it twice. */
  const toExpose = (bytes: Uint8Array, names: readonly string[]): readonly string[] => {
    const declared = new Set(summariseGraph(bytes).outputs);
    return names.filter((name) => !declared.has(name));
  };

  phase('island-wasm', { piece: settled.piece, tensors: wanted.length });
  const wasm = await runPiece(
    exposeOutputs(models.reference, toExpose(models.reference, wanted)),
    { name: 'wasm', backend: 'wasm', optimisation: settled.optimisation },
    feeds.tensors,
    wanted,
  );
  // On the patched model the island tensors carry the rewrite's suffix, so the
  // names asked for are the renamed ones and the pairing maps them back.
  const candidateNames = wanted.map((name) => models.renames[name] ?? name);
  phase('island-webgpu', { piece: settled.piece, patched: settled.patch });
  const webgpu = await runPiece(
    exposeOutputs(models.candidate, toExpose(models.candidate, candidateNames)),
    { name: 'webgpu', backend: 'webgpu', optimisation: settled.optimisation },
    feeds.tensors,
    candidateNames,
  );

  // How many elements each reduction sums, measured rather than assumed: the
  // Sub has the island input's shape, and it came back from the run.
  const measured = new Map(wasm.captured.map((item) => [item.name, item.dims]));
  const islands = all.map((found) => {
    const diff = found.steps.find((step) => step.role === 'diff')?.output ?? '';
    const dims = measured.get(diff);
    let reduced: number | null = null;
    if (dims !== undefined && found.axes.length > 0) {
      reduced = 1;
      for (const axis of found.axes) {
        reduced *= dims[axis] ?? 1;
      }
    }
    return islandRows(found, reduced);
  });

  return {
    piece: settled.piece,
    patched: settled.patch,
    suffix: patch.suffix,
    islands,
    tensors: pairUp(wasm.captured, webgpu.captured, settled.tolerance, models.renames),
    note:
      'every island tensor is a graph output here, so nothing on this path was fused; the ' +
      'statistics are tensors of one element and are reported as such',
  };
}

export interface Probe {
  readonly index: number;
  readonly node: NodeRow;
  readonly tensors: readonly TensorComparison[];
  readonly verdict: Verdict;
  /** How the added graph output was declared: inferred, or a forced type. */
  readonly exposedAs: string;
  readonly error: string | null;
}

/**
 * How a tensor is declared when it is added to the graph's outputs. Inferred
 * first, which is right for a mixed-precision graph; the two forced types are
 * there in case this runtime refuses an output with no type at all.
 */
const DECLARATIONS: readonly { readonly label: string; readonly elemType: number | null }[] = [
  { label: 'inferred', elemType: null },
  { label: 'float32', elemType: 1 },
  { label: 'float16', elemType: 10 },
];

/**
 * One node's output on both backends. `extra` adds tensors this node reads, so
 * the step that breaks can be read together with what it was handed.
 */
async function probeNode(
  bytes: Uint8Array,
  summary: GraphSummary,
  table: readonly NodeRow[],
  index: number,
  settled: Settled,
  feeds: Readonly<Record<string, ort.Tensor>>,
  extra: readonly string[] = [],
): Promise<Probe> {
  const node = summary.nodes[index];
  const row = table[index];
  if (node === undefined || row === undefined) {
    throw new Error(`no node at index ${String(index)}`);
  }
  if (row.output === null) {
    return {
      index,
      node: row,
      tensors: [],
      verdict: 'failed',
      exposedAs: 'none',
      error: 'no exposable output',
    };
  }

  const wanted = [...new Set([...extra, row.output])];
  let lastError = 'nothing was attempted';
  for (const declaration of DECLARATIONS) {
    const edited = exposeOutputs(bytes, wanted, declaration.elemType);
    try {
      const wasm = await runPiece(
        edited,
        { name: 'wasm', backend: 'wasm', optimisation: settled.optimisation },
        feeds,
        wanted,
      );
      const webgpu = await runPiece(
        edited,
        { name: 'webgpu', backend: 'webgpu', optimisation: settled.optimisation },
        feeds,
        wanted,
      );
      const tensors = pairUp(wasm.captured, webgpu.captured, settled.tolerance);
      const own = tensors.find((tensor) => tensor.name === row.output);
      return {
        index,
        node: row,
        tensors,
        verdict: own?.verdict ?? 'failed',
        exposedAs: declaration.label,
        error: own === undefined ? `${row.output} did not come back` : null,
      };
    } catch (cause) {
      lastError = `${declaration.label}: ${describe(cause)}`;
    }
  }
  return { index, node: row, tensors: [], verdict: 'failed', exposedAs: 'none', error: lastError };
}

export interface BisectReport {
  readonly piece: string;
  readonly anchor: { readonly output: string; readonly nodeIndex: number } | null;
  readonly firstBad: NodeRow | null;
  readonly lastGood: NodeRow | null;
  readonly probes: readonly Probe[];
  /** The first bad node again, this time with its own inputs exposed. */
  readonly detail: Probe | null;
  readonly window: readonly NodeRow[];
  readonly steps: number;
  readonly note: string;
}

const NOT_RUN: BisectReport = {
  piece: '',
  anchor: null,
  firstBad: null,
  lastGood: null,
  probes: [],
  detail: null,
  window: [],
  steps: 0,
  note: 'not run',
};

/**
 * Step two: the first node whose WebGPU output is wrong. `known` lets a caller
 * that has already run {@link compare} hand the result over rather than pay
 * for both backends a second time.
 */
export async function bisect(input: BisectOptions = {}, known?: CompareReport): Promise<BisectReport> {
  const settled = settle(input);
  // Both backends probe the same bytes, so with `patch` this is the rewritten
  // graph on each side and the node names are the rewritten ones.
  const bytes = (await modelsFor(settled.piece, settled.patch)).candidate;
  const summary = summariseGraph(bytes);
  const table = tableOf(summary);
  const segment = syntheticSegment(settled.seed, settled.gain, settled.shape);
  const feeds = await feedsFor(settled.piece, segment);

  const first = known ?? (await compare(input));
  const broken = first.outputs.find((output) => output.verdict !== 'clean');
  if (broken === undefined) {
    return {
      ...NOT_RUN,
      piece: settled.piece,
      note: 'every declared output agreed with WASM, so there was nothing to bisect',
    };
  }
  const anchorIndex = summary.nodes.findIndex((node) => node.outputs.includes(broken.name));
  if (anchorIndex < 0) {
    throw new Error(`no node in ${settled.piece} produces ${broken.name}`);
  }

  const probes = new Map<number, Probe>();
  const run = async (index: number): Promise<Probe> => {
    const cached = probes.get(index);
    if (cached !== undefined) {
      return cached;
    }
    phase('probe', { index, node: table[index]?.name ?? '' });
    const probe = await probeNode(bytes, summary, table, index, settled, feeds.tensors);
    probes.set(index, probe);
    return probe;
  };

  /** Skips nodes no graph output can be taken from, and ones that would not load. */
  const usable = (from: number, limit: number): number | null => {
    for (let index = Math.max(0, from); index <= limit; index += 1) {
      const row = table[index];
      if (row !== undefined && row.output !== null && probes.get(index)?.verdict !== 'failed') {
        return index;
      }
    }
    return null;
  };

  let low = 0;
  let high = anchorIndex;
  let steps = 0;
  while (low < high && steps < 24) {
    const middle = usable(Math.floor((low + high) / 2), high - 1);
    if (middle === null) {
      break;
    }
    steps += 1;
    const probe = await run(middle);
    if (probe.verdict === 'clean' || probe.verdict === 'failed') {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const previous = usable(high - 4, high - 1);
  if (previous !== null) {
    await run(previous);
  }

  // The node that breaks, read with its own inputs: a value already at the top
  // of fp16's range on the way in is a different story from one that appears
  // out of nothing.
  const node = summary.nodes[high];
  const produced = new Set(summary.nodes.flatMap((item) => item.outputs));
  const inputs = (node?.inputs ?? []).filter((name) => name !== '' && produced.has(name));
  phase('detail', { index: high, inputs: inputs.length });
  const detail =
    node === undefined
      ? null
      : await probeNode(bytes, summary, table, high, settled, feeds.tensors, inputs);

  return {
    piece: settled.piece,
    anchor: { output: broken.name, nodeIndex: anchorIndex },
    firstBad: table[high] ?? null,
    lastGood: previous === null ? null : (table[previous] ?? null),
    probes: [...probes.values()].sort((a, b) => a.index - b.index),
    detail,
    window: table.slice(Math.max(0, high - 4), high + 3),
    steps,
    note:
      'the search assumes a bad output stays bad down the stored node order, which holds along one ' +
      'chain; every probe is listed so a break in that assumption is visible',
  };
}

export interface OptionOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly gain: number;
  readonly shape: SegmentShape;
  /** Frequency rows of the input that were zero throughout. */
  readonly emptyBins: number;
  readonly createMs: number;
  readonly runMs: number;
  readonly outputs: readonly TensorComparison[];
  readonly worstVerdict: Verdict;
}

export interface SweepOptions extends BisectOptions {
  readonly forceCpuNodeNames?: readonly string[];
}

/** Step three: which session option, if any, changes the answer. */
export async function sweep(input: SweepOptions = {}): Promise<readonly OptionOutcome[]> {
  const settled = settle(input);
  const models = await modelsFor(settled.piece, settled.patch);
  const force = input.forceCpuNodeNames ?? [];

  const matrix: readonly Hypothesis[] = [
    { name: 'optimisation disabled', backend: 'webgpu', optimisation: 'disabled' },
    { name: 'optimisation basic', backend: 'webgpu', optimisation: 'basic' },
    { name: 'optimisation extended', backend: 'webgpu', optimisation: 'extended' },
    { name: 'optimisation all', backend: 'webgpu', optimisation: 'all' },
    { name: 'output left on the gpu', backend: 'webgpu', outputLocation: 'gpu-buffer' },
    { name: 'NHWC layout', backend: 'webgpu', preferredLayout: 'NHWC' },
    { name: 'no buffer cache', backend: 'webgpu', bufferCache: 'disabled' },
    { name: 'full validation', backend: 'webgpu', validation: 'full' },
    { name: 'fp32 matmul accumulation', backend: 'webgpu', matmulFp32Accumulation: true },
    { name: 'graph capture', backend: 'webgpu', graphCapture: true },
    { name: 'input at a tenth', backend: 'webgpu', gain: 0.1 },
    { name: 'input at a hundredth', backend: 'webgpu', gain: 0.01 },
    // Tonal leaves the top of the spectrum at leakage level and silent leaves
    // every bin at exactly zero, so a normalisation there divides by almost
    // nothing. If the fault needs that, these two show it and `mixed` will not.
    { name: 'tonal input, near-empty top bins', backend: 'webgpu', shape: 'tonal' },
    { name: 'silent input', backend: 'webgpu', shape: 'silent' },
    ...(force.length === 0
      ? []
      : [
          {
            name: `${force.join(' and ')} forced to cpu`,
            backend: 'webgpu' as const,
            forceCpuNodeNames: force,
          },
        ]),
    // Last on purpose: a custom device may outlive its session.
    { name: 'device without shader-f16', backend: 'webgpu', withoutShaderF16: true },
  ];

  // One WASM reference per input, not per option. The matrix is ordered so the
  // input changes four times, and holding a single reference at a time matters
  // on a machine this close to its memory.
  let heldKey: string | null = null;
  let held: { feeds: Feeds; reference: readonly Captured[]; emptyBins: number } | null = null;
  const referenceFor = async (
    gain: number,
    shape: SegmentShape,
  ): Promise<{ feeds: Feeds; reference: readonly Captured[]; emptyBins: number }> => {
    const key = `${String(gain)}/${shape}`;
    if (held !== null && heldKey === key) {
      return held;
    }
    held = null;
    const segment = syntheticSegment(settled.seed, gain, shape);
    const feeds = await feedsFor(settled.piece, segment);
    const outcome = await runPiece(
      models.reference,
      { name: 'wasm', backend: 'wasm', optimisation: settled.optimisation },
      feeds.tensors,
      null,
    );
    heldKey = key;
    held = { feeds, reference: outcome.captured, emptyBins: segment.emptyBins };
    return held;
  };

  const outcomes: OptionOutcome[] = [];
  for (const hypothesis of matrix) {
    const gain = hypothesis.gain ?? settled.gain;
    const shape = hypothesis.shape ?? settled.shape;
    phase('option', { name: hypothesis.name, gain, shape });
    try {
      const { feeds, reference, emptyBins } = await referenceFor(gain, shape);
      const candidate = await runPiece(
        models.candidate,
        { ...hypothesis, optimisation: hypothesis.optimisation ?? settled.optimisation },
        feeds.tensors,
        null,
      );
      const outputs = pairUp(reference, candidate.captured, settled.tolerance, models.renames);
      outcomes.push({
        name: hypothesis.name,
        ok: true,
        error: null,
        gain,
        shape,
        emptyBins,
        createMs: Math.round(candidate.createMs),
        runMs: Math.round(candidate.runMs),
        outputs,
        worstVerdict: worstOf(outputs),
      });
    } catch (cause) {
      outcomes.push({
        name: hypothesis.name,
        ok: false,
        error: describe(cause),
        gain,
        shape,
        emptyBins: -1,
        createMs: 0,
        runMs: 0,
        outputs: [],
        worstVerdict: 'failed',
      });
    }
  }
  return outcomes;
}

export interface Report {
  readonly generatedAt: string;
  readonly settings: Settled;
  readonly environment: Record<string, unknown>;
  readonly graph: Omit<GraphReport, 'rows'>;
  /** Every normalisation island, on both backends, before anything is inferred. */
  readonly island: IslandReport;
  readonly compare: CompareReport;
  /** With `patch`, the same comparison without the rewrite, for the before. */
  readonly baseline: CompareReport | null;
  readonly bisect: BisectReport;
  readonly options: readonly OptionOutcome[];
  /** Op types around the break, for the next person to look at. */
  readonly suspects: readonly string[];
}

/** Everything, in one call, for the Playwright driver to write out. */
export async function report(input: BisectOptions = {}): Promise<Report> {
  const settled = settle(input);
  phase('environment');
  const where = await environment();
  phase('graph', { piece: settled.piece });
  const full = await nodes(input);
  // The row table is for `nodes()` on its own. The report keeps the shape of
  // the piece and the window around the break, and stays short.
  const graph: Omit<GraphReport, 'rows'> = {
    piece: full.piece,
    count: full.count,
    inputs: full.inputs,
    outputs: full.outputs,
    opTypes: full.opTypes,
    initializerTypes: full.initializerTypes,
    initializerBytes: full.initializerBytes,
    constants: full.constants,
  };
  phase('island', { piece: settled.piece, patched: settled.patch });
  const islands = await island(input);
  // With the rewrite on, the unpatched comparison is run too: one file then
  // holds both the before and the after for the same input and machine.
  const baseline = settled.patch ? await compare({ ...input, patch: false }) : null;
  const first = await compare(input);
  const found = first.reproduced
    ? await bisect(input, first)
    : { ...NOT_RUN, piece: settled.piece, note: 'not run: this input did not reproduce the fault' };
  const force = found.firstBad?.name;
  const matrix = await sweep({
    ...input,
    ...(force === undefined || force === '' ? {} : { forceCpuNodeNames: [force] }),
  });

  return {
    generatedAt: new Date().toISOString(),
    settings: settled,
    environment: where,
    graph,
    island: islands,
    compare: first,
    baseline,
    bisect: found,
    options: matrix,
    suspects: [...new Set(found.window.map((row) => row.opType))],
  };
}
