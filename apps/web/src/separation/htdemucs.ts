import { createStftPlan, type StftPlan } from '../dsp/stft.ts';

/**
 * The host half of htdemucs: everything the exported graph does not do.
 *
 * The graph takes a raw waveform segment and a spectrogram and returns one
 * complex spectrogram per stem plus a time-domain branch. Turning that back
 * into audio means reproducing demucs' own framing exactly, because the model
 * was trained on it: a specific reflect padding, a normalised STFT, the
 * Nyquist bin dropped, and two frames trimmed from each end.
 *
 * Reference: demucs/htdemucs.py `_spec`, `_magnitude`, `_mask`, `_ispec`.
 */

export const NFFT = 4096;
export const HOP = 1024;
/** The export's fixed segment, 7.8 s at 44.1 kHz. */
export const SEGMENT_SAMPLES = 343980;
export const SAMPLE_RATE = 44100;

/** htdemucs stem order. Index 3 is the vocal; the rest are the backing. */
export const SOURCES = ['drums', 'bass', 'other', 'vocals'] as const;
export const VOCALS_INDEX = 3;

/** torch.stft(normalized=True) divides by this; the inverse multiplies by it. */
const NORMALISE = Math.sqrt(NFFT);

export interface Framing {
  /** Samples handed to the model. */
  readonly length: number;
  /** Frames the model sees, demucs' `le`. */
  readonly frames: number;
  /** Reflect padding demucs adds before the centred STFT. */
  readonly pad: number;
  /** Right padding, which rounds the signal up to a whole number of hops. */
  readonly padRight: number;
  /** Length after demucs' padding. */
  readonly paddedLength: number;
  /** Frames the padded signal produces, always `frames + 4`. */
  readonly paddedFrames: number;
  /** Bins the model sees: Nyquist is dropped. */
  readonly bins: number;
}

export function framing(length: number): Framing {
  const frames = Math.ceil(length / HOP);
  const pad = (HOP / 2) * 3;
  const padRight = pad + frames * HOP - length;
  const paddedLength = pad + length + padRight;
  return {
    length,
    frames,
    pad,
    padRight,
    paddedLength,
    paddedFrames: Math.floor(paddedLength / HOP) + 1,
    bins: NFFT / 2,
  };
}

/**
 * Reflect padding that excludes the edge sample, which is what
 * `F.pad(mode='reflect')` and `torch.stft(pad_mode='reflect')` both do.
 */
export function reflectPad(
  source: Float32Array,
  left: number,
  right: number,
  target: Float32Array,
): void {
  const length = source.length;
  const last = length - 1;
  for (let i = 0; i < target.length; i += 1) {
    let at = i - left;
    if (last <= 0) {
      target[i] = source[0] ?? 0;
      continue;
    }
    // Fold repeatedly, so padding wider than the signal still lands in range.
    for (let guard = 0; guard < 64 && (at < 0 || at > last); guard += 1) {
      if (at < 0) {
        at = -at;
      }
      if (at > last) {
        at = last - (at - last);
      }
    }
    target[i] = source[at] ?? 0;
  }
  void right;
}

export interface HtdemucsHost {
  readonly framing: Framing;
  /**
   * Normalised spectrogram of one channel, bin-major with stride `frames`,
   * written into `re` and `im` of length `bins * frames`.
   */
  spec(channel: Float32Array, re: Float32Array, im: Float32Array): void;
  /**
   * Inverse of {@link spec}, writing `length` samples into `output`.
   */
  ispec(re: Float32Array, im: Float32Array, output: Float32Array): void;
}

export function createHtdemucsHost(length: number = SEGMENT_SAMPLES): HtdemucsHost {
  const shape = framing(length);
  const plan: StftPlan = createStftPlan({ nFft: NFFT, hop: HOP, center: true });
  const padded = new Float32Array(shape.paddedLength);
  const fullBins = NFFT / 2 + 1;
  const fullRe = new Float32Array(fullBins * shape.paddedFrames);
  const fullIm = new Float32Array(fullBins * shape.paddedFrames);
  const reconstructed = new Float32Array(shape.paddedLength);

  return {
    framing: shape,
    spec(channel, re, im) {
      reflectPad(channel, shape.pad, shape.padRight, padded);
      plan.forward(padded, shape.paddedFrames, fullRe, fullIm);
      // Drop the Nyquist bin, trim two frames from each end, and apply the
      // normalisation torch.stft(normalized=True) would have applied.
      const scale = 1 / NORMALISE;
      for (let bin = 0; bin < shape.bins; bin += 1) {
        const from = bin * shape.paddedFrames + 2;
        const to = bin * shape.frames;
        for (let frame = 0; frame < shape.frames; frame += 1) {
          re[to + frame] = (fullRe[from + frame] ?? 0) * scale;
          im[to + frame] = (fullIm[from + frame] ?? 0) * scale;
        }
      }
    },
    ispec(re, im, output) {
      fullRe.fill(0);
      fullIm.fill(0);
      for (let bin = 0; bin < shape.bins; bin += 1) {
        const from = bin * shape.frames;
        const to = bin * shape.paddedFrames + 2;
        for (let frame = 0; frame < shape.frames; frame += 1) {
          fullRe[to + frame] = (re[from + frame] ?? 0) * NORMALISE;
          fullIm[to + frame] = (im[from + frame] ?? 0) * NORMALISE;
        }
      }
      plan.inverse(fullRe, fullIm, shape.paddedFrames, reconstructed);
      output.set(reconstructed.subarray(shape.pad, shape.pad + shape.length));
    },
  };
}

/**
 * Packs two channel spectrograms into the model's `mag` input, which is
 * `[1, 4, bins, frames]` ordered `[left real, left imaginary, right real,
 * right imaginary]`: torch's `view_as_real` then `reshape(B, C * 2, Fr, T)`.
 */
export function packMagnitude(
  target: Float32Array,
  leftRe: Float32Array,
  leftIm: Float32Array,
  rightRe: Float32Array,
  rightIm: Float32Array,
  bins: number,
  frames: number,
): void {
  const plane = bins * frames;
  target.set(leftRe.subarray(0, plane), 0);
  target.set(leftIm.subarray(0, plane), plane);
  target.set(rightRe.subarray(0, plane), 2 * plane);
  target.set(rightIm.subarray(0, plane), 3 * plane);
}

/**
 * Reads one stem's complex spectrogram out of the model's `x` output, which is
 * `[1, stems, 4, bins, frames]` with the same channel order as `mag`.
 *
 * This is demucs' `_mask` with `cac=True`: the four channels are two complex
 * channels, and no masking happens.
 */
export function readStemSpectrum(
  x: Float32Array,
  stem: number,
  channel: number,
  bins: number,
  frames: number,
  re: Float32Array,
  im: Float32Array,
): void {
  const plane = bins * frames;
  const perStem = 4 * plane;
  const base = stem * perStem + channel * 2 * plane;
  re.set(x.subarray(base, base + plane));
  im.set(x.subarray(base + plane, base + 2 * plane));
}

/** Reads one stem channel out of the model's time branch, `[1, stems, 2, n]`. */
export function readStemWaveform(
  xt: Float32Array,
  stem: number,
  channel: number,
  length: number,
): Float32Array {
  const base = stem * 2 * length + channel * length;
  return xt.subarray(base, base + length);
}
