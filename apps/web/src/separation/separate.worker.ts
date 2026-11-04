/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';

import { FALLBACK_NOTICE, FALLBACK_STAGE, checkSegment } from './backend-guard.ts';
import {
  SEGMENT_SAMPLES,
  SOURCES,
  VOCALS_INDEX,
  createHtdemucsHost,
  packMagnitude,
  readStemSpectrum,
  readStemWaveform,
} from './htdemucs.ts';
import {
  JOB_SCHEMA,
  decideResume,
  estimateRemainingMs,
  jobIdFor,
  jobPaths,
  loadJob,
  planJob,
  saveJob,
  type JobState,
} from './job.ts';
import { patchNormalisationIslands } from './onnx-fp32-island.ts';
import { createStitcher, type Stitcher } from './stitch.ts';
import type {
  Backend,
  CancelledMessage,
  DoneMessage,
  FailedMessage,
  ProgressMessage,
  SeparationRequest,
  SeparationResult,
  StartMessage,
  StemFile,
} from './protocol.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';

const MODEL_ID = 'htdemucs-web';
const WEIGHTS = `/weights/${MODEL_ID}`;

ort.env.wasm.wasmPaths = '/spike-ort/';
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);

let cancelRequested = false;

function post(message: ProgressMessage | DoneMessage | CancelledMessage | FailedMessage): void {
  self.postMessage(message);
}

interface PieceSpec {
  readonly file: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

interface SplitManifest {
  readonly pieces: readonly PieceSpec[];
  readonly outputs: { readonly freq: string; readonly time: string };
}

type Optimisation = 'disabled' | 'basic' | 'extended' | 'all';

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
  onPiece: (index: number) => void,
): Promise<{ sessions: ort.InferenceSession[]; islands: number }> {
  const options = providers(backend, level);
  const sessions: ort.InferenceSession[] = [];
  let islands = 0;

  for (const [index, piece] of manifest.pieces.entries()) {
    if (backend === 'webgpu') {
      const response = await fetch(`${WEIGHTS}/${piece.file}`);
      if (!response.ok) {
        throw new Error(
          `${piece.file} ${String(response.status)}: run scripts/spike/models.mjs fetch`,
        );
      }
      const patch = patchNormalisationIslands(new Uint8Array(await response.arrayBuffer()));
      islands += patch.islands.length;
      sessions.push(await ort.InferenceSession.create(patch.bytes, options));
    } else {
      sessions.push(await ort.InferenceSession.create(`${WEIGHTS}/${piece.file}`, options));
    }
    onPiece(index);
  }
  return { sessions, islands };
}

/**
 * What one attempt at a job came to. A backend that returns garbage is not a
 * failure to report: it is an attempt that has to be made again elsewhere, and
 * the guard sees to it that nothing was written before this is decided.
 */
type Attempt =
  | { readonly outcome: 'result'; readonly result: SeparationResult }
  | { readonly outcome: 'fallback'; readonly reason: string };

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
  trace: Record<string, string | number> | null = null,
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

async function separate(
  request: StartMessage,
  backend: Backend,
  fellBackFrom: Backend | null = null,
): Promise<Attempt> {
  const startedAt = performance.now();
  const store = createOpfsStore();
  const hostMs: Record<string, number> = {};
  const diagnostics: Record<string, string | number> = {};
  const stage = (name: string, since: number): void => {
    hostMs[name] = (hostMs[name] ?? 0) + (performance.now() - since);
  };

  const source = request.source;
  const jobId = jobIdFor(source);
  const paths = jobPaths(jobId);
  const plan = planJob(source.samples, SEGMENT_SAMPLES, request.overlap);
  // 'all' keeps each source as its own file as well as the summed
  // instrumental, so separation can be judged one instrument at a time. The
  // player only ever needs the pair, so that stays the default.
  const writeAllStems = request.stems === 'all';
  const stemNames: readonly string[] = writeAllStems
    ? [...SOURCES, 'instrumental']
    : ['vocals', 'instrumental'];

  const stemSizes: Record<string, number | null> = {};
  for (const name of stemNames) {
    stemSizes[name] = await store.sizeOf(paths.stem(name));
  }
  const resume = decideResume(await loadJob(store, jobId), source, plan, stemSizes);
  post({
    kind: 'progress',
    stage: `plan: ${resume.reason}`,
    segmentsDone: resume.from,
    segmentsTotal: plan.total,
    etaMs: null,
    resumedFrom: resume.from,
    stemSumError: null,
    backend,
    notice: null,
  });

  const total = request.maxSegments === null ? plan.total : Math.min(plan.total, request.maxSegments);

  // Model first: a resume that cannot load the model should not touch stems.
  const loadStart = performance.now();
  const manifestResponse = await fetch(`${WEIGHTS}/htdemucs_split_manifest.json`);
  if (!manifestResponse.ok) {
    throw new Error(`manifest ${String(manifestResponse.status)}: run scripts/spike/models.mjs fetch`);
  }
  const manifest = (await manifestResponse.json()) as SplitManifest;
  const optimisation = request.optimisation ?? 'all';
  const loaded = await createSessions(manifest, backend, optimisation, (index) => {
    post({
      kind: 'progress',
      stage: 'loading model',
      segmentsDone: index + 1,
      segmentsTotal: manifest.pieces.length,
      etaMs: null,
      resumedFrom: resume.from,
      stemSumError: null,
      backend,
      notice: null,
    });
  });
  const sessions = loaded.sessions;
  diagnostics['fp32Islands'] = loaded.islands;
  const loadMs = performance.now() - loadStart;

  const host = createHtdemucsHost(SEGMENT_SAMPLES);
  const { bins, frames } = host.framing;
  const plane = bins * frames;

  const left = request.audio.channels[0] ?? new Float32Array(source.samples);
  const right = request.audio.channels[1] ?? left;

  // Preallocated once; the segment loop allocates nothing.
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
  const vocals = new Float32Array(SEGMENT_SAMPLES * 2);
  const instrumental = new Float32Array(SEGMENT_SAMPLES * 2);

  // Only in 'all' mode, and never for the vocal: `vocals` already holds the
  // vocal alone, so a second buffer for it would be the same numbers twice.
  const sourceBuffers = new Map<string, Float32Array>();
  if (writeAllStems) {
    for (const name of SOURCES) {
      if (name !== 'vocals') {
        sourceBuffers.set(name, new Float32Array(SEGMENT_SAMPLES * 2));
      }
    }
  }

  const freshFor = (name: string): Float32Array => {
    if (name === 'vocals') {
      return vocals;
    }
    if (name === 'instrumental') {
      return instrumental;
    }
    const buffer = sourceBuffers.get(name);
    if (buffer === undefined) {
      throw new Error(`no segment buffer for stem ${name}`);
    }
    return buffer;
  };

  interface StemState {
    readonly name: string;
    readonly file: Awaited<ReturnType<typeof store.openAppend>>;
    readonly fresh: Float32Array;
    readonly stitcher: Stitcher;
  }

  const stemStates: StemState[] = [];
  for (const name of stemNames) {
    const file = await store.openAppend(paths.stem(name));
    await file.truncate(resume.samplesWritten * 2 * Float32Array.BYTES_PER_ELEMENT);
    const stitcher = createStitcher(plan, 2);
    if (resume.from > 0) {
      const saved = await store.readFloat32(paths.tail(name));
      if (saved === null) {
        throw new Error(`resume state is missing the crossfade tail for ${name}`);
      }
      stitcher.restore(saved);
    }
    stemStates.push({
      name,
      file,
      fresh: freshFor(name),
      stitcher,
    });
  }

  const segmentMs: number[] = [];
  let inferenceMs = 0;
  let samplesWritten = resume.samplesWritten;
  let segmentsDone = resume.from;
  let stemSumError: number | null = null;
  const stemSumErrors: number[] = [];
  let cancelled = false;
  /** Non-finite values in the model's outputs on the segment the guard sees. */
  let outputNonFinite = 0;
  let guarded = false;
  let fallback: string | null = null;

  const persist = async (status: JobState['status']): Promise<void> => {
    for (const stem of stemStates) {
      if (stem.stitcher.hasTail()) {
        await store.writeFloat32(paths.tail(stem.name), stem.stitcher.tail);
      }
    }
    await saveJob(store, {
      schema: JOB_SCHEMA,
      jobId,
      model: MODEL_ID,
      source,
      plan,
      segmentsDone,
      samplesWritten,
      stems: [...stemNames],
      status,
      updatedAt: new Date().toISOString(),
    });
  };

  for (let index = resume.from; index < total; index += 1) {
    if (cancelRequested) {
      cancelled = true;
      break;
    }
    const start = index * plan.stride;

    const sliceAt = performance.now();
    const copy = (channel: Float32Array, target: Float32Array): void => {
      const available = Math.max(0, Math.min(target.length, channel.length - start));
      if (available > 0) {
        target.set(channel.subarray(start, start + available));
      }
      if (available < target.length) {
        target.fill(0, available);
      }
    };
    copy(left, leftSlice);
    copy(right, rightSlice);
    mixData.set(leftSlice, 0);
    mixData.set(rightSlice, SEGMENT_SAMPLES);
    stage('slice', sliceAt);

    const specAt = performance.now();
    host.spec(leftSlice, specLeftRe, specLeftIm);
    host.spec(rightSlice, specRightRe, specRightIm);
    packMagnitude(magData, specLeftRe, specLeftIm, specRightRe, specRightIm, bins, frames);
    stage('spec', specAt);

    if (diagnostics['magNonFinite'] === undefined) {
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
      diagnostics['magNonFinite'] = badMag;
      diagnostics['magPeak'] = Number(magPeak.toFixed(6));
      diagnostics['mixNonFinite'] = badMix;
      diagnostics['mixPeak'] = Number(mixPeak.toFixed(6));
    }

    const mix = new ort.Tensor('float32', mixData, [1, 2, SEGMENT_SAMPLES]);
    const mag = new ort.Tensor('float32', magData, [1, 4, bins, frames]);

    const inferAt = performance.now();
    const { freq, time } = await runChain(
      sessions,
      manifest,
      { mix, mag },
      index === resume.from ? diagnostics : null,
    );
    const took = performance.now() - inferAt;
    segmentMs.push(took);
    inferenceMs += took;
    mix.dispose();
    mag.dispose();

    const combineAt = performance.now();
    const x = asFloat32(freq, freqScratch);
    const xt = asFloat32(time, timeScratch);

    if (diagnostics['freqType'] === undefined) {
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
      diagnostics['freqType'] = freq.type;
      diagnostics['timeType'] = time.type;
      diagnostics['freqLength'] = x.length;
      diagnostics['timeLength'] = xt.length;
      diagnostics['freqNonFinite'] = badX;
      diagnostics['timeNonFinite'] = badT;
      diagnostics['freqFirst'] = Number((x[0] ?? 0).toFixed(6));
      diagnostics['timeFirst'] = Number((xt[0] ?? 0).toFixed(6));
      // Judged below, once the stem-sum error for this segment is known too.
      outputNonFinite = badX + badT;
    }

    vocals.fill(0);
    instrumental.fill(0);
    for (let stem = 0; stem < SOURCES.length; stem += 1) {
      const summed = stem === VOCALS_INDEX ? vocals : instrumental;
      const own = stem === VOCALS_INDEX ? undefined : sourceBuffers.get(SOURCES[stem] ?? '');
      for (let channel = 0; channel < 2; channel += 1) {
        readStemSpectrum(x, stem, channel, bins, frames, stemRe, stemIm);
        host.ispec(stemRe, stemIm, stemChannel);
        const branch = readStemWaveform(xt, stem, channel, SEGMENT_SAMPLES);
        for (let i = 0; i < SEGMENT_SAMPLES; i += 1) {
          const at = i * 2 + channel;
          const value = (stemChannel[i] ?? 0) + (branch[i] ?? 0);
          summed[at] = (summed[at] ?? 0) + value;
          if (own !== undefined) {
            // Written, not accumulated: this source owns the whole buffer.
            own[at] = value;
          }
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
    stemSumError = mixSum > 0 ? Math.sqrt(errorSum / mixSum) : null;
    if (stemSumError !== null) {
      stemSumErrors.push(stemSumError);
    }

    // The first segment of a run is the last moment at which nothing has been
    // written, and a backend that miscompiles this graph miscompiles it on
    // every segment. So this is where the backend is believed or dropped.
    if (!guarded) {
      guarded = true;
      const decision = checkSegment(backend, { nonFinite: outputNonFinite, stemSumError });
      diagnostics['guard'] = decision.action;
      if (decision.action === 'fall-back-to-wasm') {
        fallback = decision.reason;
        break;
      }
      if (decision.action === 'stop') {
        throw new Error(decision.reason);
      }
    }

    const writeAt = performance.now();
    const isLast = index === total - 1;
    let releasedFrames = 0;
    for (const stem of stemStates) {
      const chunk = stem.stitcher.push(stem.fresh);
      if (chunk !== null) {
        await stem.file.append(chunk);
        releasedFrames = chunk.length / 2;
      }
      if (isLast) {
        await stem.file.append(stem.stitcher.finish());
      }
    }
    samplesWritten += releasedFrames + (isLast ? plan.segment : 0);
    stage('write', writeAt);

    segmentsDone = index + 1;
    await persist(isLast ? 'done' : 'running');

    post({
      kind: 'progress',
      stage: 'separating',
      segmentsDone,
      segmentsTotal: total,
      etaMs: estimateRemainingMs(segmentMs, total - segmentsDone),
      resumedFrom: resume.from,
      stemSumError,
      backend,
      notice: null,
    });
  }

  if (cancelled) {
    await persist('cancelled');
  }

  // Closed before anything else can happen: a sync access handle holds an
  // exclusive lock, so a retry on another backend cannot reopen these stems
  // until this attempt has let them go.
  const stems: StemFile[] = [];
  for (const stem of stemStates) {
    const bytes = stem.file.size();
    await stem.file.close();
    stems.push({ name: stem.name, path: paths.stem(stem.name), bytes });
  }

  for (const session of sessions) {
    await session.release();
  }

  if (fallback !== null) {
    return { outcome: 'fallback', reason: fallback };
  }

  return {
    outcome: 'result',
    result: {
      jobId,
      backend,
      fellBackFrom,
      resumedFrom: resume.from,
      segmentsDone,
      segmentsTotal: total,
      loadMs,
      inferenceMs,
      segmentMs,
      hostMs,
      totalMs: performance.now() - startedAt,
      audioSeconds: samplesWritten / source.sampleRate,
      samplesWritten,
      stems,
      stemSumError,
      stemSumErrors,
      diagnostics,
    },
  };
}

self.addEventListener('message', (event: MessageEvent<SeparationRequest>) => {
  const request = event.data;
  if (request.kind === 'cancel') {
    cancelRequested = true;
    return;
  }
  void (async () => {
    try {
      const finish = (result: SeparationResult): void => {
        post(cancelRequested ? { kind: 'cancelled', result } : { kind: 'done', result });
      };

      const first = await separate(request, request.backend);
      if (first.outcome === 'result') {
        finish(first.result);
        return;
      }

      // The guard runs before the first segment is released, so WebGPU wrote
      // nothing and the same job can start again on WASM from the same place.
      // One retry only: WASM has nothing to fall back to, so a guard failure
      // there is a failure.
      post({
        kind: 'progress',
        stage: `${FALLBACK_STAGE}: ${first.reason}`,
        segmentsDone: 0,
        segmentsTotal: 0,
        etaMs: null,
        resumedFrom: 0,
        stemSumError: null,
        backend: 'wasm',
        notice: FALLBACK_NOTICE,
      });
      const second = await separate(request, 'wasm', request.backend);
      if (second.outcome !== 'result') {
        throw new Error(second.reason);
      }
      finish(second.result);
    } catch (error) {
      post({
        kind: 'failed',
        stage: 'separation',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  })();
});
