import { describe, expect, it } from 'vitest';

import {
  comparisonKey,
  durationStats,
  editDistance,
  groupFrames,
  keepFrame,
  linesFromFrames,
  mergeShortGaps,
  normaliseText,
  similarity,
  toLyricLines,
  type GroupedLine,
  type OcrFrame,
} from '../src/lyrics/lines.ts';

// Every string here is made up. Real lyrics are never committed, not even in a
// test fixture, so the words are placeholders and the OCR slips are spelt by
// hand: 'alpha bela' is what a frame of 'alpha beta' can come back as.

function frame(seconds: number, text: string, confidence = 80): OcrFrame {
  return { seconds, text, confidence };
}

function line(overrides: Partial<GroupedLine> = {}): GroupedLine {
  return {
    text: 'alpha beta',
    startSeconds: 0,
    endSeconds: 0.5,
    frames: 1,
    confidence: 80,
    ...overrides,
  };
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
  });

  it('keeps digits and non-Latin letters', () => {
    expect(comparisonKey('Alpha 42')).toBe('alpha 42');
    expect(comparisonKey('一二 三')).toBe('一二 三');
  });
});

describe('editDistance', () => {
  it('counts the characters that have to change', () => {
    expect(editDistance('alpha', 'alpha')).toBe(0);
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

    expect(lines.map((found) => found.text)).toEqual(['alpha beta', 'gamma delta']);
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

    expect(lines.map((found) => found.startSeconds)).toEqual([0, 1]);
  });

  it('finds nothing in frames with nothing on them', () => {
    expect(groupFrames([frame(0, '', 0), frame(0.5, '', 0)], options)).toEqual([]);
  });
});

describe('mergeShortGaps', () => {
  const first = line();
  const second = line({ text: 'alpha bela', startSeconds: 1, endSeconds: 1.5, confidence: 60 });

  it('closes a hole OCR left in the middle of a line', () => {
    const merged = mergeShortGaps([first, second], { maxGapSeconds: 0.75 });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('alpha beta');
    expect(merged[0]?.endSeconds).toBe(1.5);
    expect(merged[0]?.frames).toBe(2);
    expect(merged[0]?.confidence).toBe(70);
  });

  it('leaves a hole that is too long alone', () => {
    expect(mergeShortGaps([first, second], { maxGapSeconds: 0.25 })).toHaveLength(2);
  });

  it('never joins two different lines', () => {
    const other = line({ text: 'gamma delta', startSeconds: 0.5, endSeconds: 1 });

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
    expect(linesFromFrames([frame(0, 'alpha beta')], { frameSeconds: 0.5 })).toHaveLength(1);
  });
});

describe('durationStats', () => {
  const linesOf = (durations: readonly number[]): GroupedLine[] =>
    durations.map((duration, index) =>
      line({ startSeconds: index * 10, endSeconds: index * 10 + duration }),
    );

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

describe('toLyricLines', () => {
  it('keeps whole milliseconds and the text, and nothing else', () => {
    const lines = toLyricLines([line({ startSeconds: 1.2345, endSeconds: 3.5 })]);

    expect(lines).toEqual([{ startMs: 1235, endMs: 3500, text: 'alpha beta' }]);
  });

  it('has nothing to say about a video with no lines', () => {
    expect(toLyricLines([])).toEqual([]);
  });
});
