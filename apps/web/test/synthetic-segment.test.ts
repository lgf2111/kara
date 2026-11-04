import { describe, expect, it } from 'vitest';

import { mulberry32, syntheticChannel } from '../src/diagnostics/synthetic-segment.ts';

describe('mulberry32', () => {
  it('gives the same sequence for the same seed', () => {
    const first = mulberry32(42);
    const second = mulberry32(42);

    expect(Array.from({ length: 8 }, () => first())).toEqual(
      Array.from({ length: 8 }, () => second()),
    );
  });

  it('gives a different sequence for a different seed', () => {
    const first = mulberry32(42);
    const second = mulberry32(43);

    expect(first()).not.toBe(second());
  });

  it('stays inside the unit interval', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 2000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('syntheticChannel', () => {
  it('is identical between calls, which is the point of it', () => {
    expect([...syntheticChannel(64, 1337, 1)]).toEqual([...syntheticChannel(64, 1337, 1)]);
  });

  it('is silence when asked for silence', () => {
    expect([...syntheticChannel(64, 1337, 1, 'silent')].every((value) => value === 0)).toBe(true);
  });

  it('ignores the seed when there is no noise to seed', () => {
    expect([...syntheticChannel(64, 1, 1, 'tonal')]).toEqual([...syntheticChannel(64, 999, 1, 'tonal')]);
  });

  it('uses the seed when there is noise', () => {
    expect([...syntheticChannel(64, 1, 1, 'mixed')]).not.toEqual([
      ...syntheticChannel(64, 999, 1, 'mixed'),
    ]);
  });

  it('scales by the gain and stays inside full scale', () => {
    const loud = syntheticChannel(4096, 5, 1);
    const quiet = syntheticChannel(4096, 5, 0.25);

    for (let i = 0; i < loud.length; i += 1) {
      expect(Math.abs(loud[i] ?? 0)).toBeLessThanOrEqual(1);
      expect(quiet[i] ?? 0).toBeCloseTo((loud[i] ?? 0) * 0.25, 6);
    }
  });
});
