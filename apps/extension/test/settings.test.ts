import { describe, expect, it } from 'vitest';

import { KEY_MAX, KEY_MIN } from '../src/audio/key.ts';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  SETTINGS_KEY,
  withSettings,
} from '../src/settings.ts';

describe('the defaults', () => {
  it('is the original key, because that is the song as it was recorded', () => {
    expect(DEFAULT_SETTINGS.key).toBe(0);
  });

  it('is one storage key, so a write is never half of a read', () => {
    expect(SETTINGS_KEY).toBe('kara.settings');
  });
});

describe('parseSettings', () => {
  it('reads back what was written', () => {
    expect(parseSettings({ key: 0 })).toEqual({ key: 0 });
    expect(parseSettings({ key: -3 })).toEqual({ key: -3 });
  });

  it('falls back to the default rather than throwing, whatever is in storage', () => {
    for (const stored of [undefined, null, 42, 'continue', {}, [], { key: 'two' }]) {
      expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps the key inside the range the control offers', () => {
    expect(parseSettings({ key: 99 }).key).toBe(KEY_MAX);
    expect(parseSettings({ key: -99 }).key).toBe(KEY_MIN);
    expect(parseSettings({ key: 2.6 }).key).toBe(3);
  });

  it('ignores anything else that happens to be alongside it', () => {
    expect(parseSettings({ key: 2, guide: 0.4, onReady: 'continue' })).toEqual({ key: 2 });
  });
});

describe('withSettings', () => {
  it('changes the one field and keeps the rest readable', () => {
    expect(withSettings(DEFAULT_SETTINGS, { key: 4 })).toEqual({ key: 4 });
    expect(withSettings({ key: 4 }, {})).toEqual({ key: 4 });
  });
});
