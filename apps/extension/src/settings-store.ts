import {
  DEFAULT_SETTINGS,
  parseSettings,
  SETTINGS_KEY,
  withSettings,
  type Settings,
} from './settings.ts';

/**
 * The setting, in `chrome.storage.sync`.
 *
 * Sync rather than local because it is a preference about how the extension
 * should behave, not a fact about this machine, and a person who has decided
 * on the key they sing in has decided that on every machine they sign in to.
 * It is one small object under one key, so the quota is not a consideration
 * and a write is never half of one.
 *
 * Everything in here fails to the default. A storage read that fails, a
 * profile with sync turned off, a value written by a version that thought the
 * key meant something else: none of them are a reason to refuse to start, and
 * all of them end in `restart`, which is the behaviour someone who has never
 * opened the popup gets anyway.
 *
 * Kept apart from `settings.ts` so that the shape, the default and the parse
 * can be tested without a `chrome` to mock.
 */

export async function readSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    return parseSettings(stored[SETTINGS_KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Writes the whole object back, with `patch` applied over what is there. */
export async function writeSettings(patch: Partial<Settings>): Promise<void> {
  const current = await readSettings();
  await chrome.storage.sync.set({ [SETTINGS_KEY]: withSettings(current, patch) });
}

/**
 * Calls back whenever the setting changes anywhere — another window's popup,
 * another machine's sync — so that a running session and every open panel
 * follow it without being told.
 */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'sync' || !Object.hasOwn(changes, SETTINGS_KEY)) {
      return;
    }
    onChange(parseSettings(changes[SETTINGS_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
