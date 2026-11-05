/**
 * What there is to choose, the default, and how to read it back.
 *
 * The key, in semitones, which is a preference about the person rather than a
 * choice between behaviours. `audio/key.ts` holds its range and its words.
 *
 * It is remembered because somebody who sings a tone below the record will
 * want that again tomorrow, and it is only ever written from the popup: the
 * panel's buttons move the song that is playing and leave the default alone,
 * because nudging the key for one song is not a decision about every song
 * after it.
 *
 * Nothing here touches `chrome.storage`: this is the shape, the default and
 * the parse, which is the part worth testing. `settings-store.ts` is the part
 * that talks to Chrome.
 */

import { clampKey, KEY_DEFAULT } from './audio/key.ts';

export interface Settings {
  /**
   * The key a song starts in, in whole semitones. Zero, which is the song as
   * it was recorded.
   */
  readonly key: number;
}

export const DEFAULT_SETTINGS: Settings = { key: KEY_DEFAULT };

/** One storage key, holding one object, so a write is never half a read. */
export const SETTINGS_KEY = 'kara.settings';

/**
 * Settings out of whatever was in storage.
 *
 * Storage is shared with every past and future version of this extension, so
 * what comes back is `unknown` and anything unreadable falls back to the
 * default rather than throwing. A setting nobody can read is not a reason to
 * refuse to start.
 */
export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_SETTINGS;
  }
  const stored = raw as { key?: unknown };
  return { key: clampKey(stored.key) };
}

/** The settings with one field changed, for a write. */
export function withSettings(current: Settings, patch: Partial<Settings>): Settings {
  return parseSettings({ ...current, ...patch });
}
