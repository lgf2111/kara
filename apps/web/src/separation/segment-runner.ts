import * as ort from 'onnxruntime-web/webgpu';

import {
  SEGMENT_SAMPLES,
  SOURCES,
  VOCALS_INDEX,
  createHtdemucsHost,
  packMagnitude,
  readStemSpectrum,
  readStemWaveform,
} from './htdemucs.ts';
import { patchNormalisationIslands } from './onnx-fp32-island.ts';
import type { Backend } from './protocol.ts';
import type { SegmentRunner, SegmentTrace } from './segment-contract.ts';

/**
 * Sessions for a backend, and one segment through them.
 *
 * This is the half of separation that does not care where the audio came from
 * or where the stems go: the split graph's sessions, the float32 island patch
 * WebGPU needs, the runtime's wasm, demucs' framing around the model, and then
 * stereo in, four stems and the summed pair out. Nothing here touches OPFS, a
 * job record or `postMessage`, so the same code serves separate.worker.ts
 * working through a file and streaming.ts working through live tab audio.
 *
 * The exported graph's segment is fixed at export time, so {@link
 * SegmentRunner.segmentSamples} is a fact rather than an option. A caller may
 * hand `run` fewer samples than that, which are zero-padded to fill the
 * window: the same thing demucs does for the last chunk of a file, and what
 * lets streaming.ts trade quality near a window's edge for lower latency.
 *
 * What a runner is lives in segment-contract.ts, so that anything holding one
 * can be typed, and tested, without onnxruntime-web coming along.
 */

export type { SegmentRun, SegmentRunner, SegmentTrace } from './segment-contract.ts';

/** The weights directory this is exported into. */
export const MODEL_ID = 'htdemucs-web';
/** Where the graph's pieces and manifest are served from. */
export const DEFAULT_WEIGHTS = `/weights/${MODEL_ID}`;
/** Where onnxruntime-web's wasm is served from. Ends in a slash. */
export const DEFAULT_RUNTIME = '/spike-ort/';

const MANIFEST = 'htdemucs_split_manifest.json';

export type Optimisation = 'disabled' | 'basic' | 'extended' | 'all';

interface PieceSpec {
  readonly file: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

interface SplitManifest {
  readonly pieces: readonly PieceSpec[];
  readonly outputs: { readonly freq: string; readonly time: string };
}

export interface SegmentRunnerOptions {
  readonly backend: Backend;
  /** Defaults to `all`. Worth lowering when a backend miscompiles the graph. */
  readonly optimisation?: Optimisation;
  readonly weightsBase?: string;
  readonly runtimePath?: string;
  /** Called as each piece of the split graph finishes loading. */
  readonly onPiece?: (loaded: number, total: number) => void;
  /** Host milliseconds, by phase: `slice`, `spec`, `combine`. */
  readonly onStage?: (name: string, ms: number) => void;
}

/**
 * The runtime's wasm is over the 25 MiB a Pages asset may be, so the deployed
 * site serves it gzipped and the bytes are handed to the runtime here. In dev
 * the plain file is served and the runtime fetches it itself.
 *
 * Done once per context and remembered, because `ort.env` is global: the first
 * runner's runtime path is the one every runner in this worker or page gets.
 */
let runtimeReady: Promise<void> | null = null;
function prepareRuntime(runtimePath: string): Promise<void> {
  runtimeReady ??= (async () => {
    ort.env.wasm.wasmPaths = runtimePath;
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
    if (!import.meta.env.PROD) {
      return;
    }
    const response = await fetch(`${runtimePath}ort-wasm-simd-threaded.asyncify.wasm.gz`);
    if (!response.ok) {
      throw new Error(`the runtime could not be loaded (${String(response.status)})`);
    }
    const fetched = await response.arrayBuffer();
    // A host that labels the file as gzip has already unzipped it by now.
    const zipped = new Uint8Array(fetched, 0, 2);
    const isGzip = zipped[0] === 0x1f && zipped[1] === 0x8b;
    ort.env.wasm.wasmBinary = isGzip
      ? await new Response(
          new Blob([fetched]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer()
      : fetched;
  })();
  return runtimeReady;
}

function providers(backend: Backend, level: Optimisation): ort.InferenceSession.SessionOptions {
  return backend === 'webgpu'
    ? { executionProviders: [{ name: 'webgpu' }], graphOptimizationLevel: level }
    : { executionProviders: ['wasm'], graphOptimizationLevel: level };
}

/**
 * One session per piece of the split model.
 *
 * WebGPU gets each piece with its float16 normalisation islands rebuilt in
 * float32. Without that rewrite the fp16 `ReduceMean` over 2.75M elements
 * divides by an element count that is not representable in half precision,
 * returns exactly zero, and the normalisation then divides by its bare
 * epsilon: the whole chain comes back as +-65000. docs/webgpu-bisect.md has
 * the measurement. The rewrite is local and casts back at the island's edge,
 * so the piece's inputs and outputs are the contract they were.
 *
 * WASM is loaded by URL instead, which lets ONNX Runtime fetch and keep the
 * weights itself rather than routing 21 MiB per piece through this heap.
 */
async function createSessions(
  manifest: SplitManifest,
  backend: Backend,
  level: Optimisation,
  weights: string,
  runtimePath: string,
  onPiece: (index: number) => void,
): Promise<{ sessions: ort.InferenceSession[]; islands: number }> {
  await prepareRuntime(runtimePath);
  const options = providers(backend, level);
  const sessions: ort.InferenceSession[] = [];
  let islands = 0;

  for (const [index, piece] of manifest.pieces.entries()) {
    if (backend === 'webgpu') {
      const response = await fetch(`${weights}/${piece.file}`);
      if (!response.ok) {
        throw new Error(
          `${piece.file} ${String(response.status)}: run scripts/spike/models.mjs fetch`,
        );
      }
      const patch = patchNormalisationIslands(new Uint8Array(await response.arrayBuffer()));
      islands += patch.islands.length;
      sessions.push(await ort.InferenceSession.create(patch.bytes, options));
    } else {
      sessions.push(await ort.InferenceSession.create(`${weights}/${piece.file}`, options));
    }
    onPiece(index);
  }
  return { sessions, islands };
}

/** The fp16 chain can hand back half-precision tensors. */
function halfToFloat(half: number): number {
  const sign = (half & 0x8000) === 0 ? 1 : -1;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function asFloat32(tensor: ort.Tensor, into: Float32Array): Float32Array {
  const data = tensor.data as unknown;
  if (data instanceof Float32Array) {
    return data;
  }
  if (data instanceof Uint16Array) {
    for (let i = 0; i < data.length; i += 1) {
      into[i] = halfToFloat(data[i] ?? 0);
    }
    return into.subarray(0, data.length);
  }
  if (ArrayBuffer.isView(data) && 'length' in data) {
    const view = data as unknown as { length: number; [index: number]: number };
    for (let i = 0; i < view.length; i += 1) {
      into[i] = Number(view[i] ?? 0);
    }
    return into.subarray(0, view.length);
  }
  throw new Error(`unexpected tensor data type: ${tensor.type}`);
}

/** Last piece index that reads each tensor, so intermediates free early. */
function lastUse(pieces: readonly PieceSpec[]): Map<string, number> {
  const last = new Map<string, number>();
  pieces.forEach((piece, index) => {
    for (const name of piece.inputs) {
      last.set(name, index);
    }
  });
  return last;
}

async function runChain(
  sessions: readonly ort.InferenceSession[],
  manifest: SplitManifest,
  seed: Record<string, ort.Tensor>,
  trace: SegmentTrace | null = null,
): Promise<{ freq: ort.Tensor; time: ort.Tensor }> {
  const live = new Map<string, ort.Tensor>(Object.entries(seed));
  const release = lastUse(manifest.pieces);
  const keep = new Set([manifest.outputs.freq, manifest.outputs.time]);

  for (const [index, piece] of manifest.pieces.entries()) {
    const session = sessions[index];
    if (session === undefined) {
      throw new Error(`missing session for piece ${piece.file}`);
    }
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of piece.inputs) {
      const tensor = live.get(name);
      if (tensor === undefined) {
        throw new Error(`piece ${piece.file} wants ${name}, which no earlier piece produced`);
      }
      feeds[name] = tensor;
    }

    const outputs = await session.run(feeds);
    for (const name of piece.outputs) {
      const tensor = outputs[name];
      if (tensor === undefined) {
        throw new Error(`piece ${piece.file} did not return ${name}`);
      }
      live.set(name, tensor);
    }

    // On a traced segment, find the first piece whose output goes non-finite:
    // that is where the chain breaks, and nothing after it is informative.
    if (trace !== null && trace['firstBadPiece'] === undefined) {
      for (const name of piece.outputs) {
        const tensor = live.get(name);
        const data = tensor?.data as unknown;
        if (!(data instanceof Float32Array)) {
          continue;
        }
        let bad = 0;
        for (let i = 0; i < data.length; i += 1) {
          if (!Number.isFinite(data[i] ?? 0)) {
            bad += 1;
          }
        }
        if (bad > 0) {
          trace['firstBadPiece'] = piece.file;
          trace['firstBadOutput'] = name;
          trace['firstBadCount'] = bad;
          trace['firstBadOf'] = data.length;
          break;
        }
      }
    }

    for (const [name, tensor] of live) {
      if (!keep.has(name) && (release.get(name) ?? Number.MAX_SAFE_INTEGER) <= index) {
        tensor.dispose();
        live.delete(name);
      }
    }
  }

  const freq = live.get(manifest.outputs.freq);
  const time = live.get(manifest.outputs.time);
  if (freq === undefined || time === undefined) {
    throw new Error('the chain did not produce both branches');
  }
  for (const [name, tensor] of live) {
    if (!keep.has(name)) {
      tensor.dispose();
    }
  }
  return { freq, time };
}

/** Fills a segment-long slice from a channel, zero-padding what is missing. */
function copyInto(channel: Float32Array, target: Float32Array): void {
  const available = Math.max(0, Math.min(target.length, channel.length));
  if (available > 0) {
    target.set(channel.subarray(0, available));
  }
  if (available < target.length) {
    target.fill(0, available);
  }
}

export async function createSegmentRunner(options: SegmentRunnerOptions): Promise<SegmentRunner> {
  const weights = options.weightsBase ?? DEFAULT_WEIGHTS;
  const runtimePath = options.runtimePath ?? DEFAULT_RUNTIME;
  const level = options.optimisation ?? 'all';
  const stage = (name: string, since: number): void => {
    options.onStage?.(name, performance.now() - since);
  };

  const manifestResponse = await fetch(`${weights}/${MANIFEST}`);
  if (!manifestResponse.ok) {
    throw new Error(
      `manifest ${String(manifestResponse.status)}: run scripts/spike/models.mjs fetch`,
    );
  }
  const manifest = (await manifestResponse.json()) as SplitManifest;
  const loaded = await createSessions(
    manifest,
    options.backend,
    level,
    weights,
    runtimePath,
    (index) => {
      options.onPiece?.(index + 1, manifest.pieces.length);
    },
  );
  const sessions = loaded.sessions;

  const host = createHtdemucsHost(SEGMENT_SAMPLES);
  const { bins, frames } = host.framing;
  const plane = bins * frames;

  // Preallocated once; a run allocates nothing.
  const leftSlice = new Float32Array(SEGMENT_SAMPLES);
  const rightSlice = new Float32Array(SEGMENT_SAMPLES);
  const specLeftRe = new Float32Array(plane);
  const specLeftIm = new Float32Array(plane);
  const specRightRe = new Float32Array(plane);
  const specRightIm = new Float32Array(plane);
  const magData = new Float32Array(4 * plane);
  const mixData = new Float32Array(2 * SEGMENT_SAMPLES);
  const stemRe = new Float32Array(plane);
  const stemIm = new Float32Array(plane);
  const stemChannel = new Float32Array(SEGMENT_SAMPLES);
  const freqScratch = new Float32Array(SOURCES.length * 4 * plane);
  const timeScratch = new Float32Array(SOURCES.length * 2 * SEGMENT_SAMPLES);
  const stems = SOURCES.map(() => new Float32Array(SEGMENT_SAMPLES * 2));
  const vocals = new Float32Array(SEGMENT_SAMPLES * 2);
  const instrumental = new Float32Array(SEGMENT_SAMPLES * 2);

  return {
    segmentSamples: SEGMENT_SAMPLES,
    islands: loaded.islands,

    async run(left, right, trace = null) {
      const sliceAt = performance.now();
      copyInto(left, leftSlice);
      copyInto(right, rightSlice);
      mixData.set(leftSlice, 0);
      mixData.set(rightSlice, SEGMENT_SAMPLES);
      stage('slice', sliceAt);

      const specAt = performance.now();
      host.spec(leftSlice, specLeftRe, specLeftIm);
      host.spec(rightSlice, specRightRe, specRightIm);
      packMagnitude(magData, specLeftRe, specLeftIm, specRightRe, specRightIm, bins, frames);
      stage('spec', specAt);

      if (trace !== null && trace['magNonFinite'] === undefined) {
        let badMag = 0;
        let magPeak = 0;
        for (let i = 0; i < magData.length; i += 1) {
          const value = magData[i] ?? 0;
          if (!Number.isFinite(value)) {
            badMag += 1;
          } else {
            magPeak = Math.max(magPeak, Math.abs(value));
          }
        }
        let badMix = 0;
        let mixPeak = 0;
        for (let i = 0; i < mixData.length; i += 1) {
          const value = mixData[i] ?? 0;
          if (!Number.isFinite(value)) {
            badMix += 1;
          } else {
            mixPeak = Math.max(mixPeak, Math.abs(value));
          }
        }
        trace['magNonFinite'] = badMag;
        trace['magPeak'] = Number(magPeak.toFixed(6));
        trace['mixNonFinite'] = badMix;
        trace['mixPeak'] = Number(mixPeak.toFixed(6));
      }

      const mix = new ort.Tensor('float32', mixData, [1, 2, SEGMENT_SAMPLES]);
      const mag = new ort.Tensor('float32', magData, [1, 4, bins, frames]);

      const inferAt = performance.now();
      const { freq, time } = await runChain(sessions, manifest, { mix, mag }, trace);
      const inferenceMs = performance.now() - inferAt;
      mix.dispose();
      mag.dispose();

      const combineAt = performance.now();
      const x = asFloat32(freq, freqScratch);
      const xt = asFloat32(time, timeScratch);

      let nonFinite = 0;
      if (trace !== null && trace['freqType'] === undefined) {
        let badX = 0;
        for (let i = 0; i < x.length; i += 1) {
          if (!Number.isFinite(x[i] ?? 0)) {
            badX += 1;
          }
        }
        let badT = 0;
        for (let i = 0; i < xt.length; i += 1) {
          if (!Number.isFinite(xt[i] ?? 0)) {
            badT += 1;
          }
        }
        trace['freqType'] = freq.type;
        trace['timeType'] = time.type;
        trace['freqLength'] = x.length;
        trace['timeLength'] = xt.length;
        trace['freqNonFinite'] = badX;
        trace['timeNonFinite'] = badT;
        trace['freqFirst'] = Number((x[0] ?? 0).toFixed(6));
        trace['timeFirst'] = Number((xt[0] ?? 0).toFixed(6));
        nonFinite = badX + badT;
      }

      // Each source is written into its own buffer and added into the pair as
      // it goes, so the pair costs one pass rather than a second one.
      vocals.fill(0);
      instrumental.fill(0);
      for (let stem = 0; stem < SOURCES.length; stem += 1) {
        const pair = stem === VOCALS_INDEX ? vocals : instrumental;
        const own = stems[stem];
        if (own === undefined) {
          throw new Error(`no segment buffer for source ${String(stem)}`);
        }
        for (let channel = 0; channel < 2; channel += 1) {
          readStemSpectrum(x, stem, channel, bins, frames, stemRe, stemIm);
          host.ispec(stemRe, stemIm, stemChannel);
          const branch = readStemWaveform(xt, stem, channel, SEGMENT_SAMPLES);
          for (let i = 0; i < SEGMENT_SAMPLES; i += 1) {
            const at = i * 2 + channel;
            const value = (stemChannel[i] ?? 0) + (branch[i] ?? 0);
            pair[at] = (pair[at] ?? 0) + value;
            own[at] = value;
          }
        }
      }
      freq.dispose();
      time.dispose();
      stage('combine', combineAt);

      // Stems should add back up to the mixture: cac applies no mask.
      let errorSum = 0;
      let mixSum = 0;
      for (let i = 0; i < SEGMENT_SAMPLES; i += 1) {
        for (let channel = 0; channel < 2; channel += 1) {
          const expected = channel === 0 ? (leftSlice[i] ?? 0) : (rightSlice[i] ?? 0);
          const actual = (vocals[i * 2 + channel] ?? 0) + (instrumental[i * 2 + channel] ?? 0);
          errorSum += (expected - actual) ** 2;
          mixSum += expected ** 2;
        }
      }

      return {
        stems,
        vocals,
        instrumental,
        inferenceMs,
        nonFinite,
        stemSumError: mixSum > 0 ? Math.sqrt(errorSum / mixSum) : null,
      };
    },

    async release() {
      for (const session of sessions) {
        await session.release();
      }
    },
  };
}
