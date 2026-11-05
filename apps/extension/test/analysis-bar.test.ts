import { describe, expect, it } from 'vitest';

import { analyzedFraction } from '../src/audio/analysis.ts';

describe('analyzedFraction', () => {
  it('is the ready prefix as a fraction of the song', () => {
    expect(analyzedFraction(30, 120)).toBeCloseTo(0.25);
  });

  it('has nothing to draw before any block, without a length, or when the whole song is ready', () => {
    expect(analyzedFraction(null, 120)).toBeNull();
    expect(analyzedFraction(0, 120)).toBeNull();
    expect(analyzedFraction(30, null)).toBeNull();
    expect(analyzedFraction(30, 0)).toBeNull();
    expect(analyzedFraction(119.9, 120)).toBeNull();
  });

  it('clamps a frontier that arrives past the length', () => {
    expect(analyzedFraction(130, 120)).toBeNull();
  });
});
