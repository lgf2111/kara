import { describe, expect, it } from 'vitest';

import {
  comparisonKey,
  dominantRegion,
  durationStats,
  editDistance,
  groupFrames,
  keepFrame,
  linesFromFrames,
  mergeShortGaps,
  normaliseText,
  pngSize,
  similarity,
  unionBox,
} from './lyric-ocr.mjs';

// Every string here is made up. Real lyrics are never committed, not even in a
// test fixture, so the words are placeholders and the OCR slips are spelt by
// hand: 'alpha bela' is what a frame of 'alpha beta' can come back as.

/**
 * @param {number} seconds
 * @param {string} text
 * @param {number} confidence
 * @returns {import('./lyric-ocr.mjs').Frame}
 */
function frame(seconds, text, confidence = 80) {
  return { seconds, text, confidence };
}

describe('normaliseText', () => {
  it('collapses the line breaks OCR invents', () => {
    expect(normaliseText('alpha\nbeta\n\ngamma')).toBe('alpha beta gamma');
    expect(normaliseText('  alpha   beta  ')).toBe('alpha beta');
  });

  it('removes zero-width and control characters', () => {
    expect(normaliseText('alpha\u200bbeta')).toBe('alpha beta');
    expect(normaliseText('alpha\u0000 beta')).toBe('alpha beta');
  });

  it('leaves nothing for a frame with no text', () => {
    expect(normaliseText('')).toBe('');
    expect(normaliseText(' \n \t ')).toBe('');
  });
});

describe('comparisonKey', () => {
  it('ignores the case and punctuation OCR guesses at', () => {
    expect(comparisonKey('Alpha, BETA!')).toBe('alpha beta');
    expect(comparisonKey('alpha-beta')).toBe('alphabeta');
    expect(comparisonKey('"alpha beta"')).toBe('alpha beta');
  });

  it('keeps digits and non-Latin letters', () => {
    expect(comparisonKey('Alpha 42')).toBe('alpha 42');
    expect(comparisonKey('一二 三')).toBe('一二 三');
  });
});

describe('editDistance', () => {
  it('counts the characters that have to change', () => {
    expect(editDistance('alpha', 'alpha')).toBe(0);
    expect(editDistance('alpha', 'alpho')).toBe(1);
    expect(editDistance('alpha beta', 'alpha bela')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('falls back to the length when one side is empty', () => {
    expect(editDistance('', 'alpha')).toBe(5);
    expect(editDistance('alpha', '')).toBe(5);
    expect(editDistance('', '')).toBe(0);
  });
});

describe('similarity', () => {
  it('scores an OCR slip as nearly the same line', () => {
    expect(similarity('alpha beta', 'alpha beta')).toBe(1);
    expect(similarity('alpha beta', 'alpha bela')).toBeCloseTo(0.9, 5);
  });

  it('scores a different line as different', () => {
    expect(similarity('alpha', 'gamma')).toBeCloseTo(0.2, 5);
    expect(similarity('alpha beta', 'gamma delta')).toBeLessThan(0.5);
  });

  it('calls two empty readings identical', () => {
    expect(similarity('', '')).toBe(1);
  });
});

describe('keepFrame', () => {
  it('keeps a confident reading that looks like words', () => {
    expect(keepFrame(frame(0, 'alpha beta', 80))).toBe(true);
  });

  it('drops a reading OCR is unsure of', () => {
    expect(keepFrame(frame(0, 'alpha beta', 20))).toBe(false);
    expect(keepFrame(frame(0, 'alpha beta', Number.NaN))).toBe(false);
    expect(keepFrame(frame(0, 'alpha beta', 20), { minConfidence: 10 })).toBe(true);
  });

  it('drops a reading too short to be a line', () => {
    expect(keepFrame(frame(0, '', 90))).toBe(false);
    expect(keepFrame(frame(0, 'al', 90))).toBe(false);
  });

  it('drops the symbols OCR makes of a busy background', () => {
    expect(keepFrame(frame(0, '|| -- ::', 90))).toBe(false);
    expect(keepFrame(frame(0, '~*~ alpha beta', 90))).toBe(true);
  });
});

describe('groupFrames', () => {
  const options = { frameSeconds: 0.5 };

  it('turns a run of like frames into one timed line', () => {
    const lines = groupFrames(
      [frame(0, 'alpha beta', 80), frame(0.5, 'alpha bela', 70), frame(1, 'alpha beta', 85)],
      options,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('alpha beta');
    expect(lines[0]?.startSeconds).toBe(0);
    expect(lines[0]?.endSeconds).toBe(1.5);
    expect(lines[0]?.frames).toBe(3);
    expect(lines[0]?.confidence).toBeCloseTo(78.3, 1);
  });

  it('starts a new line when the screen changes', () => {
    const lines = groupFrames(
      [frame(0, 'alpha beta'), frame(0.5, 'alpha beta'), frame(1, 'gamma delta')],
      options,
    );

    expect(lines.map((line) => line.text)).toEqual(['alpha beta', 'gamma delta']);
    expect(lines[0]?.endSeconds).toBe(1);
    expect(lines[1]?.startSeconds).toBe(1);
  });

  it('closes the open line on a frame it drops', () => {
    const lines = groupFrames(
      [frame(0, 'alpha beta', 80), frame(0.5, 'alpha beta', 20), frame(1, 'alpha beta', 80)],
      options,
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]?.endSeconds).toBe(0.5);
    expect(lines[1]?.startSeconds).toBe(1);
  });

  it('takes the text from the most confident frame of the run', () => {
    const lines = groupFrames([frame(0, 'alpha bela', 60), frame(0.5, 'alpha beta', 90)], options);

    expect(lines[0]?.text).toBe('alpha beta');
  });

  it('reads frames in time order whatever order they arrive in', () => {
    const lines = groupFrames([frame(1, 'gamma delta'), frame(0, 'alpha beta')], options);

    expect(lines.map((line) => line.startSeconds)).toEqual([0, 1]);
  });

  it('finds nothing in frames with nothing on them', () => {
    expect(groupFrames([frame(0, '', 0), frame(0.5, '', 0)], options)).toEqual([]);
  });
});

describe('mergeShortGaps', () => {
  /** @type {import('./lyric-ocr.mjs').Line} */
  const first = { text: 'alpha beta', startSeconds: 0, endSeconds: 0.5, frames: 1, confidence: 80 };
  /** @type {import('./lyric-ocr.mjs').Line} */
  const second = { text: 'alpha bela', startSeconds: 1, endSeconds: 1.5, frames: 1, confidence: 60 };

  it('closes a hole OCR left in the middle of a line', () => {
    const merged = mergeShortGaps([first, second], { maxGapSeconds: 0.75 });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('alpha beta');
    expect(merged[0]?.startSeconds).toBe(0);
    expect(merged[0]?.endSeconds).toBe(1.5);
    expect(merged[0]?.frames).toBe(2);
    expect(merged[0]?.confidence).toBe(70);
  });

  it('leaves a hole that is too long alone', () => {
    expect(mergeShortGaps([first, second], { maxGapSeconds: 0.25 })).toHaveLength(2);
  });

  it('never joins two different lines', () => {
    /** @type {import('./lyric-ocr.mjs').Line} */
    const other = { text: 'gamma delta', startSeconds: 0.5, endSeconds: 1, frames: 1, confidence: 80 };

    expect(mergeShortGaps([first, other], { maxGapSeconds: 0.75 })).toHaveLength(2);
  });
});

describe('linesFromFrames', () => {
  it('rejoins a line a dropped frame split in two', () => {
    const lines = linesFromFrames(
      [frame(0, 'alpha beta', 80), frame(0.5, 'alpha beta', 20), frame(1, 'alpha beta', 80)],
      { frameSeconds: 0.5 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.startSeconds).toBe(0);
    expect(lines[0]?.endSeconds).toBe(1.5);
  });

  it('drops a line too short to have been sung', () => {
    const lines = linesFromFrames(
      [frame(0, 'alpha beta'), frame(0.2, 'alpha beta'), frame(1, 'gamma delta')],
      { frameSeconds: 0.2, minLineSeconds: 0.4 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('alpha beta');
    expect(lines[0]?.endSeconds).toBe(0.4);
  });

  it('keeps a line that lasts exactly one frame when that is long enough', () => {
    const lines = linesFromFrames([frame(0, 'alpha beta')], { frameSeconds: 0.5 });

    expect(lines).toHaveLength(1);
  });
});

describe('durationStats', () => {
  /**
   * @param {number[]} durations
   * @returns {import('./lyric-ocr.mjs').Line[]}
   */
  const linesOf = (durations) =>
    durations.map((duration, index) => ({
      text: 'alpha beta',
      startSeconds: index * 10,
      endSeconds: index * 10 + duration,
      frames: 1,
      confidence: 80,
    }));

  it('summarises the line lengths', () => {
    expect(durationStats(linesOf([3, 1, 2]))).toEqual({
      count: 3,
      medianSeconds: 2,
      minSeconds: 1,
      maxSeconds: 3,
    });
  });

  it('averages the middle two when there is no middle line', () => {
    expect(durationStats(linesOf([1, 2, 3, 4])).medianSeconds).toBe(2.5);
  });

  it('reports no durations rather than zero ones', () => {
    expect(durationStats([])).toEqual({
      count: 0,
      medianSeconds: null,
      minSeconds: null,
      maxSeconds: null,
    });
  });
});

describe('unionBox', () => {
  it('holds every box it is given', () => {
    expect(
      unionBox([
        { x0: 10, y0: 20, x1: 30, y1: 40 },
        { x0: 5, y0: 25, x1: 20, y1: 50 },
      ]),
    ).toEqual({ x0: 5, y0: 20, x1: 30, y1: 50 });
  });

  it('copes with a box given corner first', () => {
    expect(unionBox([{ x0: 30, y0: 40, x1: 10, y1: 20 }])).toEqual({
      x0: 10,
      y0: 20,
      x1: 30,
      y1: 40,
    });
  });

  it('ignores a box with a coordinate that is not a number', () => {
    expect(unionBox([{ x0: Number.NaN, y0: 0, x1: 10, y1: 10 }])).toBeNull();
    expect(unionBox([])).toBeNull();
  });
});

describe('dominantRegion', () => {
  const frameSize = { width: 100, height: 100, grid: 10 };

  it('finds the band that holds text most often', () => {
    const bottom = { x0: 10, y0: 80, x1: 90, y1: 90 };
    const region = dominantRegion(
      [bottom, bottom, bottom, { x0: 0, y0: 0, x1: 100, y1: 10 }],
      frameSize,
    );

    expect(region).toEqual({ left: 0.1, top: 0.8, right: 1, bottom: 1, coverage: 0.75 });
  });

  it('has nothing to guess from without boxes or a frame size', () => {
    expect(dominantRegion([], frameSize)).toBeNull();
    expect(dominantRegion([{ x0: 0, y0: 0, x1: 1, y1: 1 }], { width: 0, height: 0 })).toBeNull();
  });
});

describe('pngSize', () => {
  /**
   * @param {number} width
   * @param {number} height
   * @returns {Uint8Array}
   */
  function header(width, height) {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0, 0, 0, 13], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    new DataView(bytes.buffer).setUint32(16, width, false);
    new DataView(bytes.buffer).setUint32(20, height, false);
    return bytes;
  }

  it('reads the pixel size of a frame', () => {
    expect(pngSize(header(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('refuses anything that is not a PNG header', () => {
    expect(pngSize(new Uint8Array(24))).toBeNull();
    expect(pngSize(header(1920, 1080).subarray(0, 20))).toBeNull();
    expect(pngSize(header(0, 1080))).toBeNull();

    const notIhdr = header(1920, 1080);
    notIhdr.set([0x49, 0x44, 0x41, 0x54], 12); // IDAT
    expect(pngSize(notIhdr)).toBeNull();
  });
});
