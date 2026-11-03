import { realTransform } from './fft.ts';

/**
 * Short-time Fourier transform in the layout the separation graphs want:
 * bin-major per channel, so one channel's spectrum is `re[bin * frames +
 * frame]`, which drops straight into an `[1, 4, dim_f, dim_t]` tensor as
 * `[realL, imagL, realR, imagR]`.
 *
 * `center` reflect-pads by `nFft / 2` and centres frame 0 on sample 0, which is
 * what torch.stft(center=True) does and what the model host contracts require.
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

/**
 * A reusable transform for one set of options.
 *
 * Everything it needs is allocated when the plan is made: window, twiddles,
 * frame scratch and the overlap-add accumulator. The hot path allocates
 * nothing, which is what makes it usable from an AudioWorklet and what makes
 * it fast enough to stop dominating separation wall time.
 */
export interface StftPlan {
  readonly options: StftOptions;
  readonly bins: number;
  frames(samples: number): number;
  /** Writes bin-major spectra into `re` and `im`, each `bins * frames` long. */
  forward(signal: Float32Array, frames: number, re: Float32Array, im: Float32Array): void;
  /** Overlap-adds `frames` frames into `output`, which it fills completely. */
  inverse(re: Float32Array, im: Float32Array, frames: number, output: Float32Array): void;
}

function makePlan(options: StftOptions): StftPlan {
  const { nFft, hop, center } = options;
  const transform = realTransform(nFft);
  const window = hannPeriodic(nFft);
  const bins = transform.bins;
  const offset = center ? nFft / 2 : 0;

  const frame = new Float64Array(nFft);
  const frameRe = new Float64Array(bins);
  const frameIm = new Float64Array(bins);
  let accumulator = new Float64Array(0);
  let weight = new Float64Array(0);

  return {
    options,
    bins,
    frames(samples) {
      return frameCount(samples, options);
    },
    forward(signal, frames, re, im) {
      for (let index = 0; index < frames; index += 1) {
        const start = index * hop - offset;
        if (start >= 0 && start + nFft <= signal.length) {
          // Interior frame: no reflection needed, so copy straight across.
          for (let n = 0; n < nFft; n += 1) {
            frame[n] = (signal[start + n] ?? 0) * (window[n] ?? 0);
          }
        } else {
          for (let n = 0; n < nFft; n += 1) {
            frame[n] = readReflected(signal, start + n) * (window[n] ?? 0);
          }
        }
        transform.forward(frame, frameRe, frameIm);
        for (let bin = 0; bin < bins; bin += 1) {
          re[bin * frames + index] = frameRe[bin] ?? 0;
          im[bin * frames + index] = frameIm[bin] ?? 0;
        }
      }
    },
    inverse(re, im, frames, output) {
      const length = output.length;
      if (accumulator.length < length) {
        accumulator = new Float64Array(length);
        weight = new Float64Array(length);
      }
      accumulator.fill(0, 0, length);
      weight.fill(0, 0, length);

      for (let index = 0; index < frames; index += 1) {
        for (let bin = 0; bin < bins; bin += 1) {
          frameRe[bin] = re[bin * frames + index] ?? 0;
          frameIm[bin] = im[bin * frames + index] ?? 0;
        }
        transform.inverse(frameRe, frameIm, frame);

        const start = index * hop - offset;
        const from = Math.max(0, -start);
        const to = Math.min(nFft, length - start);
        for (let n = from; n < to; n += 1) {
          const at = start + n;
          const w = window[n] ?? 0;
          accumulator[at] = (accumulator[at] ?? 0) + (frame[n] ?? 0) * w;
          weight[at] = (weight[at] ?? 0) + w * w;
        }
      }

      for (let i = 0; i < length; i += 1) {
        const w = weight[i] ?? 0;
        output[i] = w > 1e-8 ? (accumulator[i] ?? 0) / w : 0;
      }
    },
  };
}

const plans = new Map<string, StftPlan>();

export function createStftPlan(options: StftOptions): StftPlan {
  const key = `${String(options.nFft)}:${String(options.hop)}:${String(options.center)}`;
  const existing = plans.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = makePlan(options);
  plans.set(key, created);
  return created;
}

/** Convenience wrapper that allocates its own output. */
export function stft(signal: Float32Array, options: StftOptions): Spectrum {
  const plan = createStftPlan(options);
  const frames = plan.frames(signal.length);
  const re = new Float32Array(plan.bins * frames);
  const im = new Float32Array(plan.bins * frames);
  plan.forward(signal, frames, re, im);
  return { re, im, bins: plan.bins, frames };
}

/** Convenience wrapper that allocates its own output. */
export function istft(spectrum: Spectrum, options: StftOptions, length: number): Float32Array {
  const plan = createStftPlan(options);
  const output = new Float32Array(length);
  plan.inverse(spectrum.re, spectrum.im, spectrum.frames, output);
  return output;
}
