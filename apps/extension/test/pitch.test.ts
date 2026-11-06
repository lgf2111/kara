import { describe, expect, it } from 'vitest';

import {
  centsBetween,
  detectPitch,
  downsampleForPitch,
  hzToMidi,
  midiToHz,
  noteName,
} from '../src/audio/pitch.ts';

function sine(hz: number, sampleRate: number, length: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate);
  }
  return samples;
}

function noise(length: number, amplitude = 0.2): Float32Array {
  const samples = new Float32Array(length);
  let seed = 0x1234567;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    samples[index] = ((seed / 0xffffffff) * 2 - 1) * amplitude;
  }
  return samples;
}

function partials(
  parts: readonly (readonly [number, number])[],
  sampleRate: number,
  length: number,
): Float32Array {
  const samples = new Float32Array(length);
  for (const [hz, amplitude] of parts) {
    for (let index = 0; index < length; index += 1) {
      samples[index] =
        (samples[index] ?? 0) + amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate);
    }
  }
  return samples;
}

describe('detectPitch', () => {
  it('finds A4 in a 440 Hz sine', () => {
    const reading = detectPitch(sine(440, 44_100, 2048), 44_100);

    expect(reading.hz).toBeCloseTo(440, 0);
    expect(reading.midi).toBeCloseTo(69, 1);
    expect(reading.clarity).toBeGreaterThan(0.9);
  });

  it('finds A3 in a 220 Hz sine', () => {
    const reading = detectPitch(sine(220, 44_100, 2048), 44_100);

    expect(reading.hz).toBeCloseTo(220, 0);
    expect(reading.midi).toBeCloseTo(57, 1);
  });

  it('reads the same note at the analysis rate', () => {
    const reading = detectPitch(sine(440, 16_000, 1024), 16_000);

    expect(reading.hz).toBeCloseTo(440, 0);
    expect(reading.midi).toBeCloseTo(69, 1);
  });

  it('returns no pitch for silence', () => {
    const reading = detectPitch(new Float32Array(2048), 44_100);

    expect(reading.hz).toBeNull();
    expect(reading.midi).toBeNull();
    expect(reading.level).toBe(0);
  });

  it('rejects noise as unpitched or very unclear', () => {
    const reading = detectPitch(noise(2048), 44_100);

    expect(reading.hz === null || reading.clarity < 0.5).toBe(true);
  });

  it('does not report a quiet frame as a note', () => {
    const reading = detectPitch(sine(440, 44_100, 2048, 0.0001), 44_100);

    expect(reading.hz).toBeNull();
  });

  it('does not report a DC offset as a note', () => {
    const reading = detectPitch(new Float32Array(2048).fill(0.2), 44_100);

    expect(reading.hz).toBeNull();
    expect(reading.level).toBe(0);
  });

  it('keeps a strong second harmonic on the fundamental', () => {
    const frame = partials([[220, 0.15], [440, 0.5]], 16_000, 1024);
    const reading = detectPitch(frame, 16_000, { minClarity: 0.75 });

    expect(reading.hz).toBeCloseTo(220, -1);
    expect(reading.midi).toBeCloseTo(57, 0);
  });

  it('keeps a weak fundamental under a strong second harmonic', () => {
    const frame = partials([[220, 0.03], [440, 0.45]], 16_000, 1024);
    const reading = detectPitch(frame, 16_000, { minClarity: 0.75 });

    expect(reading.hz).toBeCloseTo(220, -1);
    expect(reading.midi).toBeCloseTo(57, 0);
  });

  it('keeps a fundamental under a strong third harmonic', () => {
    const frame = partials([[220, 0.05], [660, 0.5]], 16_000, 1024);
    const reading = detectPitch(frame, 16_000, { minClarity: 0.75 });

    expect(reading.hz).toBeCloseTo(220, -1);
    expect(reading.midi).toBeCloseTo(57, 0);
  });

  it('does not fold a genuine high note down an octave', () => {
    const pure = detectPitch(sine(880, 16_000, 1024), 16_000, { minClarity: 0.75 });
    const rich = detectPitch(partials([[660, 0.4], [1320, 0.2]], 16_000, 1024), 16_000, {
      minClarity: 0.75,
    });

    expect(pure.hz).toBeCloseTo(880, -1);
    expect(pure.midi).toBeCloseTo(81, 0);
    expect(rich.hz).toBeCloseTo(660, -1);
    expect(rich.midi).toBeCloseTo(76, 0);
  });
});

describe('note arithmetic', () => {
  it('maps 440 Hz to A4 and back', () => {
    expect(hzToMidi(440)).toBeCloseTo(69);
    expect(midiToHz(69)).toBeCloseTo(440);
    expect(noteName(69)).toBe('A4');
    expect(noteName(60)).toBe('C4');
  });

  it('counts cents from the target', () => {
    const sharp = midiToHz(69.5);
    const flat = midiToHz(68.5);

    expect(centsBetween(sharp, 440)).toBeCloseTo(50, 5);
    expect(centsBetween(flat, 440)).toBeCloseTo(-50, 5);
    expect(centsBetween(440, 440)).toBe(0);
  });

  it('has no answer for a nonsense frequency', () => {
    expect(Number.isNaN(hzToMidi(0))).toBe(true);
    expect(Number.isNaN(centsBetween(0, 440))).toBe(true);
    expect(noteName(Number.NaN)).toBe('?');
  });
});

describe('downsampleForPitch', () => {
  it('reduces a 44.1 kHz buffer to the analysis rate', () => {
    const down = downsampleForPitch(sine(440, 44_100, 44_100), 44_100);

    expect(down.length).toBe(16_000);
    expect(down[1234]).toBeTypeOf('number');
  });

  it('leaves a buffer already at the analysis rate alone', () => {
    const input = sine(440, 16_000, 1000);
    const down = downsampleForPitch(input, 16_000);

    expect(down.length).toBe(input.length);
    expect(down[10]).toBeCloseTo(input[10] ?? 0);
  });
});
