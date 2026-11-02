/** Wire format between the spike page and its workers, and the exported JSON. */

export type Backend = 'webgpu' | 'wasm';

/**
 * `bench` measures inference cost with shape-correct tensors and produces no
 * audio. `audio` runs the whole host pipeline and writes stems to OPFS.
 */
export type RunMode = 'bench' | 'audio';

export interface MemorySample {
  /** performance.memory.usedJSHeapSize, Chrome only, excludes WASM and GPU. */
  readonly jsHeapBytes: number | null;
  /** measureUserAgentSpecificMemory, needs cross-origin isolation. */
  readonly agentBytes: number | null;
}

export interface AudioPayload {
  readonly sampleRate: number;
  /** One Float32Array per channel. Transferred, never copied over the wire. */
  readonly channels: Float32Array[];
}

export interface SeparationRequest {
  readonly kind: 'separate';
  readonly modelId: string;
  readonly backend: Backend;
  readonly mode: RunMode;
  readonly audio: AudioPayload | null;
  /** Cap the segment count to keep a probe short. null runs the whole input. */
  readonly maxSegments: number | null;
}

export interface TranscriptionRequest {
  readonly kind: 'transcribe';
  readonly modelId: string;
  readonly backend: Backend;
  /** Whisper language code, or 'auto'. */
  readonly language: string;
  readonly audio: AudioPayload;
}

export type WorkerRequest = SeparationRequest | TranscriptionRequest;

export interface ProgressMessage {
  readonly kind: 'progress';
  readonly stage: string;
  readonly done: number;
  readonly total: number;
  readonly etaMs: number | null;
  readonly memory: MemorySample;
}

export interface StemOutput {
  readonly name: string;
  readonly opfsPath: string;
  readonly bytes: number;
  readonly samples: number;
  readonly channels: number;
}

export interface WordTiming {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface TranscriptionOutput {
  readonly language: string;
  readonly text: string;
  readonly words: readonly WordTiming[];
  readonly wordTimestampsAvailable: boolean;
}

export interface RunResult {
  readonly task: 'separation' | 'transcription';
  readonly modelId: string;
  readonly backend: Backend;
  readonly mode: RunMode;
  readonly loadMs: number;
  readonly segments: number;
  readonly segmentMs: readonly number[];
  readonly inferenceMs: number;
  readonly totalMs: number;
  readonly audioSeconds: number;
  readonly realtimeFactor: number;
  readonly peakJsHeapBytes: number | null;
  readonly stems: readonly StemOutput[];
  readonly transcription: TranscriptionOutput | null;
  readonly caveats: readonly string[];
}

export interface DoneMessage {
  readonly kind: 'done';
  readonly result: RunResult;
}

export interface FailedMessage {
  readonly kind: 'failed';
  readonly stage: string;
  readonly error: string;
}

export type WorkerMessage = ProgressMessage | DoneMessage | FailedMessage;

export interface MainThreadHealth {
  /** Animation frames seen while the run was in flight. */
  readonly frames: number;
  readonly maxGapMs: number;
  readonly medianGapMs: number;
  readonly longFrames: number;
}

export interface SpikeReport {
  readonly schema: 'kara-spike/1';
  readonly startedAt: string;
  readonly environment: {
    readonly userAgent: string;
    readonly cores: number;
    readonly crossOriginIsolated: boolean;
    readonly webgpu: string | null;
  };
  readonly input: {
    readonly name: string;
    readonly seconds: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly synthetic: boolean;
  };
  readonly run: RunResult | null;
  readonly mainThread: MainThreadHealth | null;
  readonly memoryBefore: MemorySample | null;
  readonly memoryAfter: MemorySample | null;
  readonly outcome: 'completed' | 'failed';
  readonly error: string | null;
}
