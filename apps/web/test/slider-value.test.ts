import { describe, expect, it } from 'vitest';

import { sliderNumber } from '../src/lib/slider-value.ts';

describe('sliderNumber', () => {
  it('takes the one number a single-thumb slider reports', () => {
    expect(sliderNumber(0.35)).toBe(0.35);
    expect(sliderNumber([42])).toBe(42);
  });

  it('takes the first thumb of a range', () => {
    expect(sliderNumber([3, 9])).toBe(3);
  });

  it('never lets a reading that is not a number reach a media element', () => {
    // A seek to NaN leaves the song nowhere, which is worse than not seeking.
    expect(sliderNumber(Number.NaN)).toBe(0);
    expect(sliderNumber([Number.POSITIVE_INFINITY])).toBe(0);
    expect(sliderNumber([])).toBe(0);
  });

  it('falls back to what the caller asked for', () => {
    expect(sliderNumber([], 1)).toBe(1);
    expect(sliderNumber(Number.NaN, 0.5)).toBe(0.5);
  });
});
