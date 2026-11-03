import type { JobSource } from './job.ts';

export type Backend = 'webgpu' | 'wasm';

export interface AudioPayload {
  readonly sampleRate: number;
  /** One Float32Array per channel, transferred rather than copied. */
  readonly channels: Float32Array[];
}

export interface StartMessage {
  readonly kind: 'start';
  readonly backend: Backend;
  readonly source: JobSource;
  readonly audio: AudioPayload;
  readonly overlap: number;
  /** Cap the segments for a probe. null runs the whole input. */
  readonly maxSegments: number | null;
  /**
   * ONNX graph optimisation level. Worth lowering when a backend miscompiles a
   * graph: the fp16 htdemucs chain is sensitive to this.
   */
  readonly optimisation?: 'disabled' | 'basic' | 'extended' | 'all';
}

export interface CancelMessage {
  readonly kind: 'cancel';
}

export type SeparationRequest = StartMessage | CancelMessage;

export interface ProgressMessage {
  readonly kind: 'progress';
  readonly stage: string;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly etaMs: number | null;
  readonly resumedFrom: number;
}

export interface StemFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

export interface SeparationResult {
  readonly jobId: string;
  readonly backend: Backend;
  /** Segment the run started at: non-zero means it resumed. */
  readonly resumedFrom: number;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly loadMs: number;
  readonly inferenceMs: number;
  readonly hostMs: Readonly<Record<string, number>>;
  readonly totalMs: number;
  readonly audioSeconds: number;
  readonly samplesWritten: number;
  readonly stems: readonly StemFile[];
  /**
   * How closely the stems add back up to the input, as a fraction of the
   * input's amplitude, on the last segment processed. htdemucs with cac=True
   * applies no mask, so its stems should sum to very nearly the mixture: a
   * large number here means the host maths is wrong, not that the model is.
   */
  readonly stemSumError: number | null;
  /** Tensor types and sanity counts from the first segment, for diagnosis. */
  readonly diagnostics: Readonly<Record<string, string | number>>;
}

export interface DoneMessage {
  readonly kind: 'done';
  readonly result: SeparationResult;
}

export interface CancelledMessage {
  readonly kind: 'cancelled';
  readonly result: SeparationResult;
}

export interface FailedMessage {
  readonly kind: 'failed';
  readonly stage: string;
  readonly error: string;
}

export type SeparationMessage = ProgressMessage | DoneMessage | CancelledMessage | FailedMessage;
