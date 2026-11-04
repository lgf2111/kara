import { describe, expect, it } from 'vitest';

import { decidePageEvent, shouldReprime, type PageEvent } from '../src/content/page-events.ts';

const EVENTS: readonly PageEvent[] = [
  'seeking',
  'seeked',
  'pause',
  'play',
  'ratechange',
  'ended',
  'ad-start',
  'ad-end',
];

describe('decidePageEvent', () => {
  it('throws the buffer away for everything that moves the timeline', () => {
    expect(decidePageEvent('seeking').reset).toBe('seek');
    expect(decidePageEvent('ratechange').reset).toBe('ratechange');
    expect(decidePageEvent('ended').reset).toBe('ended');
    expect(decidePageEvent('ad-start').reset).toBe('ad');
  });

  /**
   * The row this table was rewritten for. A pause used to reset, which cost
   * the whole delay again — eighteen seconds of silence — for a click on the
   * video, which is how YouTube pauses.
   */
  it('holds on a pause instead of resetting, and resumes on a play', () => {
    expect(decidePageEvent('pause')).toEqual({
      audio: 'hold',
      reset: null,
      picture: 'freeze',
      passthrough: null,
    });
    expect(decidePageEvent('play')).toEqual({
      audio: 'resume',
      reset: null,
      picture: 'thaw',
      passthrough: null,
    });
  });

  it('never asks for a reset without saying why, or a reason without a reset', () => {
    for (const event of EVENTS) {
      const decision = decidePageEvent(event);
      expect(decision.reset === null).toBe(decision.audio !== 'reset');
    }
  });

  it('splits a seek, so a long scrub primes once at the end', () => {
    expect(decidePageEvent('seeking')).toEqual({
      audio: 'reset',
      reset: 'seek',
      picture: 'clear',
      passthrough: null,
    });
    expect(decidePageEvent('seeked')).toEqual({
      audio: 'none',
      reset: null,
      picture: 'reprime',
      passthrough: null,
    });
  });

  it('gives the real video and the real audio back for an ad', () => {
    expect(decidePageEvent('ad-start')).toEqual({
      audio: 'reset',
      reset: 'ad',
      picture: 'clear',
      passthrough: true,
    });
  });

  it('takes them back when the ad is over', () => {
    expect(decidePageEvent('ad-end')).toEqual({
      audio: 'reset',
      reset: 'ad',
      picture: 'reprime',
      passthrough: false,
    });
  });

  it('leaves the picture down at the end of a video', () => {
    expect(decidePageEvent('ended').picture).toBe('clear');
  });

  it('touches passthrough for ads and nothing else', () => {
    for (const event of EVENTS) {
      const touched = decidePageEvent(event).passthrough !== null;
      expect(touched).toBe(event === 'ad-start' || event === 'ad-end');
    }
  });

  it('asks for one of the four things the audio side can do, and no other', () => {
    for (const event of EVENTS) {
      expect(['none', 'reset', 'hold', 'resume']).toContain(decidePageEvent(event).audio);
      expect(['seek', 'ratechange', 'navigation', 'ended', 'ad', null]).toContain(
        decidePageEvent(event).reset,
      );
    }
  });
});

describe('shouldReprime', () => {
  it('puts the picture back when the audio is running and no ad is on', () => {
    expect(shouldReprime({ action: 'reprime', inAd: false, running: true })).toBe(true);
  });

  it('refuses while an ad is playing, however loudly the page says play', () => {
    expect(shouldReprime({ action: 'reprime', inAd: true, running: true })).toBe(false);
  });

  it('refuses when nobody is separating anything', () => {
    expect(shouldReprime({ action: 'reprime', inAd: false, running: false })).toBe(false);
  });

  it('is not an opinion about any other action', () => {
    for (const action of ['none', 'freeze', 'thaw', 'clear'] as const) {
      expect(shouldReprime({ action, inAd: false, running: true })).toBe(false);
    }
  });
});
