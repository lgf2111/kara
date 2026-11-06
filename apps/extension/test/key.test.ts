import { describe, expect, it } from 'vitest';

import {
  canNudge,
  clampKey,
  KEY_DEFAULT,
  KEY_MAX,
  KEY_MIN,
  keyLabel,
  keyRoute,
  nudgeKey,
} from '../src/audio/key.ts';

describe('the range', () => {
  it('is six semitones either way, in whole steps', () => {
    expect(KEY_MIN).toBe(-6);
    expect(KEY_MAX).toBe(6);
  });

  it('starts at the original key', () => {
    expect(KEY_DEFAULT).toBe(0);
  });
});

describe('clampKey', () => {
  it('reads back a key that was stored', () => {
    expect(clampKey(0)).toBe(0);
    expect(clampKey(4)).toBe(4);
    expect(clampKey(-6)).toBe(-6);
  });

  it('comes back to the original key rather than throwing, whatever it is handed', () => {
    for (const stored of [undefined, null, 'two', Number.NaN, {}, []]) {
      expect(clampKey(stored)).toBe(KEY_DEFAULT);
    }
  });

  it('stays inside the range and on whole steps', () => {
    expect(clampKey(40)).toBe(KEY_MAX);
    expect(clampKey(-40)).toBe(KEY_MIN);
    expect(clampKey(2.4)).toBe(2);
    expect(clampKey(-2.6)).toBe(-3);
  });
});

describe('keyRoute', () => {
  it('bypasses the shifter and its delay at the original key', () => {
    expect(keyRoute(0, 5292)).toEqual({ bypass: true, latencySamples: 0 });
    expect(keyRoute(Number.NaN, 5292)).toEqual({ bypass: true, latencySamples: 0 });
  });

  it('inserts the shifter at any other key, with its reported delay', () => {
    expect(keyRoute(1, 5292)).toEqual({ bypass: false, latencySamples: 5292 });
    expect(keyRoute(-6, 5292)).toEqual({ bypass: false, latencySamples: 5292 });
  });

  it('keeps the latency a whole number of frames, and never negative', () => {
    expect(keyRoute(3, 5291.6).latencySamples).toBe(5292);
    expect(keyRoute(3, -10).latencySamples).toBe(0);
    expect(keyRoute(3, Number.NaN).latencySamples).toBe(0);
  });
});

describe('nudgeKey', () => {
  it('moves a step at a time', () => {
    expect(nudgeKey(0, 1)).toBe(1);
    expect(nudgeKey(0, -1)).toBe(-1);
    expect(nudgeKey(-1, 1)).toBe(0);
  });

  it('stops at the ends rather than wrapping or overshooting', () => {
    expect(nudgeKey(KEY_MAX, 1)).toBe(KEY_MAX);
    expect(nudgeKey(KEY_MIN, -1)).toBe(KEY_MIN);
    expect(canNudge(KEY_MAX, 1)).toBe(false);
    expect(canNudge(KEY_MAX, -1)).toBe(true);
    expect(canNudge(KEY_MIN, -1)).toBe(false);
    expect(canNudge(0, 1)).toBe(true);
  });

  it('starts from a sane value even when it is handed a mad one', () => {
    expect(nudgeKey(Number.NaN, 1)).toBe(1);
    expect(nudgeKey(99, -1)).toBe(KEY_MAX - 1);
  });
});

describe('keyLabel', () => {
  /**
   * `Original key` rather than `Key 0`, because zero is not a key somebody
   * chose: it is the song as it was recorded, and a person who has left the
   * key somewhere needs to be able to see that they have.
   */
  it('says the song is as it was recorded when nothing has moved', () => {
    expect(keyLabel(0)).toBe('Original key');
    expect(keyLabel(Number.NaN)).toBe('Original key');
  });

  it('signs the key both ways', () => {
    expect(keyLabel(2)).toBe('Key +2');
    expect(keyLabel(6)).toBe('Key +6');
    expect(keyLabel(-3)).toBe('Key −3');
  });

  it('says something for every key the control can reach', () => {
    for (let key = KEY_MIN; key <= KEY_MAX; key += 1) {
      expect(keyLabel(key)).toMatch(/\w/u);
    }
  });
});
