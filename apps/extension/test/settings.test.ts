import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  isOnReady,
  parseSettings,
  SETTINGS_KEY,
  withSettings,
} from '../src/settings.ts';

describe('the default', () => {
  it('is restart, because the quiet surprises people less than the jump', () => {
    expect(DEFAULT_SETTINGS).toEqual({ onReady: 'restart' });
  });

  it('is one key, so a write is never half of a read', () => {
    expect(SETTINGS_KEY).toBe('kara.settings');
  });
});

describe('parseSettings', () => {
  it('reads back what was written', () => {
    expect(parseSettings({ onReady: 'continue' })).toEqual({ onReady: 'continue' });
    expect(parseSettings({ onReady: 'restart' })).toEqual({ onReady: 'restart' });
  });

  it('falls back to the default rather than throwing, whatever is in storage', () => {
    for (const stored of [undefined, null, 42, 'continue', {}, { onReady: 'sideways' }, []]) {
      expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('ignores anything else that happens to be alongside it', () => {
    expect(parseSettings({ onReady: 'continue', guide: 0.4 })).toEqual({ onReady: 'continue' });
  });
});

describe('withSettings', () => {
  it('changes the one field and keeps the rest readable', () => {
    expect(withSettings(DEFAULT_SETTINGS, { onReady: 'continue' })).toEqual({
      onReady: 'continue',
    });
    expect(withSettings({ onReady: 'continue' }, {})).toEqual({ onReady: 'continue' });
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
