/**
 * What a segment runner is, with nothing of what one is made of.
 *
 * segment-runner.ts imports onnxruntime-web, reads `import.meta.env` and
 * expects a browser. This file is the contract alone, so a page, a worker, the
 * live path in streaming.ts or a test with a fake runner can all name one
 * without any of that coming with it.
 */

/**
 * Where a caller collects numbers about one segment. Passing it in asks for
 * the scans that are too expensive to run on every segment, and is how the
 * first segment of a job ends up describable in a report.
 */
export type SegmentTrace = Record<string, string | number>;

export interface SegmentRun {
  /**
   * One interleaved stereo buffer per source, in htdemucs' `SOURCES` order,
   * each `segmentSamples` frames long. The runner owns them and the next run
   * overwrites them, so read or copy them before running again.
   */
  readonly stems: readonly Float32Array[];
  /** The vocal source, interleaved stereo. Owned the same way as `stems`. */
  readonly vocals: Float32Array;
  /** The other three sources summed, which is what the player plays back. */
  readonly instrumental: Float32Array;
  readonly inferenceMs: number;
  /** Non-finite values in the model's two outputs; only counted when traced. */
  readonly nonFinite: number;
  /**
   * How far the stems missed adding back up to the input, as a fraction of the
   * input's amplitude, or null when the segment was silent. htdemucs with
   * `cac=True` applies no mask, so a large number here is a backend that
   * computed something else entirely: backend-guard.ts judges it.
   */
  readonly stemSumError: number | null;
}

export interface SegmentRunner {
  /** The segment the exported graph takes. Fixed by the export. */
  readonly segmentSamples: number;
  /** Normalisation islands rebuilt in float32, which only WebGPU needs. */
  readonly islands: number;
  /**
   * Runs one segment. Channels longer than `segmentSamples` are truncated and
   * shorter ones zero-padded, so a caller may pass a bare `subarray`.
   */
  run(left: Float32Array, right: Float32Array, trace?: SegmentTrace | null): Promise<SegmentRun>;
  release(): Promise<void>;
}
