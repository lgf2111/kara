import { SEGMENT_SAMPLES, createHtdemucsHost, packMagnitude } from '../separation/htdemucs.ts';

/**
 * One fixed segment of synthesised audio, framed exactly as the worker frames
 * a real one, so both backends can be fed byte-identical inputs.
 *
 * Synthesised on purpose and from a seeded generator: nothing a person owns
 * goes near this harness, and two runs a week apart compare.
 */

/** Small, fast, and identical on every engine: no Math.random anywhere. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What the segment is made of, which decides what a normalisation sees.
 *
 * - `mixed`: four partials and broadband noise, so every frequency bin holds
 *   something. Closest to real music.
 * - `tonal`: the partials alone, so the top of the spectrum holds nothing but
 *   window leakage and a normalisation there divides by almost no variance.
 *   How close to nothing is reported as `emptyBins`.
 * - `silent`: zeros. Every variance is exactly zero, which is the sharpest
 *   test of whether a backend's epsilon survives.
 */
export type SegmentShape = 'mixed' | 'tonal' | 'silent';

export function syntheticChannel(
  samples: number,
  seed: number,
  gain: number,
  shape: SegmentShape = 'mixed',
  sampleRate = 44100,
): Float32Array {
  const out = new Float32Array(samples);
  if (shape === 'silent') {
    return out;
  }
  const random = mulberry32(seed);
  const partials = [110, 220, 440, 3000];
  for (let i = 0; i < samples; i += 1) {
    let value = 0;
    for (const [index, frequency] of partials.entries()) {
      value += 0.18 * Math.sin((2 * Math.PI * frequency * i) / sampleRate + index);
    }
    if (shape === 'mixed') {
      value += 0.24 * (random() - 0.5);
    }
    out[i] = Math.max(-1, Math.min(1, value)) * gain;
  }
  return out;
}

export interface SyntheticSegment {
  /** The model's `mix` input, [1, 2, SEGMENT_SAMPLES]. */
  readonly mix: Float32Array;
  /** The model's `mag` input, [1, 4, bins, frames]. */
  readonly mag: Float32Array;
  readonly mixDims: readonly number[];
  readonly magDims: readonly number[];
  readonly gain: number;
  readonly seed: number;
  readonly shape: SegmentShape;
  /** Reported so this input can be compared with a real run's diagnostics. */
  readonly mixPeak: number;
  readonly magPeak: number;
  /** Frequency rows whose every value is zero: where a variance vanishes. */
  readonly emptyBins: number;
}

function peak(values: Float32Array): number {
  let worst = 0;
  for (const value of values) {
    worst = Math.max(worst, Math.abs(value));
  }
  return worst;
}

/** Frequency rows of `mag` that are zero from end to end. */
function countEmptyBins(mag: Float32Array, bins: number, frames: number): number {
  let empty = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    let any = false;
    for (let channel = 0; channel < 4 && !any; channel += 1) {
      const base = channel * bins * frames + bin * frames;
      for (let frame = 0; frame < frames; frame += 1) {
        if (mag[base + frame] !== 0) {
          any = true;
          break;
        }
      }
    }
    if (!any) {
      empty += 1;
    }
  }
  return empty;
}

export function syntheticSegment(seed: number, gain = 1, shape: SegmentShape = 'mixed'): SyntheticSegment {
  const host = createHtdemucsHost(SEGMENT_SAMPLES);
  const { bins, frames } = host.framing;
  const plane = bins * frames;

  const left = syntheticChannel(SEGMENT_SAMPLES, seed, gain, shape);
  const right = syntheticChannel(SEGMENT_SAMPLES, seed ^ 0x5bf03635, gain, shape);

  const mix = new Float32Array(2 * SEGMENT_SAMPLES);
  mix.set(left, 0);
  mix.set(right, SEGMENT_SAMPLES);

  const leftRe = new Float32Array(plane);
  const leftIm = new Float32Array(plane);
  const rightRe = new Float32Array(plane);
  const rightIm = new Float32Array(plane);
  host.spec(left, leftRe, leftIm);
  host.spec(right, rightRe, rightIm);

  const mag = new Float32Array(4 * plane);
  packMagnitude(mag, leftRe, leftIm, rightRe, rightIm, bins, frames);

  return {
    mix,
    mag,
    mixDims: [1, 2, SEGMENT_SAMPLES],
    magDims: [1, 4, bins, frames],
    gain,
    seed,
    shape,
    mixPeak: peak(mix),
    magPeak: peak(mag),
    emptyBins: countEmptyBins(mag, bins, frames),
  };
}
