import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  isOnReady,
  parseSettings,
  SETTINGS_KEY,
  withSettings,
} from '../src/settings.ts';

describe('the defaults', () => {
  it('is restart, because the quiet surprises people less than the jump', () => {
    expect(DEFAULT_SETTINGS.onReady).toBe('restart');
  });

  it('is the original key, because that is the song as it was recorded', () => {
    expect(DEFAULT_SETTINGS.key).toBe(0);
  });

  it('is one storage key, so a write is never half of a read', () => {
    expect(SETTINGS_KEY).toBe('kara.settings');
  });
});

describe('parseSettings', () => {
  it('reads back what was written', () => {
    expect(parseSettings({ onReady: 'continue', key: 0 })).toEqual({
      onReady: 'continue',
      key: 0,
    });
    expect(parseSettings({ onReady: 'restart', key: -3 })).toEqual({
      onReady: 'restart',
      key: -3,
    });
  });

  it('falls back to the default rather than throwing, whatever is in storage', () => {
    for (const stored of [undefined, null, 42, 'continue', {}, { onReady: 'sideways' }, []]) {
      expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('takes the readable half of a half-readable object', () => {
    expect(parseSettings({ onReady: 'continue', key: 'two' })).toEqual({
      onReady: 'continue',
      key: 0,
    });
    expect(parseSettings({ onReady: 'sideways', key: 2 })).toEqual({
      onReady: 'restart',
      key: 2,
    });
  });

  it('keeps the key inside the range the control offers', () => {
    expect(parseSettings({ key: 99 }).key).toBe(6);
    expect(parseSettings({ key: -99 }).key).toBe(-6);
    expect(parseSettings({ key: 2.6 }).key).toBe(3);
  });

  it('ignores anything else that happens to be alongside it', () => {
    expect(parseSettings({ onReady: 'continue', guide: 0.4 })).toEqual({
      onReady: 'continue',
      key: 0,
    });
  });
});

describe('withSettings', () => {
  it('changes the one field and keeps the rest readable', () => {
    expect(withSettings(DEFAULT_SETTINGS, { onReady: 'continue' })).toEqual({
      onReady: 'continue',
      key: 0,
    });
    expect(withSettings(DEFAULT_SETTINGS, { key: 4 })).toEqual({
      onReady: 'restart',
      key: 4,
    });
    expect(withSettings({ onReady: 'continue', key: 4 }, {})).toEqual({
      onReady: 'continue',
      key: 4,
    });
  });
});

describe('isOnReady', () => {
  it('knows the two choices and nothing else', () => {
    expect(isOnReady('restart')).toBe(true);
    expect(isOnReady('continue')).toBe(true);
    expect(isOnReady('whatever')).toBe(false);
    expect(isOnReady(undefined)).toBe(false);
    expect(isOnReady(1)).toBe(false);
  });
});
