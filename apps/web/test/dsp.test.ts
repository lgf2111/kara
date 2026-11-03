import { describe, expect, it } from 'vitest';

import { complexTransform, isPowerOfTwo, naiveDft, nextPowerOfTwo } from '../src/spike/dsp/fft.ts';
import { frameCount, hannPeriodic, istft, samplesForFrames, stft } from '../src/spike/dsp/stft.ts';

/**
 * Deterministic pseudo-random signal, so a failure is reproducible.
 */
function noise(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    out[i] = (state / 4294967296) * 2 - 1;
  }
  return out;
}

function maxAbsDifference(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let worst = 0;
  for (let i = from; i < to; i += 1) {
    worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return worst;
}

describe('power of two helpers', () => {
  it('recognises and rounds up', () => {
    expect([1, 2, 4096].every(isPowerOfTwo)).toBe(true);
    expect([0, 3, 7680].some(isPowerOfTwo)).toBe(false);
    expect(nextPowerOfTwo(7680)).toBe(8192);
    expect(nextPowerOfTwo(7680 * 2 - 1)).toBe(16384);
  });
});

describe('complexTransform', () => {
  it('matches a naive DFT for a power-of-two size', () => {
    const size = 16;
    const signal = noise(size, 7);
    const re = Float64Array.from(signal);
    const im = new Float64Array(size);
    const expected = naiveDft([...signal], new Array<number>(size).fill(0));

    complexTransform(size).forward(re, im);

    for (let k = 0; k < size; k += 1) {
      expect(re[k] ?? 0).toBeCloseTo(expected.re[k] ?? 0, 9);
      expect(im[k] ?? 0).toBeCloseTo(expected.im[k] ?? 0, 9);
    }
  });

  it('matches a naive DFT for a size that is not a power of two', () => {
    const size = 15;
    const signal = noise(size, 11);
    const re = Float64Array.from(signal);
    const im = new Float64Array(size);
    const expected = naiveDft([...signal], new Array<number>(size).fill(0));

    complexTransform(size).forward(re, im);

    for (let k = 0; k < size; k += 1) {
      expect(re[k] ?? 0).toBeCloseTo(expected.re[k] ?? 0, 9);
      expect(im[k] ?? 0).toBeCloseTo(expected.im[k] ?? 0, 9);
    }
  });

  it('round trips the n_fft values the models ask for', () => {
    for (const size of [4096, 7680]) {
      const original = noise(size, size);
      const re = Float64Array.from(original);
      const im = new Float64Array(size);
      const transform = complexTransform(size);

      transform.forward(re, im);
      transform.inverse(re, im);

      let worst = 0;
      for (let i = 0; i < size; i += 1) {
        worst = Math.max(worst, Math.abs((re[i] ?? 0) - (original[i] ?? 0)));
      }
      expect(worst, `n_fft ${String(size)}`).toBeLessThan(1e-9);
    }
  });
});

describe('hannPeriodic', () => {
  it('is periodic, not symmetric', () => {
    const window = hannPeriodic(8);
    expect(window[0]).toBeCloseTo(0, 12);
    expect(window[4]).toBeCloseTo(1, 12);
    expect(window[1]).toBeCloseTo(window[7] ?? 0, 12);
  });
});

describe('frame counting', () => {
  it('gives the MDX contract: 261120 samples is exactly 256 centred frames', () => {
    const options = { nFft: 7680, hop: 1024, center: true };
    expect(samplesForFrames(256, options)).toBe(261120);
    expect(frameCount(261120, options)).toBe(256);
  });
});

describe('stft and istft', () => {
  it('produces the bin and frame counts the MDX tensor needs', () => {
    const options = { nFft: 7680, hop: 1024, center: true };
    const spectrum = stft(noise(261120), options);
    expect(spectrum.bins).toBe(3841);
    expect(spectrum.frames).toBe(256);
    expect(spectrum.re.length).toBe(3841 * 256);
  });

  it('round trips a signal through the interior', () => {
    const options = { nFft: 4096, hop: 1024, center: true };
    const length = 1024 * 40;
    const original = noise(length, 3);

    const restored = istft(stft(original, options), options, length);

    // The first and last half-window are only partly covered by frames.
    expect(maxAbsDifference(original, restored, 2048, length - 2048)).toBeLessThan(1e-5);
  });

  it('round trips at the MDX transform size too', () => {
    const options = { nFft: 7680, hop: 1024, center: true };
    const length = 1024 * 300;
    const original = noise(length, 5);

    const restored = istft(stft(original, options), options, length);

    expect(maxAbsDifference(original, restored, 3840, length - 3840)).toBeLessThan(1e-5);
  });

  it('reconstructs a pure tone at the right frequency and amplitude', () => {
    const options = { nFft: 4096, hop: 1024, center: true };
    const length = 44100;
    const tone = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      tone[i] = 0.5 * Math.sin((2 * Math.PI * 441 * i) / 44100);
    }

    const spectrum = stft(tone, options);
    const restored = istft(spectrum, options, length);

    expect(maxAbsDifference(tone, restored, 2048, length - 2048)).toBeLessThan(1e-5);

    // 441 Hz at 44.1 kHz with n_fft 4096 lands in bin 41.
    let loudest = 0;
    let loudestBin = -1;
    const frame = 20;
    for (let bin = 0; bin < spectrum.bins; bin += 1) {
      const re = spectrum.re[bin * spectrum.frames + frame] ?? 0;
      const im = spectrum.im[bin * spectrum.frames + frame] ?? 0;
      const magnitude = Math.hypot(re, im);
      if (magnitude > loudest) {
        loudest = magnitude;
        loudestBin = bin;
      }
    }
    expect(loudestBin).toBe(41);
  });
});
