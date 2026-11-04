import { describe, expect, it } from 'vitest';

import { chooseDelaySeconds, createCaptureClock } from '../src/audio/capture-clock.ts';

/** A rate that makes the arithmetic readable: a chunk is a tenth of a second. */
const RATE = 1000;
const CHUNK = 100;

describe('createCaptureClock', () => {
  it('knows nothing until a chunk has been stamped', () => {
    const clock = createCaptureClock(RATE);

    expect(clock.anchorTime).toBeNull();
    expect(clock.captureTimeOf(0)).toBeNull();
    expect(clock.playTimeOf(0, 16)).toBeNull();
    expect(clock.samples).toBe(0);
  });

  it('puts every sample on the context clock from the first stamp', () => {
    const clock = createCaptureClock(RATE);

    expect(clock.stamp(5, CHUNK)).toBe(0);
    expect(clock.anchorTime).toBe(5);
    expect(clock.samples).toBe(CHUNK);
    expect(clock.captureTimeOf(0)).toBeCloseTo(5, 9);
    expect(clock.captureTimeOf(CHUNK)).toBeCloseTo(5.1, 9);
    expect(clock.captureTimeOf(RATE)).toBeCloseTo(6, 9);
  });

  it('counts a chunk from where the last one ended, whatever its size', () => {
    const clock = createCaptureClock(RATE);

    expect(clock.stamp(0, 7)).toBe(0);
    expect(clock.stamp(0.007, 13)).toBe(7);
    expect(clock.stamp(0.02, 100)).toBe(20);
    expect(clock.samples).toBe(120);
  });

  it('plays a sample the delay later than it was captured', () => {
    const clock = createCaptureClock(RATE);
    clock.stamp(2, CHUNK);

    expect(clock.playTimeOf(0, 16)).toBeCloseTo(18, 9);
    expect(clock.playTimeOf(RATE, 16)).toBeCloseTo(19, 9);
    // Which is the whole of the mapping step B needs: one subtraction.
    expect((clock.playTimeOf(500, 16) ?? 0) - (clock.captureTimeOf(500) ?? 0)).toBeCloseTo(16, 9);
  });

  it('reports no drift while the stamps and the count agree', () => {
    const clock = createCaptureClock(RATE);
    for (let chunk = 0; chunk < 10; chunk += 1) {
      clock.stamp(chunk * 0.1, CHUNK);
    }

    expect(clock.driftSeconds).toBeCloseTo(0, 9);
  });

  it('reports drift when the audio thread skipped', () => {
    const clock = createCaptureClock(RATE);
    clock.stamp(0, CHUNK);
    // Two chunks of time passed and one chunk of audio arrived.
    clock.stamp(0.2, CHUNK);

    expect(clock.driftSeconds).toBeCloseTo(0.1, 9);
  });

  it('re-anchors on a reset, which is what a seek is', () => {
    const clock = createCaptureClock(RATE);
    clock.stamp(1, CHUNK);
    clock.reset();

    expect(clock.anchorTime).toBeNull();
    expect(clock.samples).toBe(0);
    expect(clock.driftSeconds).toBe(0);

    expect(clock.stamp(40, CHUNK)).toBe(0);
    expect(clock.captureTimeOf(0)).toBeCloseTo(40, 9);
  });

  it('refuses a rate or a chunk that is not a measurement', () => {
    expect(() => createCaptureClock(0)).toThrow(/sample rate/u);
    expect(() => createCaptureClock(Number.NaN)).toThrow(/sample rate/u);

    const clock = createCaptureClock(RATE);
    expect(() => clock.stamp(0, -1)).toThrow(/not a length/u);
    expect(() => clock.stamp(0, 1.5)).toThrow(/not a length/u);
    expect(() => clock.stamp(Number.NaN, CHUNK)).toThrow(/no time on it/u);
  });
});

describe('chooseDelaySeconds', () => {
  it('adds headroom to the measured lag and rounds up to a half second', () => {
    // The default window and hop are 13.65 s of structural lag.
    expect(chooseDelaySeconds(13650)).toBe(15.5);
    // Which becomes about sixteen once a window costs something to compute.
    expect(chooseDelaySeconds(15950)).toBe(17.5);
  });

  it('lands on the same delay for lags that differ by a little', () => {
    expect(chooseDelaySeconds(15700)).toBe(chooseDelaySeconds(15950));
  });

  it('takes the headroom as an argument, and none as none', () => {
    expect(chooseDelaySeconds(2000, 0)).toBe(2);
    expect(chooseDelaySeconds(2100, 0)).toBe(2.5);
  });

  it('treats a lag it cannot read as no lag at all', () => {
    expect(chooseDelaySeconds(Number.NaN)).toBe(1.5);
    expect(chooseDelaySeconds(-100)).toBe(1.5);
  });
});
