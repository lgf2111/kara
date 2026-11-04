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
    expect(decidePageEvent('pause').reset).toBe('pause');
    expect(decidePageEvent('play').reset).toBe('play');
    expect(decidePageEvent('ratechange').reset).toBe('ratechange');
  });

  it('splits a seek, so a long scrub primes once at the end', () => {
    expect(decidePageEvent('seeking')).toEqual({
      reset: 'seek',
      picture: 'clear',
      passthrough: null,
    });
    expect(decidePageEvent('seeked')).toEqual({
      reset: null,
      picture: 'reprime',
      passthrough: null,
    });
  });

  it('freezes on a pause rather than clearing, because nothing has moved', () => {
    expect(decidePageEvent('pause').picture).toBe('freeze');
    expect(decidePageEvent('play').picture).toBe('reprime');
  });

  it('gives the real video and the real audio back for an ad', () => {
    expect(decidePageEvent('ad-start')).toEqual({
      reset: 'seek',
      picture: 'clear',
      passthrough: true,
    });
  });

  it('takes them back when the ad is over', () => {
    expect(decidePageEvent('ad-end')).toEqual({
      reset: 'seek',
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

  it('asks for a reset or says nothing, never anything else', () => {
    for (const event of EVENTS) {
      const decision = decidePageEvent(event);
      expect(['seek', 'pause', 'play', 'ratechange', null]).toContain(decision.reset);
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
    for (const action of ['none', 'freeze', 'clear'] as const) {
      expect(shouldReprime({ action, inAd: false, running: true })).toBe(false);
    }
  });
});
