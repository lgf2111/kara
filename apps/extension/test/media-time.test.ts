import { describe, expect, it } from 'vitest';

import {
  anchorHeadFrame,
  headMediaFrame,
  projectMediaSeconds,
  tidySample,
  type MediaSample,
} from '../src/audio/media-time.ts';

const SAMPLE: MediaSample = {
  wallMs: 1000,
  mediaSeconds: 30,
  playing: true,
  rate: 1,
  inAd: false,
};

describe('projectMediaSeconds', () => {
  it('moves the position on by however long ago the report was taken', () => {
    expect(projectMediaSeconds(SAMPLE, 1250)).toBeCloseTo(30.25);
  });

  it('multiplies by the rate the page is playing at', () => {
    expect(projectMediaSeconds({ ...SAMPLE, rate: 2 }, 1500)).toBeCloseTo(31);
  });

  it.each([
    [0.5, 30.125],
    [0.75, 30.1875],
    [1.25, 30.3125],
    [1.5, 30.375],
  ])('projecting at %s× moves by that rate', (rate, expected) => {
    expect(projectMediaSeconds({ ...SAMPLE, rate }, 1250)).toBeCloseTo(expected);
  });

  it('does not move a paused page', () => {
    expect(projectMediaSeconds({ ...SAMPLE, playing: false }, 9000)).toBe(30);
  });

  it('treats a report from the future as due now rather than rewinding', () => {
    expect(projectMediaSeconds(SAMPLE, 500)).toBe(30);
  });

  it('never answers with a negative position', () => {
    expect(projectMediaSeconds({ ...SAMPLE, mediaSeconds: 0 }, 1000)).toBe(0);
  });
});

describe('the player anchor', () => {
  const RATE = 44_100;
  const LATENCY = 5_292;

  it('reads the shifter latency ahead of the video at one rate', () => {
    expect(anchorHeadFrame(10, 1, LATENCY, RATE)).toBe(10 * RATE + LATENCY);
  });

  it('scales the read-ahead with the rate, because the head advances in source frames', () => {
    expect(anchorHeadFrame(10, 1.5, LATENCY, RATE)).toBe(10 * RATE + 1.5 * LATENCY);
    expect(anchorHeadFrame(10, 0.5, LATENCY, RATE)).toBe(10 * RATE + 0.5 * LATENCY);
  });

  it('reports the video frame the head implies, not the head itself', () => {
    const head = anchorHeadFrame(10, 2, LATENCY, RATE);
    expect(headMediaFrame(head, 2, LATENCY)).toBe(10 * RATE);
  });

  it('round-trips every rate the player follows', () => {
    for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      const head = anchorHeadFrame(42.5, rate, LATENCY, RATE);
      expect(headMediaFrame(head, rate, LATENCY)).toBeCloseTo(42.5 * RATE);
    }
  });

  it('treats a missing rate or latency as the safe one', () => {
    expect(anchorHeadFrame(1, Number.NaN, Number.NaN, RATE)).toBe(RATE);
    expect(headMediaFrame(RATE, Number.NaN, Number.NaN)).toBe(RATE);
  });
});

describe('tidySample', () => {
  it('makes every field something arithmetic can be done on', () => {
    const tidy = tidySample({
      wallMs: Number.NaN,
      mediaSeconds: -4,
      playing: true,
      rate: Number.NaN,
      inAd: undefined as unknown as boolean,
    });

    expect(tidy.wallMs).toBe(0);
    expect(tidy.mediaSeconds).toBe(0);
    expect(tidy.rate).toBe(1);
    expect(tidy.inAd).toBe(false);
  });
});
