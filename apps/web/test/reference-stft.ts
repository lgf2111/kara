import { complexTransform } from '../src/dsp/fft.ts';
import { frameCount, hannPeriodic, type Spectrum, type StftOptions } from '../src/dsp/stft.ts';

/**
 * The transform as it was before the real-input fast path: a full complex FFT
 * per frame, with the Hermitian mirror filled in by hand on the way back.
 *
 * Kept so the fast path has something to be equal to and something to be
 * measured against. Not used by the app.
 */

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
    return 0;
  }
  return signal[at] ?? 0;
}

export function referenceStft(signal: Float32Array, options: StftOptions): Spectrum {
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

export function referenceIstft(
  spectrum: Spectrum,
  options: StftOptions,
  length: number,
): Float32Array {
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
        bufferRe[nFft - bin] = re;
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
