import { describe, expect, it } from 'vitest';

import { shouldMuteVideo } from '../src/content/video-mute.ts';

const PLAYING = {
  mode: 'instrumental' as const,
  status: 'ready' as const,
  covered: true,
  playing: true,
  inAd: false,
  rate: 1,
};

describe('shouldMuteVideo', () => {
  it('mutes the video exactly while the stems are the sound being heard', () => {
    expect(shouldMuteVideo(PLAYING)).toBe(true);
  });

  it('counts a paused session as live, because a resume follows before the report does', () => {
    // The page can be playing again a tick before the status catches up. In
    // that tick the stems are audible, so the video's own sound must already
    // be out of the way; nothing is muted while the video is actually paused.
    expect(shouldMuteVideo({ ...PLAYING, status: 'paused' })).toBe(true);
    expect(shouldMuteVideo({ ...PLAYING, status: 'paused', playing: false })).toBe(false);
  });

  it('leaves the video alone in original mode, which is the toggle at rest', () => {
    expect(shouldMuteVideo({ ...PLAYING, mode: 'original' })).toBe(false);
  });

  it('leaves it alone while it is not moving', () => {
    expect(shouldMuteVideo({ ...PLAYING, playing: false })).toBe(false);
  });

  it('leaves it alone through an ad, whose own sound is the honest one', () => {
    expect(shouldMuteVideo({ ...PLAYING, inAd: true })).toBe(false);
  });

  it.each([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])(
    'keeps the video muted at %s× once the stems cover the playhead',
    (rate) => {
      expect(shouldMuteVideo({ ...PLAYING, rate })).toBe(true);
    },
  );

  it('leaves it alone at a speed the stems cannot follow', () => {
    expect(shouldMuteVideo({ ...PLAYING, rate: 0 })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, rate: 0.1 })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, rate: 3 })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, rate: Number.NaN })).toBe(false);
  });

  it('becomes live while preparing, but only once the stems reach the playhead', () => {
    expect(shouldMuteVideo({ ...PLAYING, covered: false })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, status: 'preparing' })).toBe(true);
    expect(shouldMuteVideo({ ...PLAYING, status: 'preparing', covered: false })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, status: 'idle' })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, status: null })).toBe(false);
    expect(shouldMuteVideo({ ...PLAYING, status: 'error' })).toBe(false);
  });
});
