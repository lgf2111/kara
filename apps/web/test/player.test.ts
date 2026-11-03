import { describe, expect, it } from 'vitest';

import { commandForKey } from '../src/player/keys.ts';
import { LIBRARY_HASH, playerHashFor, songIdFromHash } from '../src/player/route.ts';
import { clampVolume, formatClock, seekTo } from '../src/player/time.ts';

describe('formatClock', () => {
  it('reads as a clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5.4)).toBe('0:05');
    expect(formatClock(214.3)).toBe('3:34');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('admits an unknown length rather than calling it nothing', () => {
    expect(formatClock(Number.NaN)).toBe('--:--');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('--:--');
    expect(formatClock(-1)).toBe('--:--');
  });
});

describe('seekTo', () => {
  it('skips by the amount asked for', () => {
    expect(seekTo(30, 5, 200)).toBe(35);
    expect(seekTo(30, -5, 200)).toBe(25);
  });

  it('never goes before the start', () => {
    expect(seekTo(2, -5, 200)).toBe(0);
    expect(seekTo(0, -5, 200)).toBe(0);
  });

  it('never goes past the end', () => {
    expect(seekTo(198, 5, 200)).toBe(200);
  });

  it('leaves the limit to the browser while the length is unknown', () => {
    expect(seekTo(10, 5, Number.NaN)).toBe(15);
    expect(seekTo(10, 5, 0)).toBe(15);
  });

  it('treats a time the element has not reported yet as the start', () => {
    expect(seekTo(Number.NaN, 5, 200)).toBe(5);
  });
});

describe('clampVolume', () => {
  it('stays inside what an element accepts', () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(1.4)).toBe(1);
    expect(clampVolume(-0.2)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(0);
  });
});

describe('commandForKey', () => {
  it('plays and pauses on space', () => {
    expect(commandForKey({ key: ' ' })).toEqual({ kind: 'toggle' });
    expect(commandForKey({ key: 'Spacebar' })).toEqual({ kind: 'toggle' });
    expect(commandForKey({ key: 'k' })).toEqual({ kind: 'toggle' });
  });

  it('skips five seconds with the left and right arrows', () => {
    expect(commandForKey({ key: 'ArrowLeft' })).toEqual({ kind: 'skip', seconds: -5 });
    expect(commandForKey({ key: 'ArrowRight' })).toEqual({ kind: 'skip', seconds: 5 });
  });

  it('changes the volume with the up and down arrows', () => {
    expect(commandForKey({ key: 'ArrowUp' })).toEqual({ kind: 'volume', delta: 0.1 });
    expect(commandForKey({ key: 'ArrowDown' })).toEqual({ kind: 'volume', delta: -0.1 });
  });

  it('mutes and fills the screen', () => {
    expect(commandForKey({ key: 'm' })).toEqual({ kind: 'mute' });
    expect(commandForKey({ key: 'f' })).toEqual({ kind: 'fullscreen' });
  });

  it('ignores anything else', () => {
    expect(commandForKey({ key: 'q' })).toBeNull();
    expect(commandForKey({ key: 'Enter' })).toBeNull();
  });

  it('leaves shortcuts with a modifier to the browser', () => {
    expect(commandForKey({ key: 'f', meta: true })).toBeNull();
    expect(commandForKey({ key: 'ArrowLeft', ctrl: true })).toBeNull();
    expect(commandForKey({ key: ' ', alt: true })).toBeNull();
  });

  it('does not fight a control that answers the key itself', () => {
    expect(commandForKey({ key: ' ', targetTag: 'BUTTON' })).toBeNull();
    expect(commandForKey({ key: 'ArrowRight', targetTag: 'INPUT' })).toBeNull();
    expect(commandForKey({ key: ' ', targetTag: 'SUMMARY' })).toBeNull();
    expect(commandForKey({ key: 'm', editing: true })).toBeNull();
  });

  it('still works for the page itself', () => {
    expect(commandForKey({ key: ' ', targetTag: 'BODY' })).toEqual({ kind: 'toggle' });
    expect(commandForKey({ key: ' ', targetTag: 'VIDEO' })).toEqual({ kind: 'toggle' });
  });
});

describe('the hash route', () => {
  it('names the song it plays', () => {
    expect(playerHashFor('abc123')).toBe('#/play/abc123');
    expect(songIdFromHash(playerHashFor('abc123'))).toBe('abc123');
  });

  it('survives an id that needs escaping', () => {
    expect(songIdFromHash(playerHashFor('a b/c#d'))).toBe('a b/c#d');
  });

  it('reads the library as no song', () => {
    expect(songIdFromHash('')).toBeNull();
    expect(songIdFromHash('#')).toBeNull();
    expect(songIdFromHash(LIBRARY_HASH)).toBeNull();
    expect(songIdFromHash('#/play/')).toBeNull();
    expect(songIdFromHash('#/settings')).toBeNull();
  });

  it('reads a broken escape as no song rather than throwing', () => {
    expect(songIdFromHash('#/play/%')).toBeNull();
  });
});
