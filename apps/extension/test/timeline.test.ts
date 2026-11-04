import { describe, expect, it } from 'vitest';

import {
  expectedMediaSeconds,
  isRealSeek,
  SEEK_THRESHOLD_SECONDS,
  type TimelinePoint,
} from '../src/content/timeline.ts';

function at(mediaSeconds: number, wallMs: number, rest: Partial<TimelinePoint> = {}): TimelinePoint {
  return { mediaSeconds, wallMs, rate: 1, paused: false, ...rest };
}

describe('expectedMediaSeconds', () => {
  it('advances a playing video by the wall time that went by', () => {
    expect(expectedMediaSeconds(at(30, 1000), 2000)).toBeCloseTo(31, 9);
    expect(expectedMediaSeconds(at(30, 1000, { rate: 2 }), 2000)).toBeCloseTo(32, 9);
  });

  it('leaves a paused video where it was left', () => {
    expect(expectedMediaSeconds(at(30, 1000, { paused: true }), 9000)).toBe(30);
  });
});

describe('isRealSeek', () => {
  it('is no for a video that is simply playing', () => {
    expect(isRealSeek(at(30, 1000), at(30.5, 1500))).toBe(false);
    expect(isRealSeek(at(30, 1000), at(31, 2000))).toBe(false);
  });

  it('is yes for a jump, forwards or back', () => {
    expect(isRealSeek(at(30, 1000), at(95, 1050))).toBe(true);
    expect(isRealSeek(at(95, 1000), at(30, 1050))).toBe(true);
  });

  it('is yes for a scrub on a paused video', () => {
    expect(isRealSeek(at(30, 1000, { paused: true }), at(42, 1100, { paused: true }))).toBe(true);
  });

  /**
   * This is the row the whole file exists for. A `seeking` event arrives for
   * buffering, for a quality change and for adopting a new source, and acting
   * on those costs the person the entire delay for nothing.
   */
  it('is no for the stall that fires a seeking event and moves nothing', () => {
    expect(isRealSeek(at(30, 1000), at(30, 1400))).toBe(false);
    expect(isRealSeek(at(30, 1000), at(30.2, 1800))).toBe(false);
  });

  it('is no when there is nothing to compare against', () => {
    expect(isRealSeek(null, at(30, 1000))).toBe(false);
  });

  it('takes the threshold as an argument, and judges on the far side of it', () => {
    const before = at(30, 1000);
    const after = at(31, 1000);

    expect(isRealSeek(before, after, 1.5)).toBe(false);
    expect(isRealSeek(before, after, 0.5)).toBe(true);
  });

  it('sits between a sample of playing and one press of an arrow key', () => {
    expect(SEEK_THRESHOLD_SECONDS).toBeGreaterThan(0.5);
    expect(SEEK_THRESHOLD_SECONDS).toBeLessThan(5);
  });

  it('survives a reading nobody can make sense of', () => {
    expect(isRealSeek(at(Number.NaN, 1000), at(30, 1100))).toBe(true);
    expect(isRealSeek(at(30, 1000), at(Number.NaN, 1100))).toBe(false);
  });
});
