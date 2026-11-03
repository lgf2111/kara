import { describe, expect, it } from 'vitest';

import {
  FALLBACK_BANDS,
  candidateBands,
  pickBand,
  rankBands,
  scoreBand,
  type Band,
} from '../src/lyrics/bands.ts';
import { prepareForOcr, rowEdgeEnergy, toGray } from '../src/lyrics/pixels.ts';
import type { OcrFrame } from '../src/lyrics/lines.ts';

// Synthetic frames, not a video. A row of text is modelled as hard vertical
// stripes, because that is the only thing about a line of words these helpers
// measure: brightness changing many times along a row. The readings are
// placeholder words, never real lyrics.

const WIDTH = 20;
const HEIGHT = 50;

/** A grey frame: flat background, with stripes on the rows named. */
function frameWith(textRows: readonly number[]): Uint8Array {
  const gray = new Uint8Array(WIDTH * HEIGHT).fill(40);
  for (const row of textRows) {
    for (let x = 0; x < WIDTH; x += 1) {
      gray[row * WIDTH + x] = x % 2 === 0 ? 40 : 200;
    }
  }
  return gray;
}

function energyOf(textRows: readonly number[]): Float32Array {
  return rowEdgeEnergy(frameWith(textRows), WIDTH, HEIGHT);
}

function frames(count: number, textRows: readonly number[]): Float32Array[] {
  return Array.from({ length: count }, () => energyOf(textRows));
}

/** RGBA pixels at the brightnesses given, over a half-transparent alpha. */
function rgba(values: readonly number[]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(values.length * 4);
  values.forEach((value, index) => {
    pixels.set([value, value, value, 128], index * 4);
  });
  return pixels;
}

function brightness(pixels: Uint8ClampedArray): number[] {
  return [...toGray(pixels)];
}

function reading(text: string, confidence: number): OcrFrame {
  return { seconds: 0, text, confidence };
}

describe('toGray', () => {
  it('reads one byte of brightness per pixel and ignores the alpha', () => {
    expect([...toGray(new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 0]))]).toEqual([
      10, 200,
    ]);
  });

  it('weights the channels so a grey pixel stays itself', () => {
    expect([...toGray(new Uint8ClampedArray([255, 0, 0, 255]))]).toEqual([76]);
  });
});

describe('rowEdgeEnergy', () => {
  it('finds the row the text is on and leaves the flat rows at nothing', () => {
    const energy = energyOf([10]);

    expect(energy).toHaveLength(HEIGHT);
    expect(energy[10]).toBeCloseTo(160, 4);
    expect(energy[9]).toBe(0);
    expect(energy[11]).toBe(0);
  });

  it('has no row to measure in a frame one pixel wide', () => {
    expect([...rowEdgeEnergy(new Uint8Array(3), 1, 3)]).toEqual([0, 0, 0]);
  });
});

describe('rankBands', () => {
  it('finds the band that holds text in frame after frame', () => {
    const bands = rankBands(frames(8, [20, 21]));

    expect(bands).toHaveLength(1);
    expect(bands[0]?.recurrence).toBe(1);
    expect(bands[0]?.energy).toBeCloseTo(1, 3);
    // The rows found, plus the default margin of 2% of the frame.
    expect(bands[0]?.top).toBeCloseTo(0.38, 5);
    expect(bands[0]?.bottom).toBeCloseTo(0.46, 5);
  });

  it('ignores a band that is only busy in one frame', () => {
    const energies = [...frames(7, [20, 21]), energyOf([20, 21, 5, 6])];

    expect(rankBands(energies)).toHaveLength(1);
  });

  it('ranks the band that recurs most often first', () => {
    const energies = [...frames(7, [20, 21]), energyOf([20, 21, 5, 6])];

    const bands = rankBands(energies, { minRecurrence: 0.1 });

    expect(bands).toHaveLength(2);
    expect(bands[0]?.top).toBeCloseTo(0.38, 5);
    expect(bands[0]?.recurrence).toBe(1);
    expect(bands[1]?.recurrence).toBeCloseTo(0.125, 3);
  });

  it('joins rows a descender gap left out of one band', () => {
    const bands = rankBands(frames(4, [10, 12]));

    expect(bands).toHaveLength(1);
    expect(bands[0]?.top).toBeCloseTo(0.18, 5);
    expect(bands[0]?.bottom).toBeCloseTo(0.28, 5);
  });

  it('calls a single busy row noise rather than a line', () => {
    expect(rankBands(frames(4, [10]))).toEqual([]);
    expect(rankBands(frames(4, [10]), { minRows: 1 })).toHaveLength(1);
  });

  it('refuses a band that covers most of the frame', () => {
    const everyRow = Array.from({ length: HEIGHT }, (_unused, row) => row);

    expect(rankBands(frames(4, everyRow))).toEqual([]);
  });

  it('has nothing to rank without frames', () => {
    expect(rankBands([])).toEqual([]);
    expect(rankBands([new Float32Array(0)])).toEqual([]);
  });

  it('leaves out a frame of a different height, votes and all', () => {
    const energies = [...frames(2, [20, 21]), new Float32Array(10)];

    const bands = rankBands(energies);

    expect(bands).toHaveLength(1);
    expect(bands[0]?.recurrence).toBe(1);
  });
});

describe('candidateBands', () => {
  it('offers the ranking when there is one', () => {
    expect(candidateBands(frames(4, [20, 21]), 3)).toHaveLength(1);
  });

  it('falls back to where lyric videos usually put the words', () => {
    expect(candidateBands([], 3)).toEqual(FALLBACK_BANDS.slice(0, 3));
    expect(candidateBands([], 2)).toHaveLength(2);
  });
});

describe('scoreBand', () => {
  const band: Band = { top: 0.8, bottom: 0.9, recurrence: 1, energy: 1 };

  it('counts the readings worth keeping and averages their confidence', () => {
    const trial = scoreBand(band, [
      reading('alpha beta', 90),
      reading('alpha bela', 80),
      reading('', 0),
    ]);

    expect(trial.hits).toBe(2);
    expect(trial.confidence).toBe(85);
    expect(trial.band).toBe(band);
  });

  it('scores a band that only caught furniture at nothing', () => {
    const trial = scoreBand(band, [reading('|| :: --', 95), reading('al', 95)]);

    expect(trial.hits).toBe(0);
    expect(trial.confidence).toBe(0);
  });
});

describe('pickBand', () => {
  const low: Band = { top: 0.1, bottom: 0.2, recurrence: 1, energy: 1 };
  const high: Band = { top: 0.8, bottom: 0.9, recurrence: 1, energy: 1 };

  it('prefers the band that read something in more frames', () => {
    const once = scoreBand(low, [reading('alpha beta', 95)]);
    const always = scoreBand(high, [reading('alpha beta', 70), reading('gamma delta', 70)]);

    expect(pickBand([once, always])?.band).toBe(high);
  });

  it('breaks a tie on confidence', () => {
    const unsure = scoreBand(low, [reading('alpha beta', 60)]);
    const sure = scoreBand(high, [reading('alpha beta', 95)]);

    expect(pickBand([unsure, sure])?.band).toBe(high);
  });

  it('picks nothing when no band read anything', () => {
    expect(pickBand([scoreBand(low, [reading('||', 95)])])).toBeNull();
    expect(pickBand([])).toBeNull();
  });
});

describe('prepareForOcr', () => {
  it('stretches the contrast between the two percentiles', () => {
    const pixels = rgba([0, 50, 100, 150, 200]);

    prepareForOcr(pixels, { lowShare: 0.2, highShare: 0.8, negate: false });

    expect(brightness(pixels)).toEqual([0, 85, 170, 255, 255]);
  });

  it('inverts, because lyric videos are light text on a dark picture', () => {
    const pixels = rgba([0, 85, 170, 255]);

    prepareForOcr(pixels);

    expect(brightness(pixels)).toEqual([255, 170, 85, 0]);
  });

  it('only inverts a flat crop, which has no contrast to stretch', () => {
    const pixels = rgba([128, 128, 128]);

    prepareForOcr(pixels);

    expect(brightness(pixels)).toEqual([127, 127, 127]);
  });

  it('leaves the crop opaque, whatever it was drawn over', () => {
    const pixels = rgba([10, 200]);

    prepareForOcr(pixels);

    expect([pixels[3], pixels[7]]).toEqual([255, 255]);
  });

  it('has nothing to do to no pixels', () => {
    expect(() => {
      prepareForOcr(new Uint8ClampedArray(0));
    }).not.toThrow();
  });
});
