/**
 * The one thing there is to choose, its default, and how to read it back.
 *
 * There is no way to make the first eighteen seconds free. The separator
 * cannot be live and ahead of itself at the same time, so something has to
 * give at the moment the delayed audio finally arrives, and which thing gives
 * is a matter of taste rather than of correctness:
 *
 * - **`restart`** keeps quiet while it gets ready and then starts the song
 *   from where the person pressed the button, fading in. The picture has been
 *   held at that same moment all along, so nothing jumps: the price is
 *   eighteen seconds of a dimmed still frame and no sound.
 * - **`continue`** lets the tab's own audio and the real video play through
 *   undelayed while it gets ready, and then crosses over. Nothing is quiet,
 *   but the moment it crosses, the song jumps back by the delay — which is the
 *   same eighteen seconds, taken later and out of the middle.
 *
 * `restart` is the default because the jump surprises people and the quiet
 * does not, and because a person who has just pressed a karaoke button is
 * expecting to wait for the song to start.
 *
 * Nothing here touches `chrome.storage`: this is the shape, the default and
 * the parse, which is the part worth testing. `settings-store.ts` is the part
 * that talks to Chrome.
 */

export type OnReady = 'restart' | 'continue';

export interface Settings {
  readonly onReady: OnReady;
}

export const DEFAULT_SETTINGS: Settings = { onReady: 'restart' };

/** One key, holding one object, so a write is never a partial read away. */
export const SETTINGS_KEY = 'kara.settings';

const ON_READY: Readonly<Record<OnReady, true>> = { restart: true, continue: true };

export function isOnReady(value: unknown): value is OnReady {
  return typeof value === 'string' && Object.hasOwn(ON_READY, value);
}

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
  const asked = (raw as { onReady?: unknown }).onReady;
  return isOnReady(asked) ? { onReady: asked } : DEFAULT_SETTINGS;
}

/** The settings with one field changed, for a write. */
export function withSettings(current: Settings, patch: Partial<Settings>): Settings {
  return parseSettings({ ...current, ...patch });
}
