/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

import { cheapSample } from './memory.ts';
import { MODEL_BASE, transcriptionModel } from './models.ts';
import type {
  DoneMessage,
  FailedMessage,
  ProgressMessage,
  RunResult,
  TranscriptionOutput,
  TranscriptionRequest,
  WordTiming,
} from './protocol.ts';

// Weights and runtime come from this origin only: the dev server serves the
// gitignored models folder and the pinned onnxruntime build. Nothing is
// fetched from a third party, so the production CSP needs no exception.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${MODEL_BASE}/`;
if (env.backends.onnx.wasm !== undefined) {
  env.backends.onnx.wasm.wasmPaths = '/spike-hf-ort/';
}

function post(message: ProgressMessage | DoneMessage | FailedMessage): void {
  self.postMessage(message);
}

function progress(stage: string, done: number, total: number): void {
  post({ kind: 'progress', stage, done, total, etaMs: null, memory: cheapSample() });
}

interface Chunk {
  readonly text: string;
  readonly timestamp: readonly [number, number | null];
}

interface AsrResult {
  readonly text: string;
  readonly chunks?: readonly Chunk[];
}

/** Mixes to mono and resamples to the 16 kHz whisper expects. */
function toMono16k(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const first = channels[0];
  if (first === undefined) {
    return new Float32Array(0);
  }
  const mono = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i += 1) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
    }
  }
  if (sampleRate === 16000) {
    return mono;
  }
  const ratio = sampleRate / 16000;
  const out = new Float32Array(Math.floor(mono.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, mono.length - 1);
    const fraction = at - low;
    out[i] = (mono[low] ?? 0) * (1 - fraction) + (mono[high] ?? 0) * fraction;
  }
  return out;
}

async function transcribe(request: TranscriptionRequest): Promise<RunResult> {
  const model = transcriptionModel(request.modelId);
  const caveats: string[] = [];
  const startedAt = performance.now();
  let peakJsHeapBytes = cheapSample().jsHeapBytes;
  const noteHeap = (): void => {
    const sample = cheapSample().jsHeapBytes;
    if (sample !== null) {
      peakJsHeapBytes = Math.max(peakJsHeapBytes ?? 0, sample);
    }
  };

  progress(`worker-received ${model.id}/${request.backend}/${request.language}`, 0, 1);
  progress('ort-init', 0, 1);

  const loadStart = performance.now();
  progress('creating pipeline', 0, 1);
  const transcriber = await pipeline('automatic-speech-recognition', model.id, {
    device: request.backend,
    dtype: 'q8',
  });
  const loadMs = performance.now() - loadStart;
  progress('pipeline ready', 1, 1);
  noteHeap();

  if (request.mode === 'load') {
    return {
      task: 'transcription',
      modelId: model.id,
      backend: request.backend,
      mode: 'load',
      loadMs,
      segments: 0,
      segmentMs: [],
      inferenceMs: 0,
      totalMs: performance.now() - startedAt,
      audioSeconds: 0,
      realtimeFactor: 0,
      peakJsHeapBytes,
      stems: [],
      transcription: null,
      caveats: ['load mode: pipeline created, no inference'],
    };
  }

  const samples = toMono16k(request.audio.channels, request.audio.sampleRate);
  const audioSeconds = samples.length / 16000;
  progress(`resampled ${audioSeconds.toFixed(1)}s to 16 kHz mono`, 1, 1);

  // Word timestamps need the model's alignment heads. If they are missing the
  // call throws, and that is a finding rather than a crash.
  let wordTimestampsAvailable = true;
  let output: AsrResult;
  const inferenceStart = performance.now();
  progress('transcribing', 0, 1);
  const common = {
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(request.language === 'auto' ? {} : { language: request.language }),
  };
  try {
    output = (await transcriber(samples, { ...common, return_timestamps: 'word' })) as AsrResult;
  } catch (error) {
    wordTimestampsAvailable = false;
    caveats.push(
      `word timestamps unavailable for ${model.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    output = (await transcriber(samples, { ...common, return_timestamps: true })) as AsrResult;
  }
  const inferenceMs = performance.now() - inferenceStart;
  progress('transcribing', 1, 1);
  noteHeap();

  const words: WordTiming[] = (output.chunks ?? []).map((chunk) => ({
    text: chunk.text,
    startMs: Math.round((chunk.timestamp[0] ?? 0) * 1000),
    endMs: Math.round((chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) * 1000),
  }));

  const transcription: TranscriptionOutput = {
    language: request.language,
    text: output.text,
    words: words.slice(0, 200),
    wordTimestampsAvailable,
  };

  caveats.push(
    'the fixture is synthesised tones and noise and contains no speech, so the text means nothing; this measures speed, memory and whether word timings are produced',
  );

  return {
    task: 'transcription',
    modelId: model.id,
    backend: request.backend,
    mode: 'audio',
    loadMs,
    segments: words.length,
    segmentMs: [],
    inferenceMs,
    totalMs: performance.now() - startedAt,
    audioSeconds,
    realtimeFactor: inferenceMs > 0 ? audioSeconds / (inferenceMs / 1000) : 0,
    peakJsHeapBytes,
    stems: [],
    transcription,
    caveats,
  };
}

self.addEventListener('message', (event: MessageEvent<TranscriptionRequest>) => {
  void (async () => {
    try {
      post({ kind: 'done', result: await transcribe(event.data) });
    } catch (error) {
      post({
        kind: 'failed',
        stage: 'transcription',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  })();
});
