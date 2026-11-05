import { describe, expect, it } from 'vitest';

import {
  FADE_SECONDS,
  gainAt,
  heldGain,
  MUTE_SECONDS,
  rampTo,
  shapeAt,
} from '../src/audio/mix-gain.ts';

describe('gainAt', () => {
  it('holds a gain that is not going anywhere', () => {
    const held = heldGain(0.4);

    expect(gainAt(held, 0)).toBe(0.4);
    expect(gainAt(held, 1000)).toBe(0.4);
  });

  it('walks a ramp from one value to the other and stops at each end', () => {
    const ramp = rampTo(heldGain(0), 1, 10, 0.04);

    expect(gainAt(ramp, 9.9)).toBe(0);
    expect(gainAt(ramp, 10)).toBe(0);
    expect(gainAt(ramp, 10.01)).toBeCloseTo(0.25, 9);
    expect(gainAt(ramp, 10.02)).toBeCloseTo(0.5, 9);
    expect(gainAt(ramp, 10.05)).toBe(1);
    expect(gainAt(ramp, 99)).toBe(1);
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

describe('the fade shapes', () => {
  it('is linear for the mode switch, which is one term of one mix', () => {
    expect(shapeAt('linear', 0)).toBe(0);
    expect(shapeAt('linear', 0.25)).toBe(0.25);
    expect(shapeAt('linear', 1)).toBe(1);
  });

  it('is flat at both ends for a mute, so that nothing clicks', () => {
    expect(shapeAt('smooth', 0)).toBe(0);
    expect(shapeAt('smooth', 0.5)).toBeCloseTo(0.5, 9);
    expect(shapeAt('smooth', 1)).toBe(1);
    // The corner a short linear ramp leaves is what a speaker ticks at: this
    // one leaves the ends of the ramp level.
    expect(shapeAt('smooth', 0.02)).toBeLessThan(0.02);
    expect(shapeAt('smooth', 0.98)).toBeGreaterThan(0.98);
  });

  it('reaches both ends exactly, whatever it is handed', () => {
    for (const shape of ['linear', 'smooth'] as const) {
      expect(shapeAt(shape, 0)).toBe(0);
      expect(shapeAt(shape, 1)).toBe(1);
      expect(shapeAt(shape, -3)).toBe(0);
      expect(shapeAt(shape, 9)).toBe(1);
      expect(shapeAt(shape, Number.NaN)).toBe(0);
    }
  });

  it('climbs without ever turning back', () => {
    for (const shape of ['linear', 'smooth'] as const) {
      let last = -1;
      for (let step = 0; step <= 100; step += 1) {
        const at = shapeAt(shape, step / 100);
        expect(at).toBeGreaterThanOrEqual(last);
        last = at;
      }
    }
  });
});

describe('a ramp with a shape', () => {
  it('walks the shape rather than the straight line', () => {
    const ramp = rampTo(heldGain(0), 1, 0, 1, 'smooth');

    expect(gainAt(ramp, 0)).toBe(0);
    expect(gainAt(ramp, 0.5)).toBeCloseTo(0.5, 9);
    expect(gainAt(ramp, 0.1)).toBeLessThan(0.1);
    expect(gainAt(ramp, 1)).toBe(1);
  });

  it('mutes fast enough that a pause feels like one', () => {
    expect(MUTE_SECONDS).toBeLessThanOrEqual(0.03);
  });
});
