/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';

import { createStftPlan, stft, type Spectrum, type StftOptions } from './dsp/stft.ts';
import { cheapSample } from './memory.ts';
import { MODEL_BASE, separationModel, type SeparationModel } from './models.ts';
import { createStemWriter } from './opfs.ts';
import type {
  Backend,
  DoneMessage,
  FailedMessage,
  ProgressMessage,
  RunResult,
  SeparationRequest,
  StemOutput,
} from './protocol.ts';

// Served by the dev-only Vite middleware from node_modules, so every byte the
// page loads comes from its own origin and the production CSP still holds.
ort.env.wasm.wasmPaths = '/spike-ort/';
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);

interface PieceSpec {
  readonly file: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

interface SplitManifest {
  readonly pieces: readonly PieceSpec[];
  readonly outputs: { readonly freq: string; readonly time: string };
}

function post(message: ProgressMessage | DoneMessage | FailedMessage): void {
  self.postMessage(message);
}

function providers(backend: Backend): ort.InferenceSession.SessionOptions {
  return backend === 'webgpu'
    ? { executionProviders: [{ name: 'webgpu' }], graphOptimizationLevel: 'all' }
    : { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function progress(stage: string, done: number, total: number, perSegmentMs: readonly number[]): void {
  const typical = median(perSegmentMs);
  post({
    kind: 'progress',
    stage,
    done,
    total,
    etaMs: typical > 0 ? typical * Math.max(0, total - done) : null,
    memory: cheapSample(),
  });
}

/** Segment start offsets for an overlapping plan. */
function planSegments(samples: number, segment: number, overlap: number, cap: number | null): number[] {
  const stride = Math.max(1, Math.round(segment * (1 - overlap)));
  const starts: number[] = [];
  for (let start = 0; start < samples; start += stride) {
    starts.push(start);
    if (start + segment >= samples) {
      break;
    }
  }
  return cap === null ? starts : starts.slice(0, cap);
}

function sliceChannel(channel: Float32Array, start: number, length: number): Float32Array {
  const out = new Float32Array(length);
  const available = Math.max(0, Math.min(length, channel.length - start));
  if (available > 0) {
    out.set(channel.subarray(start, start + available));
  }
  return out;
}

/* ------------------------------------------------------------------ MDX ---- */

function mdxOptions(model: SeparationModel): StftOptions {
  const contract = model.mdx;
  if (contract === undefined) {
    throw new Error(`${model.id} has no MDX contract`);
  }
  return { nFft: contract.nFft, hop: contract.hop, center: true };
}

/** Packs two channel spectra into the [1, 4, dimF, dimT] tensor MDX wants. */
function packMdxInput(left: Spectrum, right: Spectrum, dimF: number, dimT: number): ort.Tensor {
  const plane = dimF * dimT;
  const data = new Float32Array(plane * 4);
  const parts: readonly [Spectrum, 're' | 'im'][] = [
    [left, 're'],
    [left, 'im'],
    [right, 're'],
    [right, 'im'],
  ];
  parts.forEach(([spectrum, part], index) => {
    const source = part === 're' ? spectrum.re : spectrum.im;
    const base = index * plane;
    for (let bin = 0; bin < dimF; bin += 1) {
      const from = bin * spectrum.frames;
      const to = base + bin * dimT;
      for (let frame = 0; frame < dimT; frame += 1) {
        data[to + frame] = source[from + frame] ?? 0;
      }
    }
  });
  return new ort.Tensor('float32', data, [1, 4, dimF, dimT]);
}

/** Copies one segment into a reused buffer, zero-padding past the end. */
function copyChannel(channel: Float32Array, start: number, target: Float32Array): void {
  const available = Math.max(0, Math.min(target.length, channel.length - start));
  if (available > 0) {
    target.set(channel.subarray(start, start + available));
  }
  if (available < target.length) {
    target.fill(0, available);
  }
}

/** Fills a reused `[1, 4, dimF, dimT]` buffer from four bin-major planes. */
function packMdx(
  target: Float32Array,
  parts: readonly Float32Array[],
  frames: number,
  dimF: number,
  dimT: number,
): void {
  const plane = dimF * dimT;
  for (let p = 0; p < 4; p += 1) {
    const source = parts[p];
    if (source === undefined) {
      continue;
    }
    const base = p * plane;
    for (let bin = 0; bin < dimF; bin += 1) {
      const from = bin * frames;
      const to = base + bin * dimT;
      for (let frame = 0; frame < dimT; frame += 1) {
        target[to + frame] = source[from + frame] ?? 0;
      }
    }
  }
}

/**
 * Scatters the model's `[1, 4, dimF, dimT]` output back into four bin-major
 * planes. Bins at or above dimF stay as allocated, which is zero: the model
 * says nothing about them.
 */
function unpackMdx(
  raw: Float32Array,
  targets: readonly Float32Array[],
  frames: number,
  dimF: number,
  dimT: number,
): void {
  const plane = dimF * dimT;
  for (let p = 0; p < 4; p += 1) {
    const target = targets[p];
    if (target === undefined) {
      continue;
    }
    const base = p * plane;
    for (let bin = 0; bin < dimF; bin += 1) {
      const from = base + bin * dimT;
      const to = bin * frames;
      for (let frame = 0; frame < dimT; frame += 1) {
        target[to + frame] = raw[from + frame] ?? 0;
      }
    }
  }
}

/* -------------------------------------------------------------- demucs ---- */

async function loadManifest(model: SeparationModel): Promise<SplitManifest> {
  const contract = model.demucs;
  if (contract === undefined) {
    throw new Error(`${model.id} has no demucs contract`);
  }
  const response = await fetch(`${MODEL_BASE}/${model.id}/${contract.manifest}`);
  if (!response.ok) {
    throw new Error(`manifest ${String(response.status)}: run scripts/spike/models.mjs fetch`);
  }
  return (await response.json()) as SplitManifest;
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

async function runDemucsChain(
  sessions: readonly ort.InferenceSession[],
  manifest: SplitManifest,
  seed: Record<string, ort.Tensor>,
): Promise<void> {
  const live = new Map<string, ort.Tensor>(Object.entries(seed));
  const release = lastUse(manifest.pieces);

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

    for (const [name, tensor] of live) {
      if ((release.get(name) ?? Number.MAX_SAFE_INTEGER) <= index && name !== manifest.outputs.freq) {
        tensor.dispose();
        live.delete(name);
      }
    }
  }

  for (const tensor of live.values()) {
    tensor.dispose();
  }
}

/* ----------------------------------------------------------------- run ---- */

/**
 * The graph is the authority on its own input shape. `raydotac`'s
 * metadata.json says dim_f 3072 for Inst_HQ_5, and the graph wants 2560, so
 * the declared contract is read back and the model's answer wins.
 */
function readInputShape(session: ort.InferenceSession): number[] | null {
  const metadata = (
    session as unknown as {
      inputMetadata?: readonly { readonly name: string; readonly shape?: readonly (number | string)[] }[];
    }
  ).inputMetadata;
  const first = metadata?.[0];
  if (first?.shape === undefined) {
    return null;
  }
  return first.shape.map((dimension) => (typeof dimension === 'number' ? dimension : -1));
}

/** What the worker itself can see of the GPU, which is what actually matters. */
async function describeWorkerGpu(): Promise<string> {
  const gpu = (
    navigator as unknown as {
      gpu?: {
        requestAdapter: () => Promise<{
          info?: { vendor?: string; architecture?: string };
          isFallbackAdapter?: boolean;
        } | null>;
      };
    }
  ).gpu;
  if (gpu === undefined) {
    return 'no navigator.gpu in worker';
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      return 'no adapter in worker';
    }
    return `${adapter.info?.vendor ?? '?'}/${adapter.info?.architecture ?? '?'} fallback=${String(
      adapter.isFallbackAdapter ?? 'unknown',
    )}`;
  } catch (error) {
    return `adapter threw: ${String(error)}`;
  }
}

async function separate(request: SeparationRequest): Promise<RunResult> {
  const model = separationModel(request.modelId);
  const caveats: string[] = [];
  const startedAt = performance.now();
  let peakJsHeapBytes = cheapSample().jsHeapBytes;

  const noteHeap = (): void => {
    const sample = cheapSample().jsHeapBytes;
    if (sample !== null) {
      peakJsHeapBytes = Math.max(peakJsHeapBytes ?? 0, sample);
    }
  };

  /**
   * Host cost by stage, summed over segments. The M1 whole-track run showed
   * 42% of wall time outside session.run; this says which part.
   */
  const stageMs: Record<string, number> = {};
  const stage = (name: string, since: number): void => {
    stageMs[name] = (stageMs[name] ?? 0) + (performance.now() - since);
  };

  progress(`worker-received ${request.modelId}/${request.backend}/${request.mode}`, 0, 1, []);
  if (request.backend === 'webgpu') {
    progress(`worker-gpu ${await describeWorkerGpu()}`, 0, 1, []);
  }
  progress('ort-init', 0, 1, []);
  const loadStart = performance.now();

  let sessions: ort.InferenceSession[];
  let manifest: SplitManifest | null = null;
  /** Filled in from the graph once the session exists; overrides the registry. */
  let graphContract: { dimF: number; dimT: number } | null = null;

  if (model.family === 'demucs') {
    manifest = await loadManifest(model);
    sessions = [];
    for (const [index, piece] of manifest.pieces.entries()) {
      sessions.push(
        await ort.InferenceSession.create(`${MODEL_BASE}/${model.id}/${piece.file}`, providers(request.backend)),
      );
      progress('loading pieces', index + 1, manifest.pieces.length, []);
    }
  } else {
    progress('creating session', 0, 1, []);
    sessions = [
      await ort.InferenceSession.create(
        `${MODEL_BASE}/${model.id}/UVR-MDX-NET-Inst_HQ_5.onnx`,
        providers(request.backend),
      ),
    ];
    const shape = sessions[0] === undefined ? null : readInputShape(sessions[0]);
    if (shape !== null) {
      progress(`graph input shape [${shape.join(', ')}]`, 1, 1, []);
      const graphDimF = shape[2];
      const graphDimT = shape[3];
      if (graphDimF !== undefined && graphDimF > 0 && graphDimT !== undefined && graphDimT > 0) {
        graphContract = { dimF: graphDimF, dimT: graphDimT };
      }
    }
    progress('session ready', 1, 1, []);
  }
  const loadMs = performance.now() - loadStart;
  noteHeap();

  if (request.mode === 'load') {
    for (const session of sessions) {
      await session.release();
    }
    return {
      task: 'separation',
      modelId: model.id,
      backend: request.backend,
      mode: 'load',
      loadMs,
      segments: 0,
      segmentMs: [],
      inferenceMs: 0,
      stageMs,
      totalMs: performance.now() - startedAt,
      audioSeconds: 0,
      realtimeFactor: 0,
      peakJsHeapBytes,
      stems: [],
      transcription: null,
      caveats: ['load mode: sessions created and released, no inference and no audio'],
    };
  }

  const sampleRate = request.audio?.sampleRate ?? model.sampleRate;
  const channels = request.audio?.channels ?? [];
  const sourceSamples = channels[0]?.length ?? model.segmentSamples * 4;
  const starts = planSegments(sourceSamples, model.segmentSamples, model.overlap, request.maxSegments);
  const segmentMs: number[] = [];
  const stems: StemOutput[] = [];

  if (request.audio === null) {
    caveats.push('no input audio: ran on zero-filled tensors of the right shape');
  }
  if (sampleRate !== model.sampleRate) {
    caveats.push(
      `input is ${String(sampleRate)} Hz but the model expects ${String(model.sampleRate)} Hz; no resampling in this spike`,
    );
  }

  let inferenceMs = 0;

  if (model.family === 'demucs' || request.mode === 'bench') {
    // Inference cost only: shape-correct tensors, no audio produced.
    if (model.family === 'demucs') {
      const contract = model.demucs;
      if (contract === undefined || manifest === null) {
        throw new Error('demucs contract missing');
      }
      caveats.push(
        'htdemucs ran as an inference benchmark: the host side of this export (demucs framing, mask and overlap-add) is not implemented, so no audio was produced and nothing here speaks to separation quality',
      );
      const left = channels[0] ?? new Float32Array(contract.mixSamples);
      const right = channels[1] ?? left;

      for (const [index, start] of starts.entries()) {
        const mixData = new Float32Array(2 * contract.mixSamples);
        mixData.set(sliceChannel(left, start, contract.mixSamples), 0);
        mixData.set(sliceChannel(right, start, contract.mixSamples), contract.mixSamples);
        const mix = new ort.Tensor('float32', mixData, [1, 2, contract.mixSamples]);

        const magData = new Float32Array(contract.magChannels * contract.magBins * contract.magFrames);
        const options: StftOptions = { nFft: 4096, hop: 1024, center: true };
        const spectra = [
          stft(sliceChannel(left, start, contract.mixSamples), options),
          stft(sliceChannel(right, start, contract.mixSamples), options),
        ];
        const plane = contract.magBins * contract.magFrames;
        spectra.forEach((spectrum, channel) => {
          for (let bin = 0; bin < contract.magBins; bin += 1) {
            for (let frame = 0; frame < contract.magFrames; frame += 1) {
              const from = bin * spectrum.frames + frame;
              magData[(channel * 2 + 0) * plane + bin * contract.magFrames + frame] = spectrum.re[from] ?? 0;
              magData[(channel * 2 + 1) * plane + bin * contract.magFrames + frame] = spectrum.im[from] ?? 0;
            }
          }
        });
        const mag = new ort.Tensor('float32', magData, [
          1,
          contract.magChannels,
          contract.magBins,
          contract.magFrames,
        ]);

        const began = performance.now();
        await runDemucsChain(sessions, manifest, { mix, mag });
        const took = performance.now() - began;
        segmentMs.push(took);
        inferenceMs += took;
        mix.dispose();
        mag.dispose();
        noteHeap();
        progress('separating', index + 1, starts.length, segmentMs);
      }
    } else {
      const contract = model.mdx;
      const session = sessions[0];
      if (contract === undefined || session === undefined) {
        throw new Error('mdx contract missing');
      }
      caveats.push('bench mode: one fixed input tensor, inference cost only, no audio produced');
      const options = mdxOptions(model);
      const dimF = graphContract?.dimF ?? contract.dimF;
      const dimT = graphContract?.dimT ?? contract.dimT;
      const left = channels[0] ?? new Float32Array(model.segmentSamples);
      const right = channels[1] ?? left;
      progress('stft', 0, 1, []);
      const input = packMdxInput(
        stft(sliceChannel(left, 0, model.segmentSamples), options),
        stft(sliceChannel(right, 0, model.segmentSamples), options),
        dimF,
        dimT,
      );
      progress('stft done', 1, 1, []);

      for (const [index] of starts.entries()) {
        const began = performance.now();
        const outputs = await session.run({ input });
        const took = performance.now() - began;
        segmentMs.push(took);
        inferenceMs += took;
        for (const tensor of Object.values(outputs)) {
          tensor.dispose();
        }
        noteHeap();
        progress('separating', index + 1, starts.length, segmentMs);
      }
      input.dispose();
    }
  } else {
    const contract = model.mdx;
    const session = sessions[0];
    if (contract === undefined || session === undefined) {
      throw new Error('mdx contract missing');
    }
    const options = mdxOptions(model);
    const dimF = graphContract?.dimF ?? contract.dimF;
    const dimT = graphContract?.dimT ?? contract.dimT;
    const segment = contract.hop * (dimT - 1);
    const stride = Math.max(1, Math.round(segment * (1 - model.overlap)));
    const fade = segment - stride;

    const primaryWriter = await createStemWriter(`${model.id}-${contract.primaryStem.toLowerCase()}.f32`);
    const residualWriter = await createStemWriter(`${model.id}-residual.f32`);
    let primaryBytes = 0;
    let residualBytes = 0;
    let written = 0;

    // One segment of tail is held back so the next segment can crossfade into
    // it; everything before that is flushed and dropped.
    let tailPrimary: Float32Array<ArrayBuffer> | null = null;
    let tailResidual: Float32Array<ArrayBuffer> | null = null;

    const left = channels[0] ?? new Float32Array(segment);
    const right = channels[1] ?? left;

    // Everything the segment loop needs, allocated once. The wrappers that
    // allocate their own output cost about 31 MB of garbage per segment, which
    // over a whole track is more than a gigabyte for the collector to chase.
    const plan = createStftPlan(options);
    const frames = plan.frames(segment);
    const spectra = Array.from({ length: 4 }, () => new Float32Array(plan.bins * frames));
    const [leftRe, leftIm, rightRe, rightIm] = spectra as [
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
    ];
    const outputs = Array.from({ length: 4 }, () => new Float32Array(plan.bins * frames));
    const [outLeftRe, outLeftIm, outRightRe, outRightIm] = outputs as [
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
    ];
    const leftSlice = new Float32Array(segment);
    const rightSlice = new Float32Array(segment);
    const primaryLeft = new Float32Array(segment);
    const primaryRight = new Float32Array(segment);
    const inputData = new Float32Array(4 * dimF * dimT);

    for (const [index, start] of starts.entries()) {
      const sliceAt = performance.now();
      copyChannel(left, start, leftSlice);
      copyChannel(right, start, rightSlice);
      stage('slice', sliceAt);

      const stftAt = performance.now();
      plan.forward(leftSlice, frames, leftRe, leftIm);
      plan.forward(rightSlice, frames, rightRe, rightIm);
      stage('stft', stftAt);

      const packAt = performance.now();
      packMdx(inputData, [leftRe, leftIm, rightRe, rightIm], frames, dimF, dimT);
      const input = new ort.Tensor('float32', inputData, [1, 4, dimF, dimT]);
      stage('pack', packAt);

      const began = performance.now();
      const result = await session.run({ input });
      const took = performance.now() - began;
      segmentMs.push(took);
      inferenceMs += took;
      input.dispose();

      const first = Object.values(result)[0];
      if (first === undefined) {
        throw new Error('model returned no output');
      }
      const raw = first.data as Float32Array;
      const unpackAt = performance.now();
      unpackMdx(raw, [outLeftRe, outLeftIm, outRightRe, outRightIm], frames, dimF, dimT);
      stage('unpack', unpackAt);
      for (const tensor of Object.values(result)) {
        tensor.dispose();
      }

      const istftAt = performance.now();
      plan.inverse(outLeftRe, outLeftIm, frames, primaryLeft);
      plan.inverse(outRightRe, outRightIm, frames, primaryRight);
      stage('istft', istftAt);

      // Interleave, apply UVR's compensation, and take the residual as the
      // other stem.
      const mixAt = performance.now();
      const primary = new Float32Array(segment * 2);
      const residual = new Float32Array(segment * 2);
      for (let i = 0; i < segment; i += 1) {
        const pl = (primaryLeft[i] ?? 0) * contract.compensate;
        const pr = (primaryRight[i] ?? 0) * contract.compensate;
        primary[i * 2] = pl;
        primary[i * 2 + 1] = pr;
        residual[i * 2] = (leftSlice[i] ?? 0) - pl;
        residual[i * 2 + 1] = (rightSlice[i] ?? 0) - pr;
      }
      stage('interleave', mixAt);

      const flush = async (): Promise<void> => {
        if (tailPrimary === null || tailResidual === null) {
          return;
        }
        // Crossfade the shared region, then emit the part that is now final.
        for (let i = 0; i < fade; i += 1) {
          const mix = i / Math.max(1, fade - 1);
          for (let channel = 0; channel < 2; channel += 1) {
            const at = i * 2 + channel;
            const old = tailPrimary[stride * 2 + at] ?? 0;
            primary[at] = old * (1 - mix) + (primary[at] ?? 0) * mix;
            const oldResidual = tailResidual[stride * 2 + at] ?? 0;
            residual[at] = oldResidual * (1 - mix) + (residual[at] ?? 0) * mix;
          }
        }
        await primaryWriter.append(tailPrimary.subarray(0, stride * 2));
        await residualWriter.append(tailResidual.subarray(0, stride * 2));
        primaryBytes += stride * 2 * 4;
        residualBytes += stride * 2 * 4;
        written += stride;
      };

      await flush();
      tailPrimary = primary;
      tailResidual = residual;

      noteHeap();
      progress('separating', index + 1, starts.length, segmentMs);
    }

    if (tailPrimary !== null && tailResidual !== null) {
      await primaryWriter.append(tailPrimary);
      await residualWriter.append(tailResidual);
      primaryBytes += tailPrimary.byteLength;
      residualBytes += tailResidual.byteLength;
      written += segment;
    }

    stems.push(
      {
        name: contract.primaryStem.toLowerCase(),
        opfsPath: (await primaryWriter.close(), primaryWriter.path),
        bytes: primaryBytes,
        samples: written,
        channels: 2,
      },
      {
        name: contract.primaryStem === 'Instrumental' ? 'vocals' : 'instrumental',
        opfsPath: (await residualWriter.close(), residualWriter.path),
        bytes: residualBytes,
        samples: written,
        channels: 2,
      },
    );
    caveats.push(
      'the second stem is the residual mix minus the model output, which is how UVR produces it, not a second model head',
    );
  }

  for (const session of sessions) {
    await session.release();
  }

  const totalMs = performance.now() - startedAt;
  const audioSeconds = (starts.length * model.segmentSamples * (1 - model.overlap)) / model.sampleRate;

  return {
    task: 'separation',
    modelId: model.id,
    backend: request.backend,
    mode: model.family === 'demucs' ? 'bench' : request.mode,
    loadMs,
    segments: starts.length,
    segmentMs,
    inferenceMs,
    stageMs,
    totalMs,
    audioSeconds,
    realtimeFactor: inferenceMs > 0 ? audioSeconds / (inferenceMs / 1000) : 0,
    peakJsHeapBytes,
    stems,
    transcription: null,
    caveats,
  };
}

self.addEventListener('message', (event: MessageEvent<SeparationRequest>) => {
  void (async () => {
    try {
      post({ kind: 'done', result: await separate(event.data) });
    } catch (error) {
      post({
        kind: 'failed',
        stage: 'separation',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  })();
});
