import { describe, expect, it } from 'vitest';

import { realTransform } from '../src/dsp/fft.ts';
import {
  clampSemitones,
  createPitchShifter,
  GLIDE_SECONDS,
  MAX_SEMITONES,
  MIN_SEMITONES,
  pitchRatio,
  QUALITY_SEMITONES,
  type PitchShifter,
} from '../src/dsp/pitch-shift.ts';
import { hannPeriodic } from '../src/dsp/stft.ts';

const RATE = 44100;

/** The quantum an AudioWorklet hands over, which is what this is built for. */
const QUANTUM = 128;

/** Long enough for a bin to be well under a semitone wherever it matters. */
const ANALYSIS = 32768;

/** Deterministic pseudo-random signal, so a failure is reproducible. */
function noise(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    out[i] = (state / 4294967296) * 2 - 1;
  }
  return out;
}

function tone(length: number, hz: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
}

function chord(length: number, parts: readonly number[], amplitude: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const hz of parts) {
      sum += amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
    }
    out[i] = sum;
  }
  return out;
}

/**
 * Runs a mono signal through in worklet-sized blocks, calling `before` with
 * the sample index at the head of each block so a test can change the key
 * partway and know where it did.
 */
function runMono(
  shifter: PitchShifter,
  signal: Float32Array,
  before?: (at: number) => void,
): Float32Array {
  const result = new Float32Array(signal.length);
  const into = new Float32Array(QUANTUM);
  const from = new Float32Array(QUANTUM);
  const input = [from];
  const output = [into];
  for (let at = 0; at < signal.length; at += QUANTUM) {
    const take = Math.min(QUANTUM, signal.length - at);
    before?.(at);
    from.fill(0);
    for (let index = 0; index < take; index += 1) {
      from[index] = signal[at + index] ?? 0;
    }
    shifter.process(input, output, take);
    for (let index = 0; index < take; index += 1) {
      result[at + index] = into[index] ?? 0;
    }
  }
  return result;
}

/** Magnitudes of one long Hann-windowed look at a steady part of a signal. */
function magnitudes(signal: Float32Array, from: number): Float64Array {
  const transform = realTransform(ANALYSIS);
  const window = hannPeriodic(ANALYSIS);
  const frame = new Float64Array(ANALYSIS);
  for (let index = 0; index < ANALYSIS; index += 1) {
    frame[index] = (signal[from + index] ?? 0) * (window[index] ?? 0);
  }
  const re = new Float64Array(transform.bins);
  const im = new Float64Array(transform.bins);
  transform.forward(frame, re, im);
  const out = new Float64Array(transform.bins);
  for (let bin = 0; bin < transform.bins; bin += 1) {
    out[bin] = Math.hypot(re[bin] ?? 0, im[bin] ?? 0);
  }
  return out;
}

/**
 * Where a peak really is, to a fraction of a bin. A Hann main lobe is close
 * enough to a parabola in decibels that fitting one through three bins places
 * it an order of magnitude better than the bin spacing, which is what makes a
 * one per cent assertion mean anything at all.
 */
function refine(mags: Float64Array, bin: number): number {
  const level = (at: number): number => Math.log((mags[at] ?? 0) + 1e-30);
  const here = level(bin);
  const below = level(bin - 1);
  const above = level(bin + 1);
  const curve = below - 2 * here + above;
  const offset = curve === 0 ? 0 : (0.5 * (below - above)) / curve;
  return ((bin + offset) * RATE) / ANALYSIS;
}

/** The loudest frequency in a signal. */
function dominantHz(signal: Float32Array, from: number): number {
  const mags = magnitudes(signal, from);
  let loudest = -1;
  let at = 1;
  for (let bin = 1; bin < mags.length - 1; bin += 1) {
    const here = mags[bin] ?? 0;
    if (here > loudest) {
      loudest = here;
      at = bin;
    }
  }
  return refine(mags, at);
}

/**
 * The loudest frequency within `spread` of `hz`. Used only where `spread` is
 * several times the tolerance being asserted and nothing else of the input is
 * inside it, so that looking near the answer cannot be what produces it.
 */
function peakNear(mags: Float64Array, hz: number, spread: number): number {
  const low = Math.max(1, Math.round(((hz - spread) * ANALYSIS) / RATE));
  const high = Math.min(mags.length - 2, Math.round(((hz + spread) * ANALYSIS) / RATE));
  let loudest = -1;
  let at = low;
  for (let bin = low; bin <= high; bin += 1) {
    const here = mags[bin] ?? 0;
    if (here > loudest) {
      loudest = here;
      at = bin;
    }
  }
  return refine(mags, at);
}

/** Where a signal's energy sits, in samples. Survives a pitch shift. */
function centroid(signal: Float32Array): number {
  let weight = 0;
  let moment = 0;
  for (let index = 0; index < signal.length; index += 1) {
    const power = (signal[index] ?? 0) ** 2;
    weight += power;
    moment += power * index;
  }
  return weight === 0 ? 0 : moment / weight;
}

/**
 * The largest absolute value, or null if anything in it is not a number.
 * Scanned rather than asserted per sample: a quarter of a million `expect`
 * calls is a slow test rather than a thorough one.
 */
function peakOrBroken(signal: Float32Array): number | null {
  let worst = 0;
  for (let index = 0; index < signal.length; index += 1) {
    const value = signal[index] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      return null;
    }
    worst = Math.max(worst, Math.abs(value));
  }
  return worst;
}

function worstStep(signal: Float32Array, from: number, to: number): number {
  let worst = 0;
  for (let index = from + 1; index < to; index += 1) {
    worst = Math.max(worst, Math.abs((signal[index] ?? 0) - (signal[index - 1] ?? 0)));
  }
  return worst;
}

function worstDifference(
  signal: Float32Array,
  other: Float32Array,
  from: number,
  to: number,
  shift: number,
): number {
  let worst = 0;
  for (let index = from; index < to; index += 1) {
    worst = Math.max(worst, Math.abs((signal[index] ?? 0) - (other[index - shift] ?? 0)));
  }
  return worst;
}

describe('the range', () => {
  it('guards against a number nobody meant, and allows fractions', () => {
    expect(MIN_SEMITONES).toBe(-24);
    expect(MAX_SEMITONES).toBe(24);
    expect(clampSemitones(99)).toBe(24);
    expect(clampSemitones(-99)).toBe(-24);
    expect(clampSemitones(Number.NaN)).toBe(0);
    expect(clampSemitones(2.5)).toBe(2.5);
  });

  it('keeps the range worth offering well inside the range that works', () => {
    // What the extension's key control stops at. The wider clamp above is a
    // sanity guard; this one is taste, and it is the smaller of the two.
    expect(QUALITY_SEMITONES).toBe(6);
    expect(QUALITY_SEMITONES).toBeLessThan(MAX_SEMITONES);
  });

  it('turns semitones into the ratio a frequency is multiplied by', () => {
    expect(pitchRatio(0)).toBe(1);
    expect(pitchRatio(12)).toBeCloseTo(2, 9);
    expect(pitchRatio(-12)).toBeCloseTo(0.5, 9);
    expect(pitchRatio(6)).toBeCloseTo(Math.SQRT2, 9);
  });
});

describe('the latency', () => {
  /**
   * The whole reason the bypass is a delay rather than a wire. The picture is
   * held back to meet the audio by a number fixed when the capture started, so
   * audio that moved by even a few milliseconds on a key press would slide out
   * of the mouth it came from.
   */
  it('is the same number whether anything is being shifted or not', () => {
    const plain = createPitchShifter({ channels: 2, sampleRate: RATE });
    const shifted = createPitchShifter({ channels: 2, sampleRate: RATE, semitones: 3 });

    expect(shifted.latencySamples).toBe(plain.latencySamples);
    expect(plain.latencySamples).toBe(2048);
  });

  it('is exactly what it says at no shift: the input, delayed, bit for bit', () => {
    const shifter = createPitchShifter({ channels: 1, sampleRate: RATE });
    const signal = noise(20000, 5);

    const out = runMono(shifter, signal);

    const delay = shifter.latencySamples;
    expect(peakOrBroken(out.subarray(0, delay))).toBe(0);
    expect(worstDifference(out, signal, delay, signal.length, delay)).toBe(0);
  });

  it('puts a shifted burst where an unshifted one goes', () => {
    const length = RATE * 3;
    const burst = tone(length, 440);
    // A raised-cosine hump around one second, so there is an envelope to
    // measure. The shift moves the partials and must leave this where it is.
    const centre = RATE;
    const half = Math.round(RATE * 0.2);
    for (let index = 0; index < length; index += 1) {
      const away = Math.abs(index - centre);
      const gate = away >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * away) / half);
      burst[index] = (burst[index] ?? 0) * gate;
    }

    const plain = centroid(runMono(createPitchShifter({ channels: 1, sampleRate: RATE }), burst));
    const shifted = centroid(
      runMono(createPitchShifter({ channels: 1, sampleRate: RATE, semitones: 3 }), burst),
    );

    // A frame smears a transient either side of itself, symmetrically, so the
    // envelope's middle barely moves; a latency that changed with the key
    // would move it by thousands of samples.
    expect(Math.abs(shifted - plain)).toBeLessThan(512);
  });
});

describe('what it does to a tone', () => {
  it('puts a 440 Hz sine an octave up, within one per cent', () => {
    const shifter = createPitchShifter({ channels: 1, sampleRate: RATE, semitones: 12 });

    const out = runMono(shifter, tone(RATE * 3, 440));

    const hz = dominantHz(out, 50000);
    expect(hz).toBeGreaterThan(880 * 0.99);
    expect(hz).toBeLessThan(880 * 1.01);
  });

  it('and an octave down, within one per cent', () => {
    const shifter = createPitchShifter({ channels: 1, sampleRate: RATE, semitones: -12 });

    const out = runMono(shifter, tone(RATE * 3, 440));

    const hz = dominantHz(out, 50000);
    expect(hz).toBeGreaterThan(220 * 0.99);
    expect(hz).toBeLessThan(220 * 1.01);
  });

  it('moves every partial of a chord by the same ratio', () => {
    const parts = [200, 300, 500];
    const shifter = createPitchShifter({ channels: 1, sampleRate: RATE, semitones: 5 });

    const out = runMono(shifter, chord(RATE * 3, parts, 0.25));

    const ratio = pitchRatio(5);
    const mags = magnitudes(out, 50000);
    for (const part of parts) {
      const wanted = part * ratio;
      // The search is 20 Hz wide and the tolerance is one per cent of the
      // answer, which is 2.7 Hz at the lowest partial: a shift that did not
      // happen leaves nothing inside the window at all.
      const found = peakNear(mags, wanted, 20);
      expect(found, `${String(part)} Hz`).toBeGreaterThan(wanted * 0.99);
      expect(found, `${String(part)} Hz`).toBeLessThan(wanted * 1.01);
    }
  });
});

describe('changing the key while it is running', () => {
  it('leaves no step in the waveform bigger than the waveform has', () => {
    const length = RATE * 3;
    const signal = tone(length, 440);
    const shifter = createPitchShifter({ channels: 1, sampleRate: RATE });

    const out = runMono(shifter, signal, (at) => {
      if (at >= RATE && shifter.semitones === 0) {
        shifter.setSemitones(4);
      }
    });

    // A 440 Hz sine at half scale steps by 0.032 a sample and its shifted self
    // by 0.04; a click would be several tenths. This catches one and allows
    // the glide the amplitude wobble it costs.
    expect(worstStep(out, shifter.latencySamples, length)).toBeLessThan(0.12);
    expect(peakOrBroken(out)).not.toBeNull();
  });

  it('comes back to the exact bypass when it is put back to the original key', () => {
    const length = RATE * 4;
    const signal = tone(length, 440);
    const shifter = createPitchShifter({ channels: 1, sampleRate: RATE });
    const changedAt = RATE;
    const backAt = RATE * 2;

    const out = runMono(shifter, signal, (at) => {
      if (at >= changedAt && at < backAt && shifter.semitones !== 4) {
        shifter.setSemitones(4);
      }
      if (at >= backAt && shifter.semitones !== 0) {
        shifter.setSemitones(0);
      }
    });

    const settled =
      backAt + shifter.latencySamples + Math.ceil(GLIDE_SECONDS * RATE) + QUANTUM;
    expect(worstStep(out, shifter.latencySamples, length)).toBeLessThan(0.12);
    expect(worstDifference(out, signal, settled, length, shifter.latencySamples)).toBe(0);
  });

  it('keeps the key across a reset, because a seek is not a change of mind', () => {
    const shifter = createPitchShifter({ channels: 2, sampleRate: RATE });

    shifter.setSemitones(-3);
    shifter.reset();

    expect(shifter.semitones).toBe(-3);
    expect(shifter.latencySamples).toBe(2048);
  });
});

describe('what it refuses to blow up on', () => {
  const cases: readonly { readonly name: string; readonly signal: Float32Array }[] = [
    { name: 'silence', signal: new Float32Array(RATE) },
    { name: 'full-scale noise', signal: noise(RATE, 31) },
    { name: 'direct current', signal: new Float32Array(RATE).fill(1) },
  ];

  for (const { name, signal } of cases) {
    it(`stays finite on ${name}, shifted or not`, () => {
      for (const semitones of [0, 4, -4]) {
        const out = runMono(
          createPitchShifter({ channels: 1, sampleRate: RATE, semitones }),
          signal,
        );
        const worst = peakOrBroken(out);
        expect(worst, `${name} at ${String(semitones)}`).not.toBeNull();
        expect(worst ?? Number.POSITIVE_INFINITY, `${name} at ${String(semitones)}`).toBeLessThan(
          8,
        );
      }
    });
  }

  it('makes nothing out of nothing', () => {
    const out = runMono(
      createPitchShifter({ channels: 1, sampleRate: RATE, semitones: 5 }),
      new Float32Array(RATE),
    );

    expect(peakOrBroken(out)).toBe(0);
  });
});

describe('how fast it is', () => {
  /**
   * It runs on the audio thread in a hundred-and-twenty-eight sample blocks,
   * so the only number that matters is whether ten seconds of stereo takes
   * less than ten seconds. The bound is loose on purpose: a shared machine
   * running a test suite is not where to assert a tight one, and anything
   * near it is a regression worth a bench rather than a flaky test.
   */
  it('gets through ten seconds of stereo well inside ten seconds', () => {
    const length = RATE * 10;
    const left = tone(length, 220, 0.4);
    const right = noise(length, 17);
    const shifter = createPitchShifter({ channels: 2, sampleRate: RATE, semitones: 3 });
    const inLeft = new Float32Array(QUANTUM);
    const inRight = new Float32Array(QUANTUM);
    const input = [inLeft, inRight];

    const began = Date.now();
    for (let at = 0; at < length; at += QUANTUM) {
      for (let index = 0; index < QUANTUM; index += 1) {
        inLeft[index] = left[at + index] ?? 0;
        inRight[index] = right[at + index] ?? 0;
      }
      shifter.process(input, input, QUANTUM);
    }
    const took = Date.now() - began;

    expect(took).toBeLessThan(5000);
  }, 60_000);
});
