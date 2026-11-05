import { describe, expect, it } from 'vitest';

import { projectMediaSeconds, tidySample, type MediaSample } from '../src/audio/media-time.ts';

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
