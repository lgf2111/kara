import { describe, expect, it } from 'vitest';

import {
  CROSSFADE_SECONDS,
  CURVE_POINTS,
  crossfadeGains,
  crossfadeOutCurve,
  FADE_IN_SECONDS,
  FADE_SECONDS,
  gainAt,
  guideLevel,
  heldGain,
  MUTE_SECONDS,
  rampDone,
  rampTo,
  shapeAt,
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
    for (const shape of ['linear', 'smooth', 'power-in', 'power-out'] as const) {
      expect(shapeAt(shape, 0)).toBe(0);
      expect(shapeAt(shape, 1)).toBe(1);
      expect(shapeAt(shape, -3)).toBe(0);
      expect(shapeAt(shape, 9)).toBe(1);
      expect(shapeAt(shape, Number.NaN)).toBe(0);
    }
  });

  it('climbs without ever turning back', () => {
    for (const shape of ['linear', 'smooth', 'power-in', 'power-out'] as const) {
      let last = -1;
      for (let step = 0; step <= 100; step += 1) {
        const at = shapeAt(shape, step / 100);
        expect(at).toBeGreaterThanOrEqual(last);
        last = at;
      }
    }
  });
});

describe('crossfadeGains', () => {
  /**
   * The reason this is not two linear ramps. Two uncorrelated signals passing
   * each other linearly are both at a half in the middle, which is three
   * decibels down on either of them alone, and that dip is audible as a hole.
   */
  it('keeps the two at equal power all the way across', () => {
    for (let step = 0; step <= 20; step += 1) {
      const { arriving, leaving } = crossfadeGains(step / 20);
      expect(arriving * arriving + leaving * leaving).toBeCloseTo(1, 9);
    }
  });

  it('hands over completely at each end', () => {
    expect(crossfadeGains(0)).toEqual({ arriving: 0, leaving: 1 });
    const end = crossfadeGains(1);
    expect(end.arriving).toBeCloseTo(1, 9);
    expect(end.leaving).toBeCloseTo(0, 9);
  });

  it('is the same curve the worklet ramps up on, read from the other end', () => {
    for (const progress of [0, 0.3, 0.5, 0.7, 1]) {
      expect(crossfadeGains(progress).arriving).toBeCloseTo(shapeAt('power-in', progress), 9);
      expect(1 - crossfadeGains(progress).leaving).toBeCloseTo(
        shapeAt('power-out', progress),
        9,
      );
    }
  });
});

describe('crossfadeOutCurve', () => {
  it('leaves the tab audio at silence, which is where it has to end', () => {
    const curve = crossfadeOutCurve();

    expect(curve.length).toBe(CURVE_POINTS);
    expect(curve[0]).toBe(1);
    expect(curve[curve.length - 1]).toBeCloseTo(0, 6);
  });

  it('only ever goes down', () => {
    const curve = crossfadeOutCurve(33);

    expect(curve.length).toBe(33);
    for (let index = 1; index < curve.length; index += 1) {
      expect(curve[index]).toBeLessThan(curve[index - 1] ?? 2);
    }
  });

  it('is dense enough to be smooth, and refuses to be a single point', () => {
    expect(CURVE_POINTS).toBeGreaterThan(64);
    expect(crossfadeOutCurve(1).length).toBe(2);
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

  it('can be armed for a moment that has not come yet, which is the fade in', () => {
    // The master gain is told at the first block to come up at the epoch,
    // which is a second and a half later.
    const ramp = rampTo(heldGain(0), 1, 100, FADE_IN_SECONDS, 'smooth');

    expect(gainAt(ramp, 99)).toBe(0);
    expect(gainAt(ramp, 100)).toBe(0);
    expect(gainAt(ramp, 100 + FADE_IN_SECONDS / 2)).toBeCloseTo(0.5, 9);
    expect(gainAt(ramp, 100 + FADE_IN_SECONDS)).toBe(1);
  });

  it('fades in and crosses over slowly enough to be a fade, not a cut', () => {
    expect(FADE_IN_SECONDS).toBeGreaterThanOrEqual(0.6);
    expect(FADE_IN_SECONDS).toBeLessThanOrEqual(0.8);
    expect(CROSSFADE_SECONDS).toBeCloseTo(0.8, 9);
    // And mutes fast enough that a pause feels like one.
    expect(MUTE_SECONDS).toBeLessThanOrEqual(0.03);
  });
});
