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
   * Which stems to write. `pair` is the vocal and one summed instrumental,
   * which is all the player needs. `all` adds drums, bass and other, which
   * costs two and a half times the disk and is for judging separation by ear.
   * Defaults to `pair`.
   */
  readonly stems?: 'pair' | 'all';
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
  /** The segment just finished, or null before any has been. */
  readonly stemSumError: number | null;
  /** The backend this attempt is running on, which a fallback changes. */
  readonly backend: Backend;
  /**
   * Something to show a person in their own words, or null, which is almost
   * always. Set once when a backend had to be abandoned: the progress stream
   * is the only channel the worker has while a job is in flight.
   */
  readonly notice: string | null;
}

export interface StemFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

export interface SeparationResult {
  readonly jobId: string;
  /** The backend that actually produced these stems. */
  readonly backend: Backend;
  /** The backend that was abandoned mid-job, or null if none was. */
  readonly fellBackFrom: Backend | null;
  /** Segment the run started at: non-zero means it resumed. */
  readonly resumedFrom: number;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly loadMs: number;
  readonly inferenceMs: number;
  /**
   * Inference milliseconds for each segment this run processed, in order. The
   * median of these is the number that says whether a backend is worth having.
   */
  readonly segmentMs: readonly number[];
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
  /**
   * The same measure for every segment this run processed, in order, starting
   * at `resumedFrom`. One bad segment hides inside an average, so the run
   * reports them all.
   */
  readonly stemSumErrors: readonly number[];
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
