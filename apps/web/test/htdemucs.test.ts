import { describe, expect, it } from 'vitest';

import {
  HOP,
  NFFT,
  SEGMENT_SAMPLES,
  SOURCES,
  VOCALS_INDEX,
  createHtdemucsHost,
  framing,
  packMagnitude,
  readStemSpectrum,
  readStemWaveform,
  reflectPad,
} from '../src/separation/htdemucs.ts';

function noise(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    out[i] = (state / 4294967296) * 2 - 1;
  }
  return out;
}

function rms(signal: Float32Array, from = 0, to = signal.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    sum += (signal[i] ?? 0) ** 2;
  }
  return Math.sqrt(sum / Math.max(1, to - from));
}

function maxAbsDifference(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let worst = 0;
  for (let i = from; i < to; i += 1) {
    worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return worst;
}

describe('demucs framing', () => {
  it('reproduces the export contract for its fixed segment', () => {
    const shape = framing(SEGMENT_SAMPLES);
    expect(shape.frames).toBe(336);
    expect(shape.bins).toBe(2048);
    expect(shape.pad).toBe(1536);
    expect(shape.paddedLength).toBe(347136);
    // demucs asserts the padded signal yields exactly le + 4 frames.
    expect(shape.paddedFrames).toBe(shape.frames + 4);
  });

  it('rounds the signal up to a whole number of hops', () => {
    for (const length of [SEGMENT_SAMPLES, 44100, HOP, HOP * 7 + 1]) {
      const shape = framing(length);
      expect(shape.frames).toBe(Math.ceil(length / HOP));
      expect(shape.paddedLength).toBe(2 * shape.pad + shape.frames * HOP);
      expect(shape.paddedFrames).toBe(shape.frames + 4);
    }
  });

  it('names the stems in the order the model emits them', () => {
    expect([...SOURCES]).toEqual(['drums', 'bass', 'other', 'vocals']);
    expect(SOURCES[VOCALS_INDEX]).toBe('vocals');
  });
});

describe('reflectPad', () => {
  it('reflects without repeating the edge sample', () => {
    const source = Float32Array.from([1, 2, 3, 4, 5]);
    const target = new Float32Array(9);
    reflectPad(source, 2, 2, target);
    expect([...target]).toEqual([3, 2, 1, 2, 3, 4, 5, 4, 3]);
  });

  it('folds padding wider than the signal', () => {
    const source = Float32Array.from([1, 2, 3]);
    const target = new Float32Array(7);
    reflectPad(source, 2, 2, target);
    expect([...target]).toEqual([3, 2, 1, 2, 3, 2, 1]);
  });
});

describe('spec and ispec', () => {
  it('round trips broadband audio, losing only the Nyquist bin', () => {
    const host = createHtdemucsHost(SEGMENT_SAMPLES);
    const { bins, frames } = host.framing;
    const original = noise(SEGMENT_SAMPLES, 7);
    const re = new Float32Array(bins * frames);
    const im = new Float32Array(bins * frames);
    const restored = new Float32Array(SEGMENT_SAMPLES);

    host.spec(original, re, im);
    host.ispec(re, im, restored);

    // demucs drops the Nyquist bin, so white noise cannot come back exactly:
    // one bin of 2049 is about 2.2% of the amplitude, and that is what the
    // interior error is. Energy is otherwise preserved.
    expect(rms(restored) / rms(original)).toBeGreaterThan(0.995);
    expect(rms(restored) / rms(original)).toBeLessThan(1.005);
    const edge = 2 * NFFT;
    expect(maxAbsDifference(original, restored, edge, SEGMENT_SAMPLES - edge)).toBeLessThan(0.05);
  });

  it('round trips a band-limited signal almost exactly in the interior', () => {
    const host = createHtdemucsHost(SEGMENT_SAMPLES);
    const { bins, frames } = host.framing;
    const tone = new Float32Array(SEGMENT_SAMPLES);
    for (let i = 0; i < tone.length; i += 1) {
      tone[i] =
        0.4 * Math.sin((2 * Math.PI * 440 * i) / 44100) +
        0.2 * Math.sin((2 * Math.PI * 3000 * i) / 44100);
    }
    const re = new Float32Array(bins * frames);
    const im = new Float32Array(bins * frames);
    const restored = new Float32Array(SEGMENT_SAMPLES);

    host.spec(tone, re, im);
    host.ispec(re, im, restored);

    // With no energy near Nyquist the only error left is float32 rounding.
    const edge = 2 * NFFT;
    expect(maxAbsDifference(tone, restored, edge, SEGMENT_SAMPLES - edge)).toBeLessThan(1e-3);
  });

  it('confines the edge error to the frames demucs zeroes, which overlap covers', () => {
    const host = createHtdemucsHost(SEGMENT_SAMPLES);
    const { bins, frames } = host.framing;
    const tone = new Float32Array(SEGMENT_SAMPLES);
    for (let i = 0; i < tone.length; i += 1) {
      tone[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    }
    const re = new Float32Array(bins * frames);
    const im = new Float32Array(bins * frames);
    const restored = new Float32Array(SEGMENT_SAMPLES);

    host.spec(tone, re, im);
    host.ispec(re, im, restored);

    // Two zeroed frames at each end leave the window-sum short there, so the
    // first and last few thousand samples are attenuated. The pipeline uses a
    // 25% overlap, about 86000 samples, so a neighbour always covers them.
    const edge = 2 * NFFT;
    expect(maxAbsDifference(tone, restored, 0, edge)).toBeGreaterThan(1e-3);
    expect(maxAbsDifference(tone, restored, edge, SEGMENT_SAMPLES - edge)).toBeLessThan(1e-3);
  });

  it('normalises the way torch.stft(normalized=True) does', () => {
    // A constant signal puts all its energy in bin 0, scaled by 1/sqrt(nfft).
    const host = createHtdemucsHost(HOP * 8);
    const { bins, frames } = host.framing;
    const constant = new Float32Array(HOP * 8).fill(1);
    const re = new Float32Array(bins * frames);
    const im = new Float32Array(bins * frames);

    host.spec(constant, re, im);

    // Hann sums to nfft/2 over a full window, then the normalisation divides
    // by sqrt(nfft): 2048 / 64 = 32.
    const middleFrame = Math.floor(frames / 2);
    expect(re[middleFrame] ?? 0).toBeCloseTo((NFFT / 2) / Math.sqrt(NFFT), 2);
  });
});

describe('tensor layouts', () => {
  it('packs mag as [left real, left imaginary, right real, right imaginary]', () => {
    const bins = 2;
    const frames = 3;
    const plane = bins * frames;
    const target = new Float32Array(4 * plane);
    const make = (base: number) => Float32Array.from({ length: plane }, (_, i) => base + i);

    packMagnitude(target, make(10), make(20), make(30), make(40), bins, frames);

    expect([...target.subarray(0, plane)]).toEqual([...make(10)]);
    expect([...target.subarray(plane, 2 * plane)]).toEqual([...make(20)]);
    expect([...target.subarray(2 * plane, 3 * plane)]).toEqual([...make(30)]);
    expect([...target.subarray(3 * plane, 4 * plane)]).toEqual([...make(40)]);
  });

  it('reads a stem spectrum back out of the model output', () => {
    const bins = 2;
    const frames = 2;
    const plane = bins * frames;
    const stems = 4;
    const x = new Float32Array(stems * 4 * plane);
    for (let i = 0; i < x.length; i += 1) {
      x[i] = i;
    }
    const re = new Float32Array(plane);
    const im = new Float32Array(plane);

    readStemSpectrum(x, 2, 1, bins, frames, re, im);

    // stem 2 starts at 2 * 4 * plane; channel 1 is planes 2 and 3 of that stem.
    const base = 2 * 4 * plane + 2 * plane;
    expect([...re]).toEqual([...x.subarray(base, base + plane)]);
    expect([...im]).toEqual([...x.subarray(base + plane, base + 2 * plane)]);
  });

  it('reads a stem waveform back out of the time branch', () => {
    const length = 5;
    const xt = new Float32Array(4 * 2 * length);
    for (let i = 0; i < xt.length; i += 1) {
      xt[i] = i;
    }

    const right = readStemWaveform(xt, VOCALS_INDEX, 1, length);

    const base = VOCALS_INDEX * 2 * length + length;
    expect([...right]).toEqual([...xt.subarray(base, base + length)]);
  });
});
