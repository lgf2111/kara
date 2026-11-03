import { complexTransform } from './fft.ts';

/**
 * Short-time Fourier transform in the layout the separation graphs want:
 * bin-major per channel, so one channel's spectrum is `re[bin * frames +
 * frame]`, which drops straight into an `[1, 4, dim_f, dim_t]` tensor as
 * `[realL, imagL, realR, imagR]`.
 *
 * `center` reflect-pads by `nFft / 2` and centres frame 0 on sample 0, which is
 * what torch.stft(center=True) does and what the MDX host contract requires.
 */
export interface StftOptions {
  readonly nFft: number;
  readonly hop: number;
  readonly center: boolean;
}

export interface Spectrum {
  readonly re: Float32Array;
  readonly im: Float32Array;
  readonly bins: number;
  readonly frames: number;
}

export function hannPeriodic(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}

export function frameCount(samples: number, options: StftOptions): number {
  if (!options.center) {
    return Math.max(0, Math.floor((samples - options.nFft) / options.hop) + 1);
  }
  return Math.floor(samples / options.hop) + 1;
}

/** Samples that produce exactly `frames` centred frames. */
export function samplesForFrames(frames: number, options: StftOptions): number {
  return options.hop * (frames - 1);
}

function readReflected(signal: Float32Array, index: number): number {
  const last = signal.length - 1;
  if (last < 0) {
    return 0;
  }
  let at = index;
  if (at < 0) {
    at = -at;
  }
  if (at > last) {
    at = last - (at - last);
  }
  if (at < 0 || at > last) {
    return 0; // signal shorter than the padding; treat as silence
  }
  return signal[at] ?? 0;
}

export function stft(signal: Float32Array, options: StftOptions): Spectrum {
  const { nFft, hop, center } = options;
  const transform = complexTransform(nFft);
  const window = hannPeriodic(nFft);
  const bins = nFft / 2 + 1;
  const frames = frameCount(signal.length, options);
  const offset = center ? nFft / 2 : 0;

  const re = new Float32Array(bins * frames);
  const im = new Float32Array(bins * frames);
  const bufferRe = new Float64Array(nFft);
  const bufferIm = new Float64Array(nFft);

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * hop - offset;
    bufferIm.fill(0);
    for (let n = 0; n < nFft; n += 1) {
      bufferRe[n] = readReflected(signal, start + n) * (window[n] ?? 0);
    }
    transform.forward(bufferRe, bufferIm);
    for (let bin = 0; bin < bins; bin += 1) {
      re[bin * frames + frame] = bufferRe[bin] ?? 0;
      im[bin * frames + frame] = bufferIm[bin] ?? 0;
    }
  }

  return { re, im, bins, frames };
}

/**
 * Inverse of {@link stft}: overlap-add with window-squared normalisation, so a
 * round trip reproduces the signal wherever the window sum is non-zero.
 */
export function istft(spectrum: Spectrum, options: StftOptions, length: number): Float32Array {
  const { nFft, hop, center } = options;
  const transform = complexTransform(nFft);
  const window = hannPeriodic(nFft);
  const offset = center ? nFft / 2 : 0;
  const { frames, bins } = spectrum;

  const output = new Float64Array(length);
  const weight = new Float64Array(length);
  const bufferRe = new Float64Array(nFft);
  const bufferIm = new Float64Array(nFft);

  for (let frame = 0; frame < frames; frame += 1) {
    bufferRe.fill(0);
    bufferIm.fill(0);
    for (let bin = 0; bin < bins; bin += 1) {
      const re = spectrum.re[bin * frames + frame] ?? 0;
      const im = spectrum.im[bin * frames + frame] ?? 0;
      bufferRe[bin] = re;
      bufferIm[bin] = im;
      if (bin > 0 && bin < nFft - bin) {
        bufferRe[nFft - bin] = re; // hermitian mirror for a real signal
        bufferIm[nFft - bin] = -im;
      }
    }
    transform.inverse(bufferRe, bufferIm);

    const start = frame * hop - offset;
    for (let n = 0; n < nFft; n += 1) {
      const at = start + n;
      if (at < 0 || at >= length) {
        continue;
      }
      const w = window[n] ?? 0;
      output[at] = (output[at] ?? 0) + (bufferRe[n] ?? 0) * w;
      weight[at] = (weight[at] ?? 0) + w * w;
    }
  }

  const result = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const w = weight[i] ?? 0;
    result[i] = w > 1e-8 ? (output[i] ?? 0) / w : 0;
  }
  return result;
}
