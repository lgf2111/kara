import { describe, expect, it } from 'vitest';

import {
  FADE_SECONDS,
  gainAt,
  guideLevel,
  heldGain,
  rampDone,
  rampTo,
  vocalGainFor,
} from '../src/audio/mix-gain.ts';

describe('vocalGainFor', () => {
  it('adds the stems back up for the original, whatever the guide says', () => {
    expect(vocalGainFor('original', 0)).toBe(1);
    expect(vocalGainFor('original', 0.3)).toBe(1);
  });

  it('is the guide level for the instrumental', () => {
    expect(vocalGainFor('instrumental', 0)).toBe(0);
    expect(vocalGainFor('instrumental', 0.25)).toBe(0.25);
  });

  it('keeps the guide where adding it cannot clip', () => {
    expect(guideLevel(-1)).toBe(0);
    expect(guideLevel(4)).toBe(1);
    expect(guideLevel(Number.NaN)).toBe(0);
  });
});

describe('gainAt', () => {
  it('holds a gain that is not going anywhere', () => {
    const held = heldGain(0.4);

    expect(gainAt(held, 0)).toBe(0.4);
    expect(gainAt(held, 1000)).toBe(0.4);
    expect(rampDone(held, 0)).toBe(true);
  });

  it('walks a ramp from one value to the other and stops at each end', () => {
    const ramp = rampTo(heldGain(0), 1, 10, 0.04);

    expect(gainAt(ramp, 9.9)).toBe(0);
    expect(gainAt(ramp, 10)).toBe(0);
    expect(gainAt(ramp, 10.01)).toBeCloseTo(0.25, 9);
    expect(gainAt(ramp, 10.02)).toBeCloseTo(0.5, 9);
    expect(gainAt(ramp, 10.05)).toBe(1);
    expect(gainAt(ramp, 99)).toBe(1);
    expect(rampDone(ramp, 10.02)).toBe(false);
    expect(rampDone(ramp, 10.05)).toBe(true);
  });
});

describe('rampTo', () => {
  it('starts from where an unfinished ramp had reached, so nothing clicks', () => {
    const first = rampTo(heldGain(0), 1, 0, 0.04);
    // Switched back when the fade was a quarter of the way across.
    const second = rampTo(first, 0, 0.01, 0.04);

    expect(second.from).toBeCloseTo(0.25, 9);
    expect(gainAt(second, 0.01)).toBeCloseTo(0.25, 9);
    expect(gainAt(second, 0.06)).toBe(0);
  });

  it('holds rather than fades when the target is already the value', () => {
    const ramp = rampTo(heldGain(0.5), 0.5, 3);

    expect(ramp.seconds).toBe(0);
    expect(gainAt(ramp, 3)).toBe(0.5);
  });

  it('jumps when asked for no fade at all', () => {
    const ramp = rampTo(heldGain(0), 1, 5, 0);

    expect(gainAt(ramp, 5)).toBe(1);
  });

  it('fades over a span short enough to feel instant', () => {
    expect(FADE_SECONDS).toBeLessThanOrEqual(0.05);
    expect(rampTo(heldGain(0), 1, 0).seconds).toBe(FADE_SECONDS);
  });
});
