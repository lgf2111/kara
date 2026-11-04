import type { Backend } from './protocol.ts';

/**
 * Whether to believe what a backend just computed.
 *
 * A backend that miscompiles this graph does not fail: it returns numbers.
 * WebGPU returned +-65000 and NaN for months, which would have written stems
 * of silence-shaped garbage into somebody's library. Two measurements catch
 * that on the first segment, before a single sample is written:
 *
 * - a non-finite value anywhere in the model's two outputs
 * - stems that do not add back up to the mixture, which htdemucs with
 *   `cac=True` guarantees they should, since it applies no mask
 *
 * On WebGPU a failure is recoverable: the same job runs again on WASM, which
 * is the backend the reference numbers came from. On WASM there is nothing
 * left to fall back to, so the job stops and says what it measured.
 */

/**
 * How far the stems may miss adding back up to the mixture before the backend
 * is not believed, as a fraction of the mixture's amplitude.
 *
 * Generous on purpose. A correct run sits far below this: the error is fp16
 * rounding plus the host's own STFT round trip. The number only has to
 * separate "rounding" from "this backend computed something else entirely",
 * and a tight threshold here would turn a quiet unusual song into a failure.
 */
export const STEM_SUM_LIMIT = 0.05;

export interface SegmentHealth {
  /** Non-finite values across the model's outputs for the segment. */
  readonly nonFinite: number;
  /** How far the stems missed the mixture, or null when it was not measured. */
  readonly stemSumError: number | null;
}

export type GuardAction = 'keep' | 'fall-back-to-wasm' | 'stop';

export interface GuardDecision {
  readonly action: GuardAction;
  /** Plain enough to print in a failure or a notice. */
  readonly reason: string;
}

/** The progress stage a fallback is announced under. */
export const FALLBACK_STAGE = 'backend-fallback';

/** What a person is told, once, when their song moves to the slower path. */
export const FALLBACK_NOTICE =
  'This computer\u2019s GPU returned invalid audio for the separation model, so the song ' +
  'started again on the slower CPU path. Nothing is wrong with your file. The rest of this ' +
  'session will use the CPU.';

/**
 * Checked after the first segment of a run, because that is the last moment
 * before stems are written and because a graph that is wrong is wrong on every
 * segment.
 */
export function checkSegment(
  backend: Backend,
  health: SegmentHealth,
  limit: number = STEM_SUM_LIMIT,
): GuardDecision {
  const reasons: string[] = [];
  if (health.nonFinite > 0) {
    reasons.push(`${String(health.nonFinite)} non-finite values in the model's outputs`);
  }
  // Written as "not within" rather than "greater than" so a NaN error, which
  // is a failure in itself, does not slip through the comparison.
  if (health.stemSumError !== null && !(health.stemSumError <= limit)) {
    reasons.push(
      `the stems missed the mixture by ${(health.stemSumError * 100).toFixed(1)}%, ` +
        `past the ${(limit * 100).toFixed(0)}% this check allows`,
    );
  }
  if (reasons.length === 0) {
    return { action: 'keep', reason: 'the first segment is finite and sums back to the mixture' };
  }

  const measured = `the ${backend} backend returned ${reasons.join(' and ')}`;
  return backend === 'webgpu'
    ? { action: 'fall-back-to-wasm', reason: measured }
    : { action: 'stop', reason: `${measured}; this model cannot be run on it` };
}
